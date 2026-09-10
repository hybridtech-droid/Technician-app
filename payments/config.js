// Pricing for the two paid tiers, in the smallest currency unit (kobo for
// NGN, cents for USD) — the unit every one of the three providers' APIs
// actually expects.
//
// Free stays free (₦0) and isn't listed here — it never goes through a
// checkout flow.
//
// Individual and company accounts are priced — and tiered — separately.
// An individual account is always capped at 1 seat (see
// effectiveLimitsFor() in server.js), and Pro already gives it every
// feature Enterprise gives a company (all export formats, unlimited
// reports, the audit log — see PLAN_TIERS.pro in server.js). A separate,
// pricier "Individual Enterprise" would have bought nothing real over Pro,
// so there is no enterprise entry under `individual` below at all — an
// individual account only ever has Free and Pro to choose from (enforced
// in GET /api/billing/plans and POST /api/billing/checkout).
//
// Annual pricing is a flat 10% off the 12-month total, for every paid
// tier — simple to reason about without a proration engine, and simple to
// say to a customer ("10% off, paid yearly").
//
// Why both NGN and USD: Paystack and Flutterwave settle directly in Naira,
// which is the right default for a Nigeria-first product. Stripe has no
// direct Naira settlement for a Nigerian business, so the Stripe path is
// offered in USD instead — same tier, same limits, just a different
// currency for whoever prefers or needs to pay that way (e.g. a
// diaspora-based or international customer). billing.html shows the Naira
// price prominently with this USD figure alongside it in smaller text,
// since the app isn't Nigeria-only.
//
// The USD figures are a fixed reference, set by hand against the
// prevailing rate (~₦1,350/$1 as of September 2026) — not a live
// conversion. Stripe's own checkout charges exactly this USD amount, so it
// has to be a deliberately chosen, stable number in the first place rather
// than something that silently drifts every time this file loads; a live
// conversion would also never exactly match what Stripe actually bills.
// Re-set these by hand if the Naira moves enough to make the price feel
// off (a large chunk of a payment processor's own cut is fixed-fee, so a
// low USD price is disproportionately expensive to collect — see the fee
// notes delivered alongside this file).
const PLAN_PRICING = {
  individual: {
    pro: {
      ngn: { monthly: 1500000, annual: 16200000 }, // ₦15,000 / ₦162,000 (10% off annual)
      usd: { monthly: 1100, annual: 11900 }         // $11 / $119
    }
    // No 'enterprise' here on purpose — see the comment above.
  },
  company: {
    pro: {
      ngn: { monthly: 2000000, annual: 21600000 }, // ₦20,000 / ₦216,000
      usd: { monthly: 1500, annual: 16200 }         // $15 / $162
    },
    enterprise: {
      ngn: { monthly: 5000000, annual: 54000000 }, // ₦50,000 / ₦540,000
      usd: { monthly: 3700, annual: 40000 }         // $37 / $400
    }
  }
};

function priceFor(accountType, planTier, billingCycle, currency) {
  let byAccount = PLAN_PRICING[accountType];
  if (!byAccount) {
    return null;
  }
  let tier = byAccount[planTier];
  if (!tier) {
    return null;
  }
  let byCurrency = tier[currency];
  if (!byCurrency) {
    return null;
  }
  return byCurrency[billingCycle] || null;
}

module.exports = { PLAN_PRICING, priceFor };