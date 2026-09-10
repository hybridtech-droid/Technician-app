// Dispatches to whichever provider module a request names. Every module
// implements the same shape (configured, createCheckoutSession,
// verifySignature, parseWebhookEvent, cancelSubscription) — see the
// comments at the top of each for what each of those actually does.
const paystack = require('./paystack');
const flutterwave = require('./flutterwave');
const stripe = require('./stripe');
const { PLAN_PRICING, priceFor } = require('./config');

const PROVIDERS = {
  paystack: paystack,
  flutterwave: flutterwave,
  stripe: stripe
};

// Paystack/Flutterwave settle in Naira; Stripe (no direct NGN settlement
// for a Nigerian business) is offered in USD instead. See config.js.
const PROVIDER_CURRENCY = {
  paystack: 'ngn',
  flutterwave: 'ngn',
  stripe: 'usd'
};

function getProvider(name) {
  return PROVIDERS[name] || null;
}

function availableProviders() {
  return Object.keys(PROVIDERS).filter(function (name) {
    return PROVIDERS[name].configured();
  });
}

module.exports = {
  PROVIDERS,
  PROVIDER_CURRENCY,
  PLAN_PRICING,
  priceFor,
  getProvider,
  availableProviders
};