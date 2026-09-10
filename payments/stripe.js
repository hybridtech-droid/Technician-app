// Stripe integration — hosted Checkout in subscription mode.
//
// Talks to Stripe's REST API directly with fetch rather than pulling in
// the `stripe` npm package — one less dependency, and Stripe's API is
// plain enough (form-encoded POSTs, a documented manual webhook-signature
// algorithm) that it doesn't need the SDK's convenience wrapper here.
//
// Priced in USD rather than NGN — Stripe has no direct Naira settlement
// route for a Nigeria-based business, so this path is really "pay by
// international card in USD", offered alongside the NGN-native Paystack/
// Flutterwave options rather than instead of them. See payments/config.js.
//
// Docs referenced: https://docs.stripe.com/api/checkout/sessions/create,
// https://docs.stripe.com/api/prices/create, https://docs.stripe.com/webhooks
const crypto = require('crypto');
const db = require('../db');

const PROVIDER = 'stripe';
const API_BASE = 'https://api.stripe.com/v1';

function secretKey() {
  return process.env.STRIPE_SECRET_KEY || '';
}

function webhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || '';
}

function configured() {
  return Boolean(secretKey());
}

// Stripe's API takes classic x-www-form-urlencoded bodies, including for
// nested objects/arrays (line_items[0][price]=..., metadata[companyId]=...).
// This flattens a plain JS object into that form.
function toFormBody(obj, prefix) {
  let pairs = [];
  Object.keys(obj).forEach(function (key) {
    let value = obj[key];
    let formKey = prefix ? prefix + '[' + key + ']' : key;
    if (value === undefined || value === null) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function (item, i) {
        if (item && typeof item === 'object') {
          pairs = pairs.concat(toFormBody(item, formKey + '[' + i + ']'));
        } else {
          pairs.push([formKey + '[' + i + ']', String(item)]);
        }
      });
    } else if (typeof value === 'object') {
      pairs = pairs.concat(toFormBody(value, formKey));
    } else {
      pairs.push([formKey, String(value)]);
    }
  });
  return pairs;
}

async function stripeRequest(method, urlPath, body) {
  let init = {
    method: method,
    headers: {
      Authorization: 'Bearer ' + secretKey(),
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };
  if (body) {
    let params = new URLSearchParams();
    toFormBody(body).forEach(function (pair) { params.append(pair[0], pair[1]); });
    init.body = params.toString();
  }
  let res = await fetch(API_BASE + urlPath, init);
  let data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    throw new Error('Stripe API error: ' + (data.error && data.error.message || res.status));
  }
  return data;
}

async function ensurePrice(planTier, billingCycle, amount, planLabel) {
  let cached = db.prepare(
    'SELECT externalId FROM providerPlanCache WHERE provider = ? AND planTier = ? AND billingCycle = ?'
  ).get(PROVIDER, planTier, billingCycle);
  if (cached) {
    return cached.externalId;
  }

  let interval = billingCycle === 'annual' ? 'year' : 'month';
  let price = await stripeRequest('POST', '/prices', {
    currency: 'usd',
    unit_amount: amount,
    recurring: { interval: interval },
    product_data: { name: 'Tervexa ' + planLabel + ' (' + interval + 'ly)' }
  });

  db.prepare(
    'INSERT INTO providerPlanCache (provider, planTier, billingCycle, externalId, createdAt) VALUES (?, ?, ?, ?, ?)'
  ).run(PROVIDER, planTier, billingCycle, price.id, new Date().toISOString());

  return price.id;
}

async function createCheckoutSession(opts) {
  let priceId = await ensurePrice(opts.planTier, opts.billingCycle, opts.amount, opts.planLabel);

  let session = await stripeRequest('POST', '/checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    customer_email: opts.adminEmail,
    client_reference_id: opts.reference,
    metadata: {
      companyId: opts.company.id,
      planTier: opts.planTier,
      billingCycle: opts.billingCycle
    },
    subscription_data: {
      metadata: {
        companyId: opts.company.id,
        planTier: opts.planTier,
        billingCycle: opts.billingCycle
      }
    }
  });

  return { url: session.url };
}

// Stripe's own webhooks doc ("Verify manually") — HMAC-SHA256 over
// "<timestamp>.<raw body>" using the endpoint's signing secret, compared
// against the v1= value in the Stripe-Signature header. A 5-minute
// timestamp tolerance guards against replayed requests.
function verifySignature(req) {
  if (!req.rawBody) {
    return false;
  }
  let header = req.headers['stripe-signature'] || '';
  let parts = {};
  header.split(',').forEach(function (part) {
    let [key, value] = part.split('=');
    if (key === 'v1') {
      parts.v1 = parts.v1 || [];
      parts.v1.push(value);
    } else if (key === 't') {
      parts.t = value;
    }
  });
  if (!parts.t || !parts.v1 || !parts.v1.length) {
    return false;
  }

  let ageSeconds = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (ageSeconds > 300) {
    return false;
  }

  let signedPayload = parts.t + '.' + req.rawBody.toString('utf8');
  let expected = crypto.createHmac('sha256', webhookSecret()).update(signedPayload).digest('hex');

  return parts.v1.some(function (given) {
    try {
      return expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
    } catch (err) {
      return false;
    }
  });
}

function parseWebhookEvent(body) {
  let type = body.type;
  let obj = (body.data && body.data.object) || {};
  let eventId = body.id;

  if (type === 'checkout.session.completed' && obj.mode === 'subscription') {
    let meta = obj.metadata || {};
    return {
      eventId: eventId,
      kind: 'payment_success',
      reference: obj.client_reference_id,
      companyId: meta.companyId,
      planTier: meta.planTier,
      billingCycle: meta.billingCycle,
      amount: obj.amount_total,
      currency: (obj.currency || 'usd').toLowerCase(),
      customerEmail: obj.customer_details && obj.customer_details.email,
      subscriptionRef: obj.subscription
    };
  }

  if (type === 'customer.subscription.deleted') {
    return {
      eventId: eventId,
      kind: 'subscription_canceled',
      subscriptionRef: obj.id
    };
  }

  if (type === 'invoice.payment_failed') {
    return {
      eventId: eventId,
      kind: 'payment_failed',
      subscriptionRef: obj.subscription
    };
  }

  return null;
}

async function cancelSubscription(company) {
  if (!company.subscriptionRef) {
    throw new Error('Missing Stripe subscription id — cannot cancel.');
  }
  await stripeRequest('DELETE', '/subscriptions/' + company.subscriptionRef);
}

module.exports = {
  PROVIDER,
  configured,
  createCheckoutSession,
  verifySignature,
  parseWebhookEvent,
  cancelSubscription
};