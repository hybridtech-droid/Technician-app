// Paystack integration — hosted checkout + recurring subscriptions.
//
// Flow: ensurePlan (create-once, cached) -> initialize a transaction
// against that plan code, which both charges the first cycle AND
// subscribes the customer, so every later cycle auto-charges without us
// doing anything further -> Paystack calls our webhook on every event
// (first charge, each renewal, a failed renewal, a cancellation).
//
// Docs referenced: https://paystack.com/docs/api/plan/,
// https://paystack.com/docs/api/subscription/,
// https://paystack.com/docs/api/transaction/,
// https://paystack.com/docs/payments/webhooks/
const crypto = require('crypto');
const db = require('../db');

const PROVIDER = 'paystack';
const API_BASE = 'https://api.paystack.co';

function secretKey() {
  return process.env.PAYSTACK_SECRET_KEY || '';
}

function configured() {
  return Boolean(secretKey());
}

async function paystackRequest(method, urlPath, body) {
  let res = await fetch(API_BASE + urlPath, {
    method: method,
    headers: {
      Authorization: 'Bearer ' + secretKey(),
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = await res.json().catch(function () { return {}; });
  if (!res.ok || data.status === false) {
    throw new Error('Paystack API error: ' + (data.message || res.status));
  }
  return data.data;
}

// Creates the Plan object on Paystack's side the first time a given
// (planTier, billingCycle) pair is checked out, then reuses the cached
// plan_code forever after — see providerPlanCache in db.js.
async function ensurePlan(planTier, billingCycle, amount, planLabel) {
  let cached = db.prepare(
    'SELECT externalId FROM providerPlanCache WHERE provider = ? AND planTier = ? AND billingCycle = ?'
  ).get(PROVIDER, planTier, billingCycle);
  if (cached) {
    return cached.externalId;
  }

  let interval = billingCycle === 'annual' ? 'annually' : 'monthly';
  let plan = await paystackRequest('POST', '/plan', {
    name: 'Tervexa ' + planLabel + ' (' + interval + ')',
    amount: amount,
    interval: interval,
    currency: 'NGN'
  });

  db.prepare(
    'INSERT INTO providerPlanCache (provider, planTier, billingCycle, externalId, createdAt) VALUES (?, ?, ?, ?, ?)'
  ).run(PROVIDER, planTier, billingCycle, plan.plan_code, new Date().toISOString());

  return plan.plan_code;
}

// company: the row from the companies table. adminEmail: the email of the
// admin doing the checkout (Paystack charges/identifies by email).
async function createCheckoutSession(opts) {
  let planCode = await ensurePlan(opts.planTier, opts.billingCycle, opts.amount, opts.planLabel);

  let data = await paystackRequest('POST', '/transaction/initialize', {
    email: opts.adminEmail,
    amount: opts.amount,
    currency: 'NGN',
    plan: planCode,
    reference: opts.reference,
    callback_url: opts.successUrl,
    metadata: {
      companyId: opts.company.id,
      planTier: opts.planTier,
      billingCycle: opts.billingCycle
    }
  });

  return { url: data.authorization_url };
}

// Paystack signs the raw request body with HMAC-SHA512 using the secret
// key, sent as the x-paystack-signature header.
function verifySignature(req) {
  if (!req.rawBody) {
    return false;
  }
  let expected = crypto.createHmac('sha512', secretKey()).update(req.rawBody).digest('hex');
  let given = req.headers['x-paystack-signature'] || '';
  if (expected.length !== given.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  } catch (err) {
    return false;
  }
}

// Normalizes a verified webhook body into the common shape server.js's
// webhook route expects. Returns null for event types we don't act on
// (still a 200 back to Paystack — see the "only listen to what you need,
// but don't reject what you don't" note in server.js).
function parseWebhookEvent(body) {
  let event = body.event;
  let data = body.data || {};

  // Paystack doesn't hand us a single dedicated "event id" the way Stripe
  // does — event + the transaction/subscription reference together is
  // unique enough for our idempotency check.
  let eventId = event + ':' + (data.reference || data.subscription_code || data.id || '');

  if (event === 'charge.success') {
    return {
      eventId: eventId,
      kind: 'payment_success',
      reference: data.reference,
      companyId: data.metadata && data.metadata.companyId,
      planTier: data.metadata && data.metadata.planTier,
      billingCycle: data.metadata && data.metadata.billingCycle,
      amount: data.amount,
      currency: (data.currency || 'NGN').toLowerCase(),
      subscriptionRef: data.plan_object ? data.plan_object.plan_code : null,
      subscriptionEmailToken: null,
      nextPaymentDate: null
    };
  }

  if (event === 'subscription.create') {
    return {
      eventId: eventId,
      kind: 'subscription_linked',
      // subscription.create doesn't carry our metadata the way
      // charge.success does — charge.success (which fires first, for the
      // initial cycle) is what actually activates the company's plan.
      // This event just attaches the subscription_code/email_token
      // (needed later to cancel) to whichever company's admin email
      // matches, since that's the only shared key both events carry.
      customerEmail: data.customer && data.customer.email,
      subscriptionRef: data.subscription_code,
      subscriptionEmailToken: data.email_token,
      nextPaymentDate: data.next_payment_date
    };
  }

  if (event === 'subscription.disable' || event === 'subscription.not_renew') {
    return {
      eventId: eventId,
      kind: 'subscription_canceled',
      subscriptionRef: data.subscription_code
    };
  }

  if (event === 'invoice.payment_failed') {
    return {
      eventId: eventId,
      kind: 'payment_failed',
      subscriptionRef: data.subscription ? data.subscription.subscription_code : null
    };
  }

  return null;
}

async function cancelSubscription(company) {
  let meta = {};
  try {
    meta = JSON.parse(company.subscriptionMeta || '{}');
  } catch (err) {
    meta = {};
  }
  if (!company.subscriptionRef || !meta.emailToken) {
    throw new Error('Missing Paystack subscription code/email token — cannot cancel.');
  }
  await paystackRequest('POST', '/subscription/disable', {
    code: company.subscriptionRef,
    token: meta.emailToken
  });
}

module.exports = {
  PROVIDER,
  configured,
  createCheckoutSession,
  verifySignature,
  parseWebhookEvent,
  cancelSubscription
};