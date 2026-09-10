// Flutterwave integration — hosted checkout + recurring payment plans.
//
// NOTE on confidence: Flutterwave's recurring-billing model (Payment
// Plans) and its webhook verification scheme are less consistently
// documented across their own docs than Paystack's or Stripe's — in
// particular there are two different webhook-verification conventions
// described in different places (a plain secret-hash string compare via
// a `verif-hash` header, and a newer HMAC-SHA256 `flutterwave-signature`
// header). This module checks for BOTH, so whichever your account
// actually sends will verify correctly — but please confirm against your
// own Flutterwave dashboard (Settings -> Webhooks) once you have real
// keys, before relying on this in production. The subscription
// list/cancel endpoint below is similarly a best-effort implementation —
// verify it against developer.flutterwave.com before go-live.
const crypto = require('crypto');
const db = require('../db');

const PROVIDER = 'flutterwave';
const API_BASE = 'https://api.flutterwave.com/v3';

function secretKey() {
  return process.env.FLUTTERWAVE_SECRET_KEY || '';
}

function secretHash() {
  return process.env.FLUTTERWAVE_SECRET_HASH || '';
}

function configured() {
  return Boolean(secretKey());
}

async function flwRequest(method, urlPath, body) {
  let res = await fetch(API_BASE + urlPath, {
    method: method,
    headers: {
      Authorization: 'Bearer ' + secretKey(),
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = await res.json().catch(function () { return {}; });
  if (!res.ok || data.status === 'error') {
    throw new Error('Flutterwave API error: ' + (data.message || res.status));
  }
  return data.data;
}

async function ensurePlan(planTier, billingCycle, amount, planLabel) {
  let cached = db.prepare(
    'SELECT externalId FROM providerPlanCache WHERE provider = ? AND planTier = ? AND billingCycle = ?'
  ).get(PROVIDER, planTier, billingCycle);
  if (cached) {
    return cached.externalId;
  }

  let interval = billingCycle === 'annual' ? 'yearly' : 'monthly';
  let plan = await flwRequest('POST', '/payment-plans', {
    amount: amount / 100, // Flutterwave takes a decimal Naira amount here, not kobo
    name: 'Tervexa ' + planLabel + ' (' + interval + ')',
    interval: interval,
    currency: 'NGN'
  });

  db.prepare(
    'INSERT INTO providerPlanCache (provider, planTier, billingCycle, externalId, createdAt) VALUES (?, ?, ?, ?, ?)'
  ).run(PROVIDER, planTier, billingCycle, String(plan.id), new Date().toISOString());

  return String(plan.id);
}

async function createCheckoutSession(opts) {
  let planId = await ensurePlan(opts.planTier, opts.billingCycle, opts.amount, opts.planLabel);

  let data = await flwRequest('POST', '/payments', {
    tx_ref: opts.reference,
    amount: opts.amount / 100, // decimal Naira, not kobo
    currency: 'NGN',
    redirect_url: opts.successUrl,
    payment_plan: planId,
    customer: {
      email: opts.adminEmail,
      name: opts.company.name
    },
    customizations: {
      title: 'Tervexa — ' + opts.planLabel
    },
    meta: {
      companyId: opts.company.id,
      planTier: opts.planTier,
      billingCycle: opts.billingCycle
    }
  });

  return { url: data.link };
}

function verifySignature(req) {
  if (!req.rawBody) {
    return false;
  }

  // Scheme 1: plain secret-hash string compare (the long-documented
  // Flutterwave v3 convention).
  let directHeader = req.headers['verif-hash'];
  if (directHeader && secretHash()) {
    try {
      let a = Buffer.from(String(directHeader));
      let b = Buffer.from(secretHash());
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return true;
      }
    } catch (err) {
      // fall through to scheme 2
    }
  }

  // Scheme 2: HMAC-SHA256 of the raw body using the secret hash, sent as
  // flutterwave-signature. Accept either hex or base64 encoding since the
  // docs aren't fully consistent about which one is used.
  let hmacHeader = req.headers['flutterwave-signature'];
  if (hmacHeader && secretHash()) {
    let mac = crypto.createHmac('sha256', secretHash()).update(req.rawBody);
    let hex = mac.digest('hex');
    let mac2 = crypto.createHmac('sha256', secretHash()).update(req.rawBody);
    let b64 = mac2.digest('base64');
    if (hmacHeader === hex || hmacHeader === b64) {
      return true;
    }
  }

  return false;
}

function parseWebhookEvent(body) {
  let type = body.event || body.type || '';
  let data = body.data || {};
  let meta = data.meta || data.meta_data || {};

  let eventId = type + ':' + (data.tx_ref || data.id || '');

  if (type === 'charge.completed' && data.status === 'successful') {
    return {
      eventId: eventId,
      kind: 'payment_success',
      reference: data.tx_ref,
      companyId: meta.companyId,
      planTier: meta.planTier,
      billingCycle: meta.billingCycle,
      amount: Math.round((data.amount || 0) * 100),
      currency: (data.currency || 'NGN').toLowerCase(),
      customerEmail: data.customer && data.customer.email,
      subscriptionRef: data.plan ? String(data.plan) : null,
      subscriptionEmailToken: null
    };
  }

  if (type === 'subscription.cancelled') {
    return {
      eventId: eventId,
      kind: 'subscription_canceled',
      subscriptionRef: data.plan ? String(data.plan) : null,
      customerEmail: data.customer && data.customer.email
    };
  }

  return null;
}

// Best-effort — see the module-level note above. Looks up the customer's
// active subscription against this plan, then cancels it.
async function cancelSubscription(company) {
  let subs = await flwRequest('GET', '/subscriptions?email=' + encodeURIComponent(company.adminEmail || ''));
  let match = Array.isArray(subs) ? subs.find(function (s) { return s.status === 'active'; }) : null;
  if (!match) {
    throw new Error('No active Flutterwave subscription found to cancel.');
  }
  await flwRequest('PUT', '/subscriptions/' + match.id + '/cancel');
}

module.exports = {
  PROVIDER,
  configured,
  createCheckoutSession,
  verifySignature,
  parseWebhookEvent,
  cancelSubscription
};