// Shared phone-number normalization.
//
// A person can type their phone number at signup in several different
// shapes (0801..., +234801..., 234801..., 801...), but WhatsApp always
// sends the sender's number in its "from" field as country-code + number,
// digits only, no leading zero and no plus sign (e.g. "2348012345678").
// To link an incoming WhatsApp message back to a Tervexa account, both
// sides have to be reduced to that same shape before comparing them —
// this is the one place that happens, so signup and the WhatsApp webhook
// can never drift apart on the rule.
//
// This assumes Nigerian mobile numbers specifically (10 digits after the
// country code, country code 234). If Tervexa ever supports phone numbers
// from other countries, this will need to become smarter than "guess from
// digit count."
function normalizePhone(raw) {
  if (!raw) {
    return '';
  }

  const digits = String(raw).replace(/\D/g, '');

  if (!digits) {
    return '';
  }

  // Local format with leading 0: 0801 234 5678 (11 digits)
  if (digits.length === 11 && digits.startsWith('0')) {
    return '234' + digits.slice(1);
  }

  // Already has the country code, no plus sign: 234801... (13 digits)
  if (digits.length === 13 && digits.startsWith('234')) {
    return digits;
  }

  // Bare subscriber number, no leading 0 and no country code (10 digits)
  if (digits.length === 10) {
    return '234' + digits;
  }

  // Anything else — an unrecognized shape, or a non-Nigerian number.
  // Return the digits as-is rather than guessing further; it just won't
  // match a WhatsApp "from" field unless it happens to already be in that
  // exact shape.
  return digits;
}

module.exports = { normalizePhone };