require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { getEquipmentKnowledge } = require('./equipment-knowledge');
const session = require('express-session');
const buildSqliteSessionStore = require('./sqlite-session-store');
const bcrypt = require('bcrypt');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { normalizePhone } = require('./phone');
const payments = require('./payments');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// --- WhatsApp (Meta Cloud API) config ---
// All of these come from the Meta developer console once a WhatsApp
// Business app is set up (see the setup guide). Left unset, the webhook
// routes still run — they just can't actually verify with Meta or send
// messages, which is fine for local testing with simulated payloads.
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

const app = express();
const PORT = 3000;

// Matches the <option value="..."> codes in the lang-selector dropdown on
// every page. The dropdown itself doesn't translate the site's UI (that's
// a much bigger job) — right now it only tells the AI what language to
// answer in, regardless of what language the report or question was
// written in.
const LANGUAGE_NAMES = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  pt: 'Portuguese',
  ar: 'Arabic',
  zh: 'Chinese',
  hi: 'Hindi',
  sw: 'Swahili',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  sv: 'Swedish'
};

// The AI can answer in any of the 13 languages above (already working) —
// but the web app's actual interface text (buttons, labels, nav) is only
// translated for these, so far. Selecting one outside this list still
// gets AI answers in that language; the surrounding page just stays in
// English until it's added here and to the frontend translations.
// Expanding this to more languages later means adding a translation set
// on the frontend, not changing anything here.
const UI_TRANSLATED_LANGUAGES = ['en', 'fr', 'es', 'pt', 'sw'];

function languageInstruction(code) {
  const name = LANGUAGE_NAMES[code];

  // No recognized selection sent (older cached frontend, or the field was
  // omitted) — let the model mirror whatever language the input is
  // written in, rather than silently forcing English.
  if (!name) {
    return '';
  }

  return ' Respond entirely in ' + name + ', regardless of what language the input is written in.';
}

// The `verify` callback stashes the exact raw request bytes on req.rawBody
// alongside the normal parsed req.body. Nothing needed that before now —
// but a payment provider's webhook signature is computed over the raw
// bytes it sent, and re-serializing the parsed JSON (JSON.stringify(req.body))
// isn't guaranteed to produce an identical byte-for-byte string (key
// order, spacing), which silently breaks signature verification. Capturing
// the real bytes here means every webhook handler can verify correctly
// without needing its own separate body-parsing middleware.
app.use(express.json({
  limit: '10mb',
  verify: function (req, res, buf) {
    req.rawBody = buf;
  }
}));

const SqliteSessionStore = buildSqliteSessionStore(session.Store);

app.use(session({
  store: new SqliteSessionStore({ client: db }),
  secret: process.env.SESSION_SECRET || 'change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true
    // No maxAge here on purpose — that makes this a plain browser-session
    // cookie by default (gone once the browser/app is actually closed).
    // "Remember me" at login is what opts a specific login into a 30-day
    // persistent cookie instead; see /api/login below.
  }
}));

// These pages need a logged-in session. Gate them BEFORE express.static,
// because static() will happily serve the file to anyone and only the
// page's own JS (after it has already rendered) would notice you're not
// logged in — that's what caused the "flash of the page, then bounced
// to login" behaviour. Checking the session here means a logged-out
// visit never renders the page at all; it's just a clean redirect.
const protectedPages = ['/fault-report.html', '/fault-log.html', '/chat.html', '/admin.html', '/billing.html'];

app.get(protectedPages, function (req, res, next) {
  if (req.session && req.session.userId && isActiveUser(req.session.userId)) {
    return next();
  }

  if (req.session && req.session.userId) {
    // A deactivated account with a still-live session cookie — clear the
    // session rather than leaving a dead one behind.
    req.session.destroy(function () {});
  }

  res.redirect('/login.html');
});

// fault-report.html additionally needs a field-facing role — supervisors,
// managers and (company) admins manage the log rather than submit to it,
// but an individual ("Just me") account's admin is that account's only
// user and does need to reach this page — see canSubmitReports() above.
// Anyone logged in but not allowed to submit gets sent to the log instead
// of a dead end.
app.get('/fault-report.html', function (req, res, next) {
  if (canSubmitReports(req.session.role, req.session.companyId)) {
    return next();
  }

  res.redirect('/fault-log.html');
});

// admin.html and billing.html are administrator-only — billing doubly so,
// since it's the page that can actually spend the company's money.
app.get(['/admin.html', '/billing.html'], function (req, res, next) {
  if (adminRoles.includes(req.session.role)) {
    return next();
  }

  res.redirect('/fault-log.html');
});

app.use(express.static('.'));

const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a while and try again.' },
  // Both routes this is applied to (/api/diagnose, /api/chat) run
  // requireAuth first, so req.session.userId is always set by the time
  // this runs. Keying by user instead of by IP means the limit follows
  // each technician individually — several people diagnosing faults from
  // the same office/site Wi-Fi no longer share one bucket and throttle
  // each other out.
  keyGenerator: function (req) {
    return 'user:' + req.session.userId;
  }
});

// Separate, tighter limiter for auth endpoints so a login/signup script
// can't be hammered the way the AI endpoints can. There's no logged-in
// user yet at this point, so this can't key by userId the way aiLimiter
// does — instead it keys by IP *plus* whichever account identifier the
// request names (email for signup/login/request-password-reset, the reset
// token for reset-password). That keeps the original point of this limiter
// intact (repeated attempts against one account from one place still get
// capped) while fixing the false-positive case: several technicians
// logging into their own separate accounts from the same office IP no
// longer share a bucket and lock each other out.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a while and try again.' },
  keyGenerator: function (req) {
    // Newer express-rate-limit versions require IPv6 addresses to go
    // through their ipKeyGenerator helper whenever a custom keyGenerator
    // touches req.ip — a raw IPv6 address has far too many equivalent
    // forms for one person to be usable as a rate-limit key directly, so
    // the helper collapses it to a fixed-size subnet first. Older
    // versions (this project's package.json range can resolve to either)
    // don't export that helper, so fall back to the raw IP there — it's
    // still correct for IPv4, which is what local/LAN testing uses.
    const ipPart = (typeof rateLimit.ipKeyGenerator === 'function') ? rateLimit.ipKeyGenerator(req.ip) : req.ip;
    const identifier = ((req.body && (req.body.email || req.body.token)) || '').toString().toLowerCase().slice(0, 200);
    return identifier ? ipPart + ':' + identifier : ipPart;
  }
});

// Checked on every already-authenticated request, not just at login — an
// administrator deactivating someone should take effect right away, even
// for a browser tab that's already logged in with a live session cookie.
// A plain synchronous point lookup on an indexed primary key, so this is
// cheap enough to do on every request.
function isActiveUser(userId) {
  const row = db.prepare('SELECT active FROM users WHERE id = ?').get(userId);
  return Boolean(row) && row.active !== 0;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId && isActiveUser(req.session.userId)) {
    return next();
  }

  if (req.session && req.session.userId) {
    // Session cookie is for a real, but now-deactivated, account — clear
    // it rather than leaving a dead session hanging around.
    req.session.destroy(function () {});
  }

  res.status(401).json({ error: 'You must be logged in.' });
}

// --- Role tiers -------------------------------------------------------
// The six roles offered on the signup form aren't just a label — each of
// these lists is a real permission boundary, checked server-side on the
// relevant route (never trust a client-side-only check for any of this).
//
//  - Field technician / Field application specialist: can only see, edit
//    and resolve reports THEY submitted. Can submit new reports.
//  - Engineer: can see every report (useful for cross-site troubleshooting
//    context) but can only edit/resolve their OWN — same edit boundary as
//    technician/FAS, just with read visibility into everyone else's too.
//    Can submit new reports.
//  - Site supervisor: can see and edit/resolve every report. Cannot submit
//    new reports (submission is a field-role action), delete a report, or
//    reach the admin panel.
//  - Maintenance manager: same as supervisor, plus can permanently delete
//    a report.
//  - Administrator: same as manager, plus the only role with access to the
//    admin panel (manage accounts: change a role, activate/deactivate a
//    login). Can also submit reports — unlike supervisor/manager, this
//    isn't a field-role action for admin, because an 'individual' signup
//    (a one-person company, see POST /api/signup) always lands as admin
//    with no other role available, and that person still needs to be able
//    to file their own fault reports; a company admin choosing to file one
//    too is a harmless superset of what they could already do everywhere
//    else.
//
// There's still no "site" or "team" concept in the data model — "can see
// every report" really does mean the whole company's fault log, for every
// role above technician/FAS's own-report visibility boundary.
//
// Note view and edit are two different boundaries: technician/FAS are
// restricted on BOTH (they can't even see someone else's report); engineer
// is restricted on edit only (sees everything, but can only change their
// own).
const viewOwnReportsOnlyRoles = ['technician', 'field-application-specialist'];
const editAnyReportRoles = ['supervisor', 'manager', 'admin'];
const deleteReportRoles = ['manager', 'admin'];
// A company's admin manages/reviews the fault log rather than submitting to
// it (same tier as manager, see editAnyReportRoles/deleteReportRoles above)
// — but an individual ("Just me") account's one and only user also holds
// the 'admin' role (see the signup handler's finalRole logic), and for that
// person 'admin' has to mean field worker too, since there's no one else on
// the account to do the actual reporting. canSubmitReports() below is what
// tells those two 'admin' cases apart; don't add 'admin' back to this plain
// array, or a company admin regains the ability to submit reports, which
// is exactly the tiered-permission boundary this list exists to draw.
const submitReportRoles = ['technician', 'field-application-specialist', 'engineer'];
const exportReportsRoles = ['engineer', 'supervisor', 'manager', 'admin'];
const adminRoles = ['admin'];

// See the comment on submitReportRoles above for why this isn't just
// `submitReportRoles.includes(role)`.
function canSubmitReports(role, companyId) {
  if (submitReportRoles.includes(role)) return true;
  if (role !== 'admin' || !companyId) return false;

  const companyRow = db.prepare('SELECT isIndividual FROM companies WHERE id = ?').get(companyId);
  return Boolean(companyRow && companyRow.isIndividual);
}

// Maps each field-facing role to the request types that fall inside their
// normal scope of work — the request-type picker on fault-report.html
// defaults to just these for that role, and the fault log is filtered the
// same way, so nobody's wading through report types that aren't theirs to
// handle. A role with no entry here (supervisor, manager, admin) is never
// scoped: those roles manage or administer across every field rather than
// owning one, so restricting them would work against the job.
//
// The overlap on 'after-sales' between engineer and field-application-
// specialist is intentional — after-sales support commonly needs both
// hands-on repair knowledge and application/process knowledge, and which
// role actually owns it varies by company.
//
// 'training' sits with field-application-specialist only: it typically
// follows an engineer's installation (see 'installation' above) once the
// equipment is live, and training the people who'll run it day to day is
// application/process knowledge, not repair work.
//
// This is a UX default, not the security boundary on its own — see
// hybridMode below and its enforcement in POST/GET /api/reports.
const ROLE_REQUEST_TYPES = {
  technician: ['fault'],
  engineer: ['fault', 'installation', 'after-sales'],
  'field-application-specialist': ['application', 'after-sales', 'training']
};

function requireRole(allowedRoles) {
  return function (req, res, next) {
    if (req.session && allowedRoles.includes(req.session.role)) {
      return next();
    }

    res.status(403).json({ error: 'Your account does not have access to this.' });
  };
}

// --- Plan tiers (foundation for billing — nothing here is enforced yet) --
// The single place tier shape lives, so pricing/limits can change without
// a migration (companies only ever store the tier NAME — see planTier on
// the companies table in db.js). seatLimit/monthlyReportLimit are null for
// "unlimited". Seats and features scale with company size/ability to pay
// (the predictable, fair lever); the report cap only bites on the free
// tier, to bound AI-diagnosis cost exposure on a plan nobody's paying for
// — paying tiers are never usage-capped, so upgrading never feels like
// trading one limit for another. Every existing company was grandfathered
// onto 'pro' when this was introduced (see the db.js migration).
//
// graceSeats/graceReports define a soft buffer above seatLimit/
// monthlyReportLimit: a company between the limit and limit+grace can
// still work (checkSeatLimit/checkReportLimit below return allowed:true,
// overLimit:true so the UI can show a warning), and only gets hard-blocked
// once it reaches limit+grace. A null seatLimit/monthlyReportLimit means
// "unlimited" and skips enforcement entirely — grace doesn't apply.
const PLAN_TIERS = {
  free: {
    label: 'Free',
    seatLimit: 3,
    graceSeats: 1,
    monthlyReportLimit: 15,
    graceReports: 5,
    exportFormats: ['csv'],
    adminAddedEmployees: false,
    auditLog: false
  },
  pro: {
    label: 'Pro',
    seatLimit: 20,
    graceSeats: 2,
    monthlyReportLimit: null,
    graceReports: 0,
    exportFormats: ['csv', 'xlsx', 'pdf'],
    adminAddedEmployees: true,
    auditLog: true
  },
  enterprise: {
    label: 'Enterprise',
    seatLimit: null,
    graceSeats: 0,
    monthlyReportLimit: null,
    graceReports: 0,
    exportFormats: ['csv', 'xlsx', 'pdf'],
    adminAddedEmployees: true,
    auditLog: true
  },
  // Not a purchasable tier — never listed on /api/billing/plans and the
  // checkout endpoint only ever accepts 'pro'/'enterprise' as a planTier,
  // so nobody can buy their way onto this one. It exists purely for an
  // account someone (the app's own operator, a comped partner) is put on
  // by hand, directly in the database — see set-unlimited-plan.js.
  unlimited: {
    label: 'Unlimited',
    seatLimit: null,
    graceSeats: 0,
    monthlyReportLimit: null,
    graceReports: 0,
    exportFormats: ['csv', 'xlsx', 'pdf'],
    adminAddedEmployees: true,
    auditLog: true
  }
};

function planLimitsFor(planTier) {
  return PLAN_TIERS[planTier] || PLAN_TIERS.free;
}

// Individual (solo) signups share whichever tier's report limit and
// features they're on, but always keep their own, tighter seat cap — 1,
// not whatever that tier would normally allow — since by definition it's
// one person, on the free tier or Pro alike ("still with the only seat",
// per how individual Pro pricing was specified). The one exception is
// 'unlimited' (see set-unlimited-plan.js): that's a manual, no-limits
// override applied by hand and is never affected by account type.
function effectiveLimitsFor(companyRow) {
  const planTier = (companyRow && companyRow.planTier) || 'free';
  const limits = Object.assign({}, planLimitsFor(planTier));
  if (companyRow && companyRow.isIndividual && planTier !== 'unlimited') {
    limits.seatLimit = 1;
    limits.graceSeats = 0;
  }
  return limits;
}

// 'individual' vs 'company' — the axis payments/config.js prices and
// tiers by (an individual account never has an Enterprise option, and
// pays a different Pro price than a company — see PLAN_PRICING there).
function accountTypeFor(companyRow) {
  return (companyRow && companyRow.isIndividual) ? 'individual' : 'company';
}

// Same free-trial length for every new account, individual or company —
// 14 days, after which the account either upgrades to a paid plan or drops
// to the free tier's normal (no-trial) seat/report limits.
const TRIAL_DAYS = 14;

function trialEndsAtFor(days, fromISO) {
  return new Date(new Date(fromISO).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

// A company is "on trial" only if it's still on the free tier AND has a
// trialEndsAt set at all — a NULL trialEndsAt (every company created
// before this feature existed) means there's nothing to expire, so it
// keeps working exactly as it always has. Upgrading off free tier makes
// the trial irrelevant too, even if trialEndsAt is still sitting there
// from before the upgrade.
function trialStatusFor(companyRow) {
  const planTier = (companyRow && companyRow.planTier) || 'free';
  const trialEndsAt = companyRow && companyRow.trialEndsAt;
  if (planTier !== 'free' || !trialEndsAt) {
    return { onTrial: false, expired: false, trialEndsAt: null };
  }
  const expired = new Date(trialEndsAt).getTime() < Date.now();
  return { onTrial: true, expired: expired, trialEndsAt: trialEndsAt };
}

// The two enforcement checks — one per limit that actually varies by
// tier. Both return { allowed, overLimit, message? }: allowed is what a
// caller should actually act on (block the request when false); overLimit
// on its own (allowed:true, overLimit:true) means "let it through, but
// tell the admin they're in the grace window" so the UI can show a
// warning ahead of the real block. A null limit always short-circuits to
// allowed:true — there's nothing to enforce.
function checkSeatLimit(companyId) {
  const companyRow = db.prepare('SELECT planTier, isIndividual, trialEndsAt FROM companies WHERE id = ?').get(companyId);

  const trial = trialStatusFor(companyRow);
  if (trial.expired) {
    return {
      allowed: false,
      overLimit: true,
      message: 'Your free trial ended on ' + trial.trialEndsAt.slice(0, 10) + '. Upgrade to Pro or Enterprise to add more people.'
    };
  }

  const limits = effectiveLimitsFor(companyRow);

  if (limits.seatLimit === null) {
    return { allowed: true, overLimit: false };
  }

  const seatCount = db.prepare('SELECT COUNT(*) AS count FROM users WHERE companyId = ? AND active = 1').get(companyId).count;
  const hardCap = limits.seatLimit + (limits.graceSeats || 0);

  if (seatCount >= hardCap) {
    return {
      allowed: false,
      overLimit: true,
      message: 'Your ' + limits.label + ' plan is full at ' + seatCount + ' active seats. Upgrade your plan to add more.'
    };
  }

  if (seatCount >= limits.seatLimit) {
    return {
      allowed: true,
      overLimit: true,
      message: 'You are over your ' + limits.label + ' plan\'s seat limit (' + limits.seatLimit + '). A few more will still work, then new ones will be blocked until you upgrade.'
    };
  }

  return { allowed: true, overLimit: false };
}

function checkReportLimit(companyId) {
  const companyRow = db.prepare('SELECT planTier, isIndividual, trialEndsAt FROM companies WHERE id = ?').get(companyId);

  const trial = trialStatusFor(companyRow);
  if (trial.expired) {
    return {
      allowed: false,
      overLimit: true,
      message: 'Your free trial ended on ' + trial.trialEndsAt.slice(0, 10) + '. Upgrade to Pro or Enterprise to keep submitting reports.'
    };
  }

  const limits = effectiveLimitsFor(companyRow);

  if (limits.monthlyReportLimit === null) {
    return { allowed: true, overLimit: false };
  }

  const monthPrefix = new Date().toISOString().slice(0, 7);
  const reportsThisMonth = db.prepare(
    "SELECT COUNT(*) AS count FROM reports WHERE companyId = ? AND date LIKE ?"
  ).get(companyId, monthPrefix + '%').count;

  const hardCap = limits.monthlyReportLimit + (limits.graceReports || 0);

  if (reportsThisMonth >= hardCap) {
    return {
      allowed: false,
      overLimit: true,
      message: 'Your ' + limits.label + ' plan\'s monthly report limit (' + limits.monthlyReportLimit + ') has been reached. Upgrade your plan to keep submitting reports this month.'
    };
  }

  if (reportsThisMonth >= limits.monthlyReportLimit) {
    return {
      allowed: true,
      overLimit: true,
      message: 'You are over your ' + limits.label + ' plan\'s monthly report limit (' + limits.monthlyReportLimit + '). A few more will still go through, then new ones will be blocked until next month or an upgrade.'
    };
  }

  return { allowed: true, overLimit: false };
}

// Records one sensitive account-management action for a company's audit
// trail. actorEmail/targetEmail are captured as plain text at the time of
// the action (not looked up live later) so the log still reads sensibly
// even after an account is deleted or its email changes. details is a
// short human-readable note, not structured data — this is a log meant to
// be read, not queried.
function logAudit(companyId, actor, action, target, details) {
  try {
    db.prepare(`
      INSERT INTO auditLog (companyId, actorUserId, actorEmail, action, targetUserId, targetEmail, details, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      companyId,
      actor ? actor.id : null,
      actor ? actor.email : null,
      action,
      target ? target.id : null,
      target ? target.email : null,
      details || '',
      new Date().toISOString()
    );
  } catch (err) {
    // Never let a logging failure break the action it's logging.
    console.error('Audit log write failed:', err.message);
  }
}

// Whitelists matching the actual <option value="..."> sets in the HTML
// forms, so a direct API call can't slip in a value the UI never offers
// (an unrecognized status, a made-up role, etc).
const VALID_REQUEST_TYPES = ['fault', 'installation', 'after-sales', 'application', 'training'];
const VALID_REPORT_STATUSES = ['Open', 'In progress', 'Resolved'];
const VALID_ROLES = ['technician', 'field-application-specialist', 'engineer', 'supervisor', 'manager', 'admin'];

// Signing up to JOIN an existing company can't hand out the admin role —
// that's the whole point of closing the self-escalation gap: the only way
// to become an admin is to be the one creating the company, or to already
// be an admin who promotes someone else from the admin panel.
const JOIN_SIGNUP_ROLES = VALID_ROLES.filter(function (r) { return r !== 'admin'; });

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// At least 8 characters, with at least one letter and one number. Checked
// here — not just in the frontend's own copy of this rule — so a direct
// API call can't skip it; the two are kept deliberately in sync (see
// passwordError() in main.js).
function passwordError(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }

  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'Password must include at least one letter and one number.';
  }

  return null;
}

// Shared by "create a new company" signup and the admin panel's "regenerate
// invite code" action. No 0/O or 1/I — easy to misread when a code gets
// read out loud over a phone call, which is exactly how a lot of these will
// actually get shared with a new employee.
function generateInviteCodeCandidate() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += alphabet[crypto.randomInt(alphabet.length)];
  }
  return code;
}

// Retries on the (extremely unlikely, 1-in-32^8) chance of a collision
// rather than trusting probability with something that has to be unique.
function generateUniqueInviteCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateInviteCodeCandidate();
    const existing = db.prepare('SELECT id FROM companies WHERE inviteCode = ?').get(code);
    if (!existing) {
      return code;
    }
  }
  throw new Error('Could not generate a unique invite code.');
}

// A temporary password for an account the admin panel creates directly —
// random, and re-rolled until it actually satisfies passwordError() so it's
// never rejected as "not a valid password" the one time it matters. The
// employee is required to replace it with one of their own choosing on
// first login (see mustChangePassword).
function generateTempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let pw = '';
    for (let i = 0; i < 10; i++) {
      pw += alphabet[crypto.randomInt(alphabet.length)];
    }
    if (!passwordError(pw)) {
      return pw;
    }
  }
  // Practically unreachable given the alphabet above, but guaranteed to
  // pass passwordError() if it's ever hit.
  return 'Tvx' + crypto.randomInt(100000, 999999) + 'x';
}

// No email provider is configured yet — this keeps the reset flow fully
// working and testable without real credentials. Once SMTP_HOST etc. are
// set in .env and `npm install nodemailer` has been run, real emails go
// out instead of this console fallback.
async function sendPasswordResetEmail(toEmail, resetUrl) {
  if (!process.env.SMTP_HOST) {
    console.log('--- PASSWORD RESET LINK (no SMTP configured — see .env) ---');
    console.log('To:', toEmail);
    console.log('Link:', resetUrl);
    console.log('------------------------------------------------------------');
    return;
  }

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: toEmail,
      subject: 'Reset your Tervexa password',
      text: 'Someone requested a password reset for this Tervexa account. If this was you, ' +
        'use the link below within 30 minutes:\n\n' + resetUrl +
        '\n\nIf you did not request this, you can ignore this email.'
    });
  } catch (err) {
    console.error('Password reset email failed to send:', err.message);
    console.log('Fallback — reset link for', toEmail + ':', resetUrl);
  }
}

app.get('/api/health', function (req, res) {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  res.json({ ok: true, keyLoaded: hasKey });
});

// Lets the frontend ask "is anyone logged in, and who" on page load,
// so pages can redirect to login.html or show a logged-in-as control.
app.get('/api/me', function (req, res) {
  if (req.session && req.session.userId && isActiveUser(req.session.userId)) {
    const companyRow = req.session.companyId
      ? db.prepare('SELECT name, isIndividual FROM companies WHERE id = ?').get(req.session.companyId)
      : null;

    return res.json({
      loggedIn: true,
      email: req.session.email,
      fullName: req.session.fullName,
      role: req.session.role,
      companyName: companyRow ? companyRow.name : '',
      // Lets the client tell an individual ("Just me") admin apart from a
      // company admin — same role, very different nav/permissions (see
      // canSubmitReports() and the fault-report.html nav link in main.js).
      isIndividual: Boolean(companyRow && companyRow.isIndividual),
      preferredLanguage: req.session.preferredLanguage || 'en',
      uiTranslatedLanguages: UI_TRANSLATED_LANGUAGES,
      hybridMode: Boolean(req.session.hybridMode),
      // null means "not scoped at all" (supervisor/manager/admin) rather
      // than "scoped to nothing" — the frontend treats null as "show every
      // request type", same as hybridMode: true.
      allowedRequestTypes: ROLE_REQUEST_TYPES[req.session.role] || null
    });
  }

  if (req.session && req.session.userId) {
    req.session.destroy(function () {});
  }

  res.json({ loggedIn: false, uiTranslatedLanguages: UI_TRANSLATED_LANGUAGES });
});

// Lets a field-facing account switch between the scoped view (just their
// role's request types) and a hybrid view (everything) — for people whose
// job genuinely spans more than one field. Persisted on the account, not
// just this browser, so it follows them the way preferredLanguage does.
app.post('/api/hybrid-mode', requireAuth, function (req, res) {
  const enabled = Boolean(req.body && req.body.enabled);

  try {
    db.prepare('UPDATE users SET hybridMode = ? WHERE id = ?').run(enabled ? 1 : 0, req.session.userId);
    req.session.hybridMode = enabled;
    res.json({ ok: true, hybridMode: enabled });
  } catch (err) {
    console.error('Could not save hybrid mode:', err.message);
    res.status(500).json({ error: 'Could not save hybrid mode preference.' });
  }
});

// Lets a logged-in page save a language choice to the account itself, not
// just this one browser's localStorage — this is what lets WhatsApp (which
// has no browser, no localStorage) reply in the same language someone
// picked on the web app, and vice versa.
app.post('/api/preferred-language', requireAuth, function (req, res) {
  const { language } = req.body;

  if (!language || !LANGUAGE_NAMES[language]) {
    return res.status(400).json({ error: 'Unrecognized language.' });
  }

  try {
    db.prepare('UPDATE users SET preferredLanguage = ? WHERE id = ?').run(language, req.session.userId);
    req.session.preferredLanguage = language;
    res.json({ ok: true, preferredLanguage: language });
  } catch (err) {
    console.error('Could not save preferred language:', err.message);
    res.status(500).json({ error: 'Could not save language preference.' });
  }
});

// Shared by /api/diagnose (web form) and the WhatsApp guided fault-report
// flow, so both produce the exact same prompt from the same fields instead
// of two copies that can quietly drift apart.
function buildDiagnosisPrompt(fields) {
  const {
    requestType,
    faultType,
    severity,
    onset,
    description,
    equipment,
    location,
    installStage,
    equipmentModel,
    timeSinceInstall,
    warrantyStatus,
    applicationImpact,
    recurring,
    trainingType,
    traineeAudience,
    hasPhoto,
    language
  } = fields;

  const briefs = {
    fault: 'You are assisting a field service technician with a fault diagnosis. Give likely causes and the checks to run, in order.',
    installation: 'You are assisting a field service engineer with an equipment installation or commissioning. Give the checks and steps for this stage, and flag anything that must be verified before handover.',
    'after-sales': 'You are assisting with an after-sales support case on equipment already installed. Give likely causes, what to check, and whether this needs a site visit or can be resolved remotely.',
    application: 'You are assisting a field application specialist with an application or process concern. Assess the likely cause, suggest how to troubleshoot it, and recommend corrective actions including any contamination or process-control measures.',
    training: 'You are assisting a field application specialist preparing to train staff on this equipment. Suggest what the session should cover, in order, and flag anything the trainees commonly get wrong or should demonstrate back before being signed off.'
  };

  const brief = briefs[requestType] || briefs.fault;

  const photoNote = hasPhoto
    ? '\n\nA photo of the equipment is attached. Describe what you can see in it that is relevant, and use it in your assessment.'
    : '';

  let context =
    'Equipment: ' + equipment + '\n' +
    'Location: ' + location + '\n';

  if (requestType === 'fault') {
    context = context +
      'Fault category: ' + faultType + '\n' +
      'Severity: ' + severity + '\n' +
      'Onset: ' + onset + '\n';
  }

  if (requestType ==='installation') {
    context = context +
      'Installation stage: ' + installStage + '\n' +
      'Make and model: ' + equipmentModel + '\n';
  }

  if (requestType === 'after-sales') {
    context = context +
      'Time since installation: ' + timeSinceInstall + '\n' +
      'Warranty status: ' + warrantyStatus + '\n';
  }

  if (requestType === 'application') {
    context = context +
      'Affected area: ' + applicationImpact + '\n' +
      'Recurrence: ' + recurring + '\n';
  }

  if (requestType === 'training') {
    context = context +
      'Training type: ' + trainingType + '\n' +
      'Trainees: ' + traineeAudience + '\n';
  }

  // Equipment-specific background, when the report's own text matches a
  // known subsystem — see equipment-knowledge.js. It's context for the
  // model to reason from, not something to be echoed back verbatim, hence
  // the instruction below.
  const knowledgeNotes = getEquipmentKnowledge(equipment, [description, faultType, applicationImpact].filter(Boolean).join(' '));
  const knowledgeBlock = knowledgeNotes.length
    ? '\n\nBackground on this equipment\'s common failure patterns (use this to inform your reasoning — do not quote it back, write the diagnosis in your own words):\n' +
      knowledgeNotes.map(function (note, i) { return (i + 1) + '. ' + note; }).join('\n') + '\n'
    : '';

  return brief + '\n\n' +
    context +
    'Reported: ' + description + '\n' +
    knowledgeBlock + '\n' +
    'Keep it under 200 words. Write in plain prose with no Markdown formatting — no asterisks, hashes, or bullet symbols. ' +
    'Note any safety precautions first if they apply.' + photoNote + languageInstruction(language);
}

// Every non-streaming Anthropic call in this file used to grab the reply
// text with `message.content[0].text` — that assumes the first content
// block exists AND is a text block, which isn't always true (an empty
// content array, or a non-text block landing first, both happen in the
// wild and previously crashed with an unhelpful "Cannot read properties
// of undefined (reading 'text')"). This finds the first actual text block
// instead of assuming position 0, and throws a message that says what
// really went wrong (stop reason, content shape) so it's diagnosable from
// the server log rather than a bare TypeError.
function extractText(message) {
  const block = message && Array.isArray(message.content)
    ? message.content.find(function (b) { return b && b.type === 'text' && typeof b.text === 'string'; })
    : null;

  if (block) {
    return block.text;
  }

  const shape = message && Array.isArray(message.content)
    ? message.content.map(function (b) { return b && b.type; }).join(',')
    : typeof (message && message.content);

  const err = new Error('Model response had no text content (stop_reason: ' + (message && message.stop_reason) + ', content: [' + shape + '])');
  // stop_reason "refusal" means the model itself declined to answer this
  // specific input (a safety/content judgment call, not a bug or outage) —
  // callers can check this to show something more accurate than a generic
  // "service unavailable" message.
  if (message && message.stop_reason === 'refusal') {
    err.isRefusal = true;
  }
  throw err;
}

// photo, if provided, is { data: base64String, mediaType: 'image/jpeg' }.
async function runDiagnosis(fields, photo) {
  const prompt = buildDiagnosisPrompt(Object.assign({}, fields, { hasPhoto: Boolean(photo && photo.data) }));

  let content = [];

  if (photo && photo.data) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: photo.mediaType,
        data: photo.data
      }
    });
  }

  content.push({ type: 'text', text: prompt });

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    messages: [{ role: 'user', content: content }]
  });

  return extractText(message);
}

// Streamed rather than a single JSON response — the model still takes
// however long it takes to finish the full ~500-token diagnosis, but a
// technician standing at a fault site sees words start appearing within
// well under a second instead of staring at "Analysing your report..." for
// the entire generation. Content-Type stays plain text on purpose: this is
// a raw incremental body, not an SSE event stream, so the frontend just
// reads it as chunks come in (see getDiagnosis() in js/main.js) rather than
// parsing "data: ..." frames.
//
// This route builds the request itself instead of calling runDiagnosis()
// (kept as-is, non-streaming) because the WhatsApp fault-report flow reuses
// that same function and only ever wants the finished text to send as one
// message — there's no "stream words into a chat bubble" equivalent there.
app.post('/api/diagnose', requireAuth, aiLimiter, async function (req, res) {
  const { description, photo } = req.body;

  if (!description || description.trim().length < 20) {
    return res.status(400).json({ error: 'Description too short.' });
  }

  const prompt = buildDiagnosisPrompt(Object.assign({}, req.body, { hasPhoto: Boolean(photo && photo.data) }));
  let content = [];

  if (photo && photo.data) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: photo.mediaType,
        data: photo.data
      }
    });
  }

  content.push({ type: 'text', text: prompt });

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: content }]
    });

    stream.on('text', function (textDelta) {
      res.write(textDelta);
    });

    await stream.finalMessage();
    res.end();
  } catch (err) {
    console.error('Anthropic error:', err.message);
    // Streaming may have already started by the time the model errors out
    // mid-generation — headers (and possibly some text) may already be on
    // the wire, so a JSON error body is only possible if nothing was sent
    // yet. Either way, ending the response is what lets the frontend's
    // reader loop finish; a response that never sent any text reads as
    // "diagnosis unavailable" client-side.
    if (!res.headersSent) {
      res.status(500).json({ error: 'Diagnosis service unavailable.' });
    } else {
      res.end();
    }
  }
});

// Rewrites the wording of the five FIXED resolution-guide steps (Prepare,
// Inspect, Test, Resolve, Confirm) to match one specific report more
// closely — it never changes the step count, order, or titles, and never
// describes what's literally happening inside the equipment (see the
// diag-anim comment block in js/main.js for why: a wrong-but-convincing
// picture of real equipment internals is worse than a generic one). This
// is purely a wording upgrade over buildGenericDiagSteps()'s client-side
// fallback, so any failure here just means the frontend keeps showing the
// generic version — nothing about the diagnosis itself depends on it.
app.post('/api/diagnose/animate', requireAuth, aiLimiter, async function (req, res) {
  const { requestType, equipment, faultType, applicationImpact, trainingType, description, diagnosis, language } = req.body;

  if (!description || !diagnosis) {
    return res.status(400).json({ error: 'Missing description or diagnosis.' });
  }

  const brief =
    'You write short step captions for a fixed 5-step field-service resolution guide shown to a technician. ' +
    'The five steps are always, in this exact order: Prepare, Inspect, Test, Resolve, Confirm. ' +
    'You are NOT describing the internal mechanics of the equipment and must not claim to show what is ' +
    'physically happening inside it — you are giving practical, generic guidance for that step, phrased to fit ' +
    'this specific report.';

  let context =
    'Request type: ' + (requestType || 'fault') + '\n' +
    'Equipment: ' + (equipment || 'not specified') + '\n';

  if (faultType) {
    context += 'Fault category: ' + faultType + '\n';
  }
  if (applicationImpact) {
    context += 'Affected area: ' + applicationImpact + '\n';
  }
  if (trainingType) {
    context += 'Training type: ' + trainingType + '\n';
  }

  const knowledgeNotes = getEquipmentKnowledge(equipment, [description, diagnosis, faultType, applicationImpact].filter(Boolean).join(' '));
  const knowledgeBlock = knowledgeNotes.length
    ? '\n\nBackground on this equipment\'s common failure patterns (use this to make the captions more specific — do not quote it back):\n' +
      knowledgeNotes.map(function (note, i) { return (i + 1) + '. ' + note; }).join('\n') + '\n'
    : '';

  const prompt = brief + '\n\n' +
    context +
    'Reported: ' + description + '\n\n' +
    'Diagnosis given: ' + diagnosis + '\n' +
    knowledgeBlock + '\n' +
    'Reply with ONLY a JSON array of exactly 5 strings, one caption per step in the fixed order ' +
    '[Prepare, Inspect, Test, Resolve, Confirm]. Each caption must be a single sentence, under 22 words, ' +
    'plain prose with no Markdown, no step name prefix, no numbering. ' +
    'No text before or after the JSON array.' + languageInstruction(language);

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    });

    const raw = extractText(message).trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

    if (!Array.isArray(parsed) || parsed.length !== 5 || !parsed.every(function (s) { return typeof s === 'string' && s.trim().length > 0; })) {
      throw new Error('Malformed tailored step response');
    }

    res.json({ details: parsed.map(function (s) { return s.trim(); }) });
  } catch (err) {
    console.error('Diagnosis animation error:', err.message);
    res.status(500).json({ error: 'Tailored resolution guide unavailable.' });
  }
});

// Shared by /api/chat (web "Ask AI" page) and the WhatsApp default
// conversation mode, so a question gets the same system prompt and the
// same model behavior regardless of which channel it arrived on.
async function runChat(messages, language) {
  const systemPrompt =
    'You are Tervexa, assisting field service engineers, technicians and application specialists ' +
    'across engineering and non-engineering fields. Answer practically and concisely. ' +
    'Ask a clarifying question if the request is ambiguous. Note safety precautions where they apply. ' +
    'Write in plain prose with no Markdown formatting. Keep answers under 250 words unless more detail is clearly needed.' +
    languageInstruction(language);

  const reply = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 700,
    system: systemPrompt,
    messages: messages
  });

  return extractText(reply);
}

// One shared conversation history per account (see the chatMessages table
// in db.js) — a message asked over WhatsApp shows up here too, and vice
// versa, tagged by channel so either surface can tell where it came from.
function saveChatMessage(userId, channel, role, content) {
  db.prepare('INSERT INTO chatMessages (userId, channel, role, content, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(userId, channel, role, content, new Date().toISOString());
}

function loadRecentChat(userId, limit) {
  const rows = db.prepare('SELECT role, content, channel, createdAt FROM chatMessages WHERE userId = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit);

  return rows.reverse();
}

// Lets someone explicitly wipe their own account's shared conversation
// (web + WhatsApp use the same thread — see loadRecentChat/saveChatMessage
// above) and start over. Without this there's no way to stop old context
// from being resent to the model on every new message — the chat always
// carries every past exchange forward by design (see /api/conversation
// GET above). Scoped to the requesting user only, never the whole table.
app.delete('/api/conversation', requireAuth, function (req, res) {
  try {
    db.prepare('DELETE FROM chatMessages WHERE userId = ?').run(req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Could not clear conversation history:', err.message);
    res.status(500).json({ error: 'Could not clear conversation.' });
  }
});

app.post('/api/chat', requireAuth, aiLimiter, async function (req, res) {
  const { messages, language } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided.' });
  }

  if (messages.length > 20) {
    return res.status(400).json({ error: 'Too many messages in this conversation.' });
  }

  const tooLong = messages.some(function (m) {
    return typeof m.content !== 'string' || m.content.length > 4000;
  });

  if (tooLong) {
    return res.status(400).json({ error: 'One of the messages is invalid or too long.' });
  }

  try {
    const replyText = await runChat(messages, language);

    // The client resends the whole recent history on every call (so the
    // model has context), but only the newest question is actually new —
    // saving the full array each time would duplicate every earlier turn.
    const newestQuestion = messages[messages.length - 1];
    saveChatMessage(req.session.userId, 'web', 'user', newestQuestion.content);
    saveChatMessage(req.session.userId, 'web', 'assistant', replyText);

    res.json({ reply: replyText });
  } catch (err) {
    console.error('Chat error:', err.message);
    // A refusal isn't an outage — the model looked at this specific
    // message and declined to answer it, which is different from the
    // service being down. Flagging it lets the frontend show something
    // more accurate than "couldn't reach the assistant" (see
    // common.assistantCouldNotRespond in js/i18n.js).
    if (err.isRefusal) {
      return res.status(422).json({ error: 'The assistant could not respond to that message.', refusal: true });
    }
    res.status(500).json({ error: 'Chat service unavailable.' });
  }
});

// A small, shared label dictionary so an exported file reads the same way
// the fault log table does, rather than showing raw option values like
// "after-sales" or "component-failure". Kept in sync with prettyLabel() in
// js/main.js by hand — there's no shared module between frontend and
// backend to hang a single copy off of.
const EXPORT_LABELS = {
  electrical: 'Electrical', mechanical: 'Mechanical', electronic: 'Electronic and instrumentation',
  hvac: 'HVAC and refrigeration', software: 'Software and controls', structural: 'Structural and civil',
  biomedical: 'Biomedical', other: 'Other', critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
  fault: 'Fault', installation: 'Installation', 'after-sales': 'After-sales', application: 'Application',
  training: 'Training',
  'under-1-month': 'Under 1 month', '1-6-months': '1 to 6 months', '6-12-months': '6 to 12 months',
  '1-3-years': '1 to 3 years', 'over-3-years': 'Over 3 years', 'under-warranty': 'Under warranty',
  'service-contract': 'Under service contract', expired: 'Expired', unknown: 'Not known',
  'pre-site': 'Pre-site survey', delivery: 'Delivery and unpacking', assembly: 'Assembly and positioning',
  connection: 'Power, water or network connection', calibration: 'Calibration and verification',
  handover: 'Handover and sign-off', 'output-quality': 'Output or result quality', throughput: 'Throughput or speed',
  contamination: 'Contamination or carryover', 'calibration-drift': 'Calibration or accuracy drift',
  'user-technique': 'User technique or workflow', consumables: 'Consumables or reagents',
  'first-time': 'First time observed', intermittent: 'Intermittent', consistent: 'Happens consistently',
  consumable: 'Consumable or reagent', worsening: 'Getting worse over time', 'component-failure': 'Component failure',
  wear: 'Normal wear', 'installation-error': 'Installation or setup error', 'user-error': 'User or operator error',
  'power-supply': 'Power supply or environment', 'no-fault-found': 'No fault found',
  'new-install': 'New installation handover', refresher: 'Refresher training', 'new-staff': 'New staff onboarding',
  'software-update': 'Software or workflow update', operators: 'Operators', supervisors: 'Lab supervisors',
  mixed: 'Mixed group'
};

function exportLabel(value) {
  if (!value) return '';
  return EXPORT_LABELS[value] || value;
}

const EXPORT_COLUMNS = [
  { key: 'id', header: 'Report ID', width: 12 },
  { key: 'technician', header: 'Reported by', width: 20 },
  { key: 'reporterEmail', header: 'Reporter email', width: 24 },
  { key: 'equipment', header: 'Equipment ID', width: 16 },
  { key: 'location', header: 'Location', width: 18 },
  { key: 'requestTypeLabel', header: 'Request type', width: 16 },
  { key: 'typeLabel', header: 'Fault category', width: 22 },
  { key: 'severityLabel', header: 'Severity', width: 12 },
  { key: 'date', header: 'Date reported', width: 14 },
  { key: 'status', header: 'Status', width: 14 },
  { key: 'description', header: 'Description', width: 40 },
  { key: 'diagnosis', header: 'AI diagnosis', width: 40 },
  { key: 'rootCauseLabel', header: 'Root cause', width: 22 },
  { key: 'resolvedDate', header: 'Resolved date', width: 14 },
  { key: 'resolutionNotes', header: 'Resolution notes', width: 40 }
];

// Shared by every export path (bulk CSV/Excel/PDF and a single-report
// download) so a report's resolution — root cause, resolved date and the
// full resolution notes, not just a status word — always ends up in the
// download the same way it's already stored, rather than each format
// growing its own slightly different idea of "the report".
function mapReportForExport(r) {
  return {
    id: r.id,
    technician: r.technician || '',
    reporterEmail: r.reporterEmail || '',
    equipment: r.equipment || '',
    location: r.location || '',
    requestTypeLabel: exportLabel(r.requestType || 'fault'),
    typeLabel: exportLabel(r.type),
    severityLabel: exportLabel(r.severity),
    date: r.date || '',
    status: r.status || '',
    description: r.description || '',
    diagnosis: r.diagnosis || '',
    rootCauseLabel: exportLabel(r.rootCause),
    resolvedDate: r.resolvedDate || '',
    resolutionNotes: r.resolutionNotes || ''
  };
}

function reportsForExport(req) {
  // Every role allowed to export (engineer/supervisor/manager/admin) also
  // has full fault-log visibility — see exportReportsRoles / the comment
  // on viewOwnReportsOnlyRoles above — so this always pulls the whole log,
  // filtered the same way the fault log table's own status/type dropdowns
  // do, so a download matches whatever the person was just looking at.
  const status = req.query.status;
  const requestType = req.query.requestType;

  // reporterId scopes the export to one specific account's submissions —
  // used by the admin panel's "export by employee" picker. Filtering by
  // the account's numeric id (reports.userId), not the free-typed
  // "technician" name field, for the same reason reporterEmail exists at
  // all: two people can type the same name on the report form, but they
  // can't share an account, so id is the only thing that actually tells
  // them apart.
  const reporterId = req.query.reporterId ? Number(req.query.reporterId) : null;

  let rows = db.prepare(REPORTS_WITH_REPORTER_SELECT + ' WHERE reports.companyId = ? ORDER BY reports.rowid').all(req.session.companyId);

  if (reporterId) {
    rows = rows.filter(function (r) { return r.userId === reporterId; });
  }

  if (status && status !== 'all' && VALID_REPORT_STATUSES.includes(status)) {
    rows = rows.filter(function (r) { return r.status === status; });
  }

  if (requestType && requestType !== 'all' && VALID_REQUEST_TYPES.includes(requestType)) {
    rows = rows.filter(function (r) { return (r.requestType || 'fault') === requestType; });
  }

  return rows.map(mapReportForExport);
}

function csvCell(value) {
  const s = (value === null || value === undefined) ? '' : String(value);
  // Quote whenever the value could otherwise be misread — a comma, a
  // quote, or a newline embedded in a description/resolution note.
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Draws one report as a self-contained block — a header line, the request
// meta, the description, the AI diagnosis, and (when present) the full
// resolution: root cause, resolved date and the complete resolution notes.
// Used for both the bulk PDF (one block per report, back to back) and the
// single-report PDF (exactly one block) so the two never drift apart.
function drawPdfReportBlock(doc, state, row) {
  function ensureSpace(needed) {
    if (state.y + needed > state.pageBottom) {
      doc.addPage();
      state.y = doc.page.margins.top;
    }
  }

  function drawField(label, text, opts) {
    opts = opts || {};

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000');
    const labelHeight = doc.heightOfString(label, { width: state.width });
    ensureSpace(labelHeight + 4);
    doc.text(label, state.startX, state.y, { width: state.width });
    state.y += labelHeight + 2;

    doc.font(opts.italic ? 'Helvetica-Oblique' : 'Helvetica').fontSize(9).fillColor(opts.color || '#1a1a1a');
    const bodyText = text || '';
    const bodyHeight = doc.heightOfString(bodyText, { width: state.width });
    ensureSpace(bodyHeight + 10);
    doc.text(bodyText, state.startX, state.y, { width: state.width });
    state.y += bodyHeight + 12;
    doc.fillColor('#000000');
  }

  ensureSpace(20);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0b4a5c');
  doc.text(row.id + '  —  ' + (row.equipment || 'Unknown equipment'), state.startX, state.y, { width: state.width });
  state.y += 18;
  doc.fillColor('#000000');

  const reportedByText = 'Reported by ' + (row.technician || 'Unknown') + (row.reporterEmail ? ' (' + row.reporterEmail + ')' : '');
  const metaLine = [
    reportedByText,
    row.location,
    row.requestTypeLabel,
    row.typeLabel,
    row.severityLabel,
    row.date,
    'Status: ' + row.status
  ].filter(Boolean).join('   ·   ');

  doc.font('Helvetica').fontSize(8.5).fillColor('#555555');
  const metaHeight = doc.heightOfString(metaLine, { width: state.width });
  ensureSpace(metaHeight + 10);
  doc.text(metaLine, state.startX, state.y, { width: state.width });
  state.y += metaHeight + 14;
  doc.fillColor('#000000');

  drawField('Description', row.description || 'No description recorded.');
  drawField('AI diagnosis', row.diagnosis || 'No diagnosis recorded.');

  if (row.status === 'Resolved' && row.resolutionNotes) {
    const resolutionLabel = 'Resolution   ·   Root cause: ' + (row.rootCauseLabel || 'Not recorded') +
      '   ·   Resolved ' + (row.resolvedDate || 'date not recorded');
    drawField(resolutionLabel, row.resolutionNotes);
  } else {
    drawField('Resolution', 'Not yet resolved.', { italic: true, color: '#888888' });
  }

  ensureSpace(14);
  doc.moveTo(state.startX, state.y).lineTo(state.startX + state.width, state.y).strokeColor('#dddddd').stroke();
  state.y += 18;
  doc.fillColor('#000000');
}

app.get('/api/reports/export', requireAuth, requireRole(exportReportsRoles), function (req, res) {
  const format = req.query.format;

  if (!['csv', 'xlsx', 'pdf'].includes(format)) {
    return res.status(400).json({ error: 'Unsupported export format. Use csv, xlsx, or pdf.' });
  }

  // A single-report download (from the fault detail panel) is scoped by
  // id and ignores the status/requestType filters — those only apply to
  // the bulk "everything currently in the log view" export.
  const singleId = req.query.id ? String(req.query.id) : null;
  let rows;

  try {
    if (singleId) {
      const singleRecord = db.prepare(REPORTS_WITH_REPORTER_SELECT + ' WHERE reports.id = ? AND reports.companyId = ?').get(singleId, req.session.companyId);
      if (!singleRecord) {
        return res.status(404).json({ error: 'Report not found.' });
      }
      rows = [mapReportForExport(singleRecord)];
    } else {
      rows = reportsForExport(req);
    }
  } catch (err) {
    console.error('Export query failed:', err.message);
    return res.status(500).json({ error: 'Could not load reports for export.' });
  }

  // When the bulk export was scoped to one reporter (the admin panel's
  // "export by employee" picker), fold their name into the filename too —
  // otherwise a download named just "tervexa-fault-log-2026-09-01.xlsx"
  // gives no hint it's actually just one person's reports once it's sitting
  // in a Downloads folder next to the unfiltered one.
  let reporterSuffix = '';
  if (!singleId && req.query.reporterId) {
    const reporterRow = db.prepare('SELECT fullName, email FROM users WHERE id = ? AND companyId = ?').get(Number(req.query.reporterId), req.session.companyId);
    if (reporterRow) {
      const slug = (reporterRow.fullName || reporterRow.email || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (slug) {
        reporterSuffix = '-' + slug;
      }
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filenameBase = singleId
    ? 'tervexa-report-' + rows[0].id.replace(/[^a-zA-Z0-9_-]/g, '') + '-' + stamp
    : 'tervexa-fault-log' + reporterSuffix + '-' + stamp;

  if (format === 'csv') {
    let lines;

    if (singleId) {
      // One report read top to bottom, field by field, rather than a
      // one-row table nobody can read without scrolling sideways.
      lines = EXPORT_COLUMNS.map(function (c) { return csvCell(c.header) + ',' + csvCell(rows[0][c.key]); });
      lines.unshift(csvCell('Field') + ',' + csvCell('Value'));
    } else {
      const headerLine = EXPORT_COLUMNS.map(function (c) { return csvCell(c.header); }).join(',');
      lines = rows.map(function (row) {
        return EXPORT_COLUMNS.map(function (c) { return csvCell(row[c.key]); }).join(',');
      });
      lines.unshift(headerLine);
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filenameBase + '.csv"');
    // A UTF-8 BOM so this opens with correct characters in Excel on
    // Windows, which otherwise guesses the file's encoding wrong.
    res.send('﻿' + lines.join('\r\n'));
    return;
  }

  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Tervexa';
    workbook.created = new Date();

    if (singleId) {
      const sheet = workbook.addWorksheet('Fault report');
      sheet.columns = [
        { header: 'Field', key: 'field', width: 20 },
        { header: 'Value', key: 'value', width: 80 }
      ];
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4F9' } };

      EXPORT_COLUMNS.forEach(function (c) {
        const addedRow = sheet.addRow({ field: c.header, value: rows[0][c.key] });
        addedRow.getCell('value').alignment = { wrapText: true, vertical: 'top' };
      });
    } else {
      const sheet = workbook.addWorksheet('Fault log');
      sheet.columns = EXPORT_COLUMNS.map(function (c) { return { header: c.header, key: c.key, width: c.width }; });
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4F9' } };
      rows.forEach(function (row) { sheet.addRow(row); });
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filenameBase + '.xlsx"');

    workbook.xlsx.write(res).then(function () {
      res.end();
    }).catch(function (err) {
      console.error('XLSX export failed:', err.message);
      // Headers are likely already sent by the time xlsx.write() can fail
      // partway through, so just end the response rather than trying to
      // send a JSON error on top of a partial file.
      res.end();
    });
    return;
  }

  // format === 'pdf' — a readable report per block (header, description,
  // AI diagnosis, and the full resolution when there is one), not a dense
  // table, so a single download is complete on its own rather than a
  // summary that sends you back to the app for the detail.
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filenameBase + '.pdf"');

  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: singleId ? 'portrait' : 'landscape' });
  doc.pipe(res);

  const startX = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  const state = { startX: startX, width: contentWidth, pageBottom: pageBottom, y: doc.page.margins.top };

  const title = singleId ? 'Tervexa — Fault report ' + rows[0].id : 'Tervexa — Fault log export';
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#000000').text(title, startX, state.y, { width: contentWidth });
  state.y += 22;

  const subtitle = 'Generated ' + new Date().toLocaleString() + (singleId ? '' : '  ·  ' + rows.length + ' report(s)');
  doc.font('Helvetica').fontSize(9).fillColor('#666666').text(subtitle, startX, state.y, { width: contentWidth });
  state.y += 22;
  doc.fillColor('#000000');

  rows.forEach(function (row) { drawPdfReportBlock(doc, state, row); });

  doc.end();
});

// Lets a page load pull in the account's conversation history so far,
// regardless of which channel each message came in on — this is what
// makes a WhatsApp conversation visible in the web "Ask AI" page and a
// web conversation referenceable from WhatsApp.
app.get('/api/conversation', requireAuth, function (req, res) {
  try {
    const history = loadRecentChat(req.session.userId, 40);
    res.json(history);
  } catch (err) {
    console.error('Could not load conversation history:', err.message);
    res.status(500).json({ error: 'Could not load conversation history.' });
  }
});

// Shared by the web report form and the WhatsApp guided report flow, so
// both hand out IDs from the same counter instead of risking a collision
// between two separate counting schemes.
function nextReportId() {
  const bump = db.transaction(function () {
    db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run('report');
    const row = db.prepare('SELECT value FROM counters WHERE name = ?').get('report');
    return row.value;
  });

  const nextNumber = bump();
  return 'F-' + String(nextNumber).padStart(3, '0');
}

// reporterEmail is pulled from the account behind userId, not the free-typed
// "technician" name field on the report — two people can type the same
// name, but they can't share an account, so this is what actually tells
// them apart (the fault log and detail view surface it whenever a name
// collides; see renderFaultLog/showFaultDetail in main.js).
const REPORTS_WITH_REPORTER_SELECT = 'SELECT reports.*, users.email AS reporterEmail FROM reports LEFT JOIN users ON users.id = reports.userId';

app.get('/api/reports', requireAuth, function (req, res) {
  try {
    let rows;

    if (viewOwnReportsOnlyRoles.includes(req.session.role)) {
      rows = db.prepare(REPORTS_WITH_REPORTER_SELECT + ' WHERE reports.userId = ? AND reports.companyId = ? ORDER BY reports.rowid').all(req.session.userId, req.session.companyId);
    } else {
      rows = db.prepare(REPORTS_WITH_REPORTER_SELECT + ' WHERE reports.companyId = ? ORDER BY reports.rowid').all(req.session.companyId);
    }

    // Layered on top of the ownership filtering above, not instead of it —
    // a technician already sees only their own reports; this additionally
    // keeps their log to their field's request types (see
    // ROLE_REQUEST_TYPES), unless hybrid mode is on. Supervisor, manager,
    // and admin have no entry here and keep seeing every request type, by
    // design — their job is oversight/administration across every field.
    const scopedTypes = ROLE_REQUEST_TYPES[req.session.role];
    if (scopedTypes && !req.session.hybridMode) {
      rows = rows.filter(function (row) { return scopedTypes.includes(row.requestType || 'fault'); });
    }

    res.json(rows);
  } catch (err) {
    console.error('Database read error:', err.message);
    res.status(500).json({ error: 'Could not load reports.' });
  }
});

// Shared by the web report form and the WhatsApp guided report flow. r is
// the same shape either way (technician/equipment/location/description
// plus whichever request-type-specific fields apply); anything not
// supplied is stored as an empty string, matching how the web form's own
// fields behave when a section doesn't apply to the chosen request type.
function insertReport(r, userId, companyId, channel) {
  const newId = nextReportId();

  const stmt = db.prepare(`
    INSERT INTO reports (
      id, technician, equipment, location, requestType, type, severity, onset,
      installStage, equipmentModel, timeSinceInstall, warrantyStatus,
      applicationImpact, recurring, trainingType, traineeAudience,
      date, status, description, diagnosis,
      rootCause, resolutionNotes, resolvedDate, userId, companyId, channel
    ) VALUES (
      @id, @technician, @equipment, @location, @requestType, @type, @severity, @onset,
      @installStage, @equipmentModel, @timeSinceInstall, @warrantyStatus,
      @applicationImpact, @recurring, @trainingType, @traineeAudience,
      @date, @status, @description, @diagnosis,
      @rootCause, @resolutionNotes, @resolvedDate, @userId, @companyId, @channel
    )
  `);

  stmt.run({
    id: newId,
    technician: r.technician || '',
    equipment: r.equipment || '',
    location: r.location || '',
    requestType: r.requestType || 'fault',
    type: r.type || '',
    severity: r.severity || '',
    onset: r.onset || '',
    installStage: r.installStage || '',
    equipmentModel: r.equipmentModel || '',
    timeSinceInstall: r.timeSinceInstall || '',
    warrantyStatus: r.warrantyStatus || '',
    applicationImpact: r.applicationImpact || '',
    recurring: r.recurring || '',
    trainingType: r.trainingType || '',
    traineeAudience: r.traineeAudience || '',
    date: r.date || '',
    status: r.status || 'Open',
    description: r.description || '',
    diagnosis: r.diagnosis || '',
    rootCause: r.rootCause || '',
    resolutionNotes: r.resolutionNotes || '',
    resolvedDate: r.resolvedDate || '',
    userId: userId,
    companyId: companyId,
    channel: channel
  });

  return newId;
}

app.post('/api/reports', requireAuth, function (req, res, next) {
  // Not a plain requireRole(submitReportRoles) here because whether 'admin'
  // may submit depends on whether this is an individual ("Just me") account
  // — see canSubmitReports() above.
  if (canSubmitReports(req.session.role, req.session.companyId)) {
    return next();
  }

  res.status(403).json({ error: 'Your account does not have access to this.' });
}, function (req, res) {
  const r = req.body;

  if (!r) {
    return res.status(400).json({ error: 'No report data provided.' });
  }

  if (r.requestType && !VALID_REQUEST_TYPES.includes(r.requestType)) {
    return res.status(400).json({ error: 'Invalid request type.' });
  }

  // Role-scoped request types (see ROLE_REQUEST_TYPES above) — a role with
  // no entry there (only admin reaches this route unscoped, and only for an
  // individual account per canSubmitReports() above; supervisor/manager
  // can't submit at all) is never blocked here. hybridMode is the account's
  // own opt-in escape hatch for work that genuinely spans more than one
  // field.
  const scopedTypes = ROLE_REQUEST_TYPES[req.session.role];
  if (scopedTypes && !req.session.hybridMode && !scopedTypes.includes(r.requestType || 'fault')) {
    return res.status(403).json({
      error: 'That request type is outside your role\'s usual scope. Turn on hybrid mode if this job genuinely crosses into another field.',
      outsideScope: true
    });
  }

  if (!r.technician || !r.equipment || !r.location) {
    return res.status(400).json({ error: 'Technician name, equipment ID, and location are required.' });
  }

  if (!r.description || r.description.trim().length < 20) {
    return res.status(400).json({ error: 'Description must be at least 20 characters.' });
  }

  const limitCheck = checkReportLimit(req.session.companyId);
  if (!limitCheck.allowed) {
    return res.status(403).json({ error: limitCheck.message, upgradeRequired: true });
  }

  try {
    // userId and companyId are taken from the session, not the request
    // body — the client can't claim to be someone else's report, or file
    // it under a different company.
    const newId = insertReport(r, req.session.userId, req.session.companyId, 'web');
    res.json({ ok: true, id: newId, overLimit: limitCheck.overLimit });
  } catch (err) {
    console.error('Database write error:', err.message);
    res.status(500).json({ error: 'Could not save report.' });
  }
});

app.patch('/api/reports/:id', requireAuth, function (req, res) {
  const id = req.params.id;
  const r = req.body || {};

  if (r.status && !VALID_REPORT_STATUSES.includes(r.status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  if (r.status === 'Resolved' && (!r.rootCause || !r.resolutionNotes || r.resolutionNotes.trim().length < 15)) {
    return res.status(400).json({ error: 'A root cause and at least 15 characters of resolution notes are required to mark a report resolved.' });
  }

  try {
    // Company boundary first — a report belonging to a different company
    // is treated exactly like a report that doesn't exist, whatever role
    // the requester holds.
    const inCompany = db.prepare('SELECT id FROM reports WHERE id = ? AND companyId = ?').get(id, req.session.companyId);

    if (!inCompany) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    if (!editAnyReportRoles.includes(req.session.role)) {
      const owned = db.prepare('SELECT id FROM reports WHERE id = ? AND userId = ?').get(id, req.session.userId);

      if (!owned) {
        // Same 404 whether the report doesn't exist or just isn't theirs —
        // no need to confirm to a technician (or engineer, who can see
        // this report exists but not edit it) that someone else's report
        // ID is valid.
        return res.status(404).json({ error: 'Report not found.' });
      }
    }

    const stmt = db.prepare(`
      UPDATE reports SET
        status = @status,
        rootCause = @rootCause,
        resolutionNotes = @resolutionNotes,
        resolvedDate = @resolvedDate
      WHERE id = @id
    `);

    const result = stmt.run({
      id: id,
      status: r.status || 'Open',
      rootCause: r.rootCause || '',
      resolutionNotes: r.resolutionNotes || '',
      resolvedDate: r.resolvedDate || ''
    });

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    res.json({ ok: true, id: id });
  } catch (err) {
    console.error('Database update error:', err.message);
    res.status(500).json({ error: 'Could not update report.' });
  }
});

app.delete('/api/reports/:id', requireAuth, requireRole(deleteReportRoles), function (req, res) {
  const id = req.params.id;

  try {
    const result = db.prepare('DELETE FROM reports WHERE id = ? AND companyId = ?').run(id, req.session.companyId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    res.json({ ok: true, id: id });
  } catch (err) {
    console.error('Database delete error:', err.message);
    res.status(500).json({ error: 'Could not delete report.' });
  }
});

// --- Admin: account and company management -----------------------------
// Every route here is admin-only (see adminRoles / requireRole above) AND
// scoped to the admin's own companyId — an admin manages their company,
// never any other. passwordHash is never selected — the admin panel has no
// reason to touch it, and there's no reason to pull a hash into a response
// body at all.
app.get('/api/admin/users', requireAuth, requireRole(adminRoles), function (req, res) {
  try {
    const rows = db.prepare(
      'SELECT id, email, fullName, phone, company, role, active, mustChangePassword, createdAt FROM users WHERE companyId = ? ORDER BY id'
    ).all(req.session.companyId);

    res.json(rows);
  } catch (err) {
    console.error('Database read error:', err.message);
    res.status(500).json({ error: 'Could not load accounts.' });
  }
});

app.patch('/api/admin/users/:id', requireAuth, requireRole(adminRoles), function (req, res) {
  const id = Number(req.params.id);
  const body = req.body || {};

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid account id.' });
  }

  if (body.role !== undefined && !VALID_ROLES.includes(body.role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  if (body.active !== undefined && typeof body.active !== 'boolean') {
    return res.status(400).json({ error: 'Invalid active value.' });
  }

  try {
    const target = db.prepare('SELECT id, email, role, active, companyId FROM users WHERE id = ?').get(id);

    // Same 404 whether the account doesn't exist or belongs to a different
    // company — an admin has no way to even confirm another company's
    // account ID is real.
    if (!target || target.companyId !== req.session.companyId) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const nextRole = body.role !== undefined ? body.role : target.role;
    const nextActive = body.active !== undefined ? (body.active ? 1 : 0) : target.active;

    // Refuse a change that would leave zero active administrators IN THIS
    // COMPANY — that's an unrecoverable lockout (nobody left who can open
    // this company's admin panel to undo it). An admin can still demote or
    // deactivate themself as long as at least one other active admin at
    // the same company remains; other companies' admin counts are
    // irrelevant here.
    const wasActiveAdmin = target.role === 'admin' && target.active !== 0;
    const staysActiveAdmin = nextRole === 'admin' && nextActive !== 0;

    if (wasActiveAdmin && !staysActiveAdmin) {
      const otherActiveAdmins = db.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1 AND companyId = ? AND id != ?"
      ).get(req.session.companyId, id).count;

      if (otherActiveAdmins === 0) {
        return res.status(400).json({ error: 'This is the only active administrator account. Promote or reactivate another admin first.' });
      }
    }

    // Reactivating a deactivated account grows the active-seat count just
    // like adding a new one does, so it's subject to the same seat limit.
    if (nextActive === 1 && target.active === 0) {
      const seatCheck = checkSeatLimit(req.session.companyId);
      if (!seatCheck.allowed) {
        return res.status(403).json({ error: seatCheck.message, upgradeRequired: true });
      }
    }

    db.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').run(nextRole, nextActive, id);

    const actor = { id: req.session.userId, email: req.session.email };

    if (nextRole !== target.role) {
      logAudit(req.session.companyId, actor, 'role_changed', target, target.role + ' → ' + nextRole);
    }
    if (Boolean(nextActive) !== Boolean(target.active)) {
      logAudit(req.session.companyId, actor, nextActive ? 'account_activated' : 'account_deactivated', target, '');
    }

    res.json({ ok: true, id: id, role: nextRole, active: Boolean(nextActive) });
  } catch (err) {
    console.error('Database update error:', err.message);
    res.status(500).json({ error: 'Could not update account.' });
  }
});

// Lets an admin add an employee directly rather than sharing the invite
// code — the admin picks name/email/role, the server picks a temporary
// password and hands it back once (mustChangePassword forces the employee
// to replace it with one of their own on first login).
app.post('/api/admin/users', requireAuth, requireRole(adminRoles), async function (req, res) {
  const { fullName, phone, email, role } = req.body || {};

  if (!fullName || !fullName.trim()) {
    return res.status(400).json({ error: 'Full name is required.' });
  }

  if (!email || !EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Select a role.' });
  }

  const seatCheck = checkSeatLimit(req.session.companyId);
  if (!seatCheck.allowed) {
    return res.status(403).json({ error: seatCheck.message, upgradeRequired: true });
  }

  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());

    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const phoneNormalized = phone ? normalizePhone(phone) : '';

    if (phoneNormalized) {
      const existingPhone = db.prepare('SELECT id FROM users WHERE phoneNormalized = ?').get(phoneNormalized);
      if (existingPhone) {
        return res.status(409).json({ error: 'An account with that phone number already exists.' });
      }
    }

    const companyRow = db.prepare('SELECT name FROM companies WHERE id = ?').get(req.session.companyId);
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const now = new Date().toISOString();

    const result = db.prepare(`
      INSERT INTO users (
        email, passwordHash, fullName, phone, phoneNormalized, company, role, companyId,
        mustChangePassword, createdAt, termsAcceptedAt, disclaimerAcceptedAt, preferredLanguage
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      email.toLowerCase(),
      passwordHash,
      fullName.trim(),
      phone || '',
      phoneNormalized,
      companyRow ? companyRow.name : '',
      role,
      req.session.companyId,
      now,
      // An admin added this account on the employee's behalf — there's no
      // separate consent step for them to click through, so this records
      // when the account was created rather than a real acceptance
      // timestamp from the employee themselves.
      now,
      now,
      req.session.preferredLanguage || 'en'
    );

    logAudit(
      req.session.companyId,
      { id: req.session.userId, email: req.session.email },
      'employee_added',
      { id: result.lastInsertRowid, email: email.toLowerCase() },
      'role: ' + role
    );

    res.json({
      ok: true,
      id: result.lastInsertRowid,
      email: email.toLowerCase(),
      fullName: fullName.trim(),
      role: role,
      tempPassword: tempPassword,
      overLimit: seatCheck.overLimit
    });
  } catch (err) {
    console.error('Add employee error:', err.message);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

// The admin panel's "your company" section — name, invite code, plan tier,
// and current usage against that tier's limits (seats, reports this
// month). Usage is informational only right now — see PLAN_TIERS above —
// nothing here blocks anyone, it just gives the admin (and, later, the
// billing flow) real numbers to work from.
app.get('/api/admin/company', requireAuth, requireRole(adminRoles), function (req, res) {
  try {
    const companyRow = db.prepare('SELECT id, name, inviteCode, planTier, isIndividual, trialEndsAt FROM companies WHERE id = ?').get(req.session.companyId);

    if (!companyRow) {
      return res.status(404).json({ error: 'Company not found.' });
    }

    const planTier = companyRow.planTier || 'free';
    const limits = effectiveLimitsFor(companyRow);
    const trial = trialStatusFor(companyRow);

    const seatCount = db.prepare('SELECT COUNT(*) AS count FROM users WHERE companyId = ? AND active = 1').get(req.session.companyId).count;

    // "This month" by calendar month in the report's own `date` field
    // (YYYY-MM-DD, same as everywhere else reports are filtered), not a
    // rolling 30 days — matches how a billing cycle would normally reset.
    const monthPrefix = new Date().toISOString().slice(0, 7);
    const reportsThisMonth = db.prepare(
      "SELECT COUNT(*) AS count FROM reports WHERE companyId = ? AND date LIKE ?"
    ).get(req.session.companyId, monthPrefix + '%').count;

    res.json({
      name: companyRow.name,
      inviteCode: companyRow.inviteCode,
      planTier: planTier,
      planLabel: limits.label,
      seatLimit: limits.seatLimit,
      monthlyReportLimit: limits.monthlyReportLimit,
      exportFormats: limits.exportFormats,
      adminAddedEmployees: limits.adminAddedEmployees,
      auditLogIncluded: limits.auditLog,
      isIndividual: Boolean(companyRow.isIndividual),
      onTrial: trial.onTrial,
      trialExpired: trial.expired,
      trialEndsAt: trial.trialEndsAt,
      usage: {
        seatCount: seatCount,
        reportsThisMonth: reportsThisMonth
      }
    });
  } catch (err) {
    console.error('Database read error:', err.message);
    res.status(500).json({ error: 'Could not load company details.' });
  }
});

// Last 50 sensitive account-management actions for this admin's company
// (see logAudit / auditLog table) — role changes, activate/deactivate, an
// employee added directly, invite code regeneration. Newest first.
app.get('/api/admin/audit-log', requireAuth, requireRole(adminRoles), function (req, res) {
  try {
    const rows = db.prepare(
      'SELECT id, actorEmail, action, targetEmail, details, createdAt FROM auditLog WHERE companyId = ? ORDER BY id DESC LIMIT 50'
    ).all(req.session.companyId);

    res.json(rows);
  } catch (err) {
    console.error('Database read error:', err.message);
    res.status(500).json({ error: 'Could not load activity log.' });
  }
});

// Invalidates the old invite code and issues a new one — for when a code
// has been shared more widely than intended.
app.post('/api/admin/company/invite-code', requireAuth, requireRole(adminRoles), function (req, res) {
  try {
    const newCode = generateUniqueInviteCode();
    db.prepare('UPDATE companies SET inviteCode = ? WHERE id = ?').run(newCode, req.session.companyId);
    logAudit(
      req.session.companyId,
      { id: req.session.userId, email: req.session.email },
      'invite_code_regenerated',
      null,
      ''
    );
    res.json({ ok: true, inviteCode: newCode });
  } catch (err) {
    console.error('Invite code regeneration error:', err.message);
    res.status(500).json({ error: 'Could not generate a new invite code.' });
  }
});

// --- Billing / subscriptions -----------------------------------------
// Three providers (Paystack, Flutterwave, Stripe — see payments/), one
// hosted-checkout-redirect flow for all of them: the admin picks a plan
// and a provider, we create/reuse that provider's Plan or Price object,
// start a checkout session, and hand back a URL to redirect the browser
// to. No card details ever pass through this server. The actual upgrade
// happens when the provider calls one of the /api/webhooks/* routes
// below — the checkout redirect back to billing.html is just a "nice,
// you're on your way" landing, not what confirms payment.

// Which plans exist to buy, with pricing in every currency a configured
// provider might charge in, plus which providers are actually usable
// right now (a provider with no secret key set just doesn't appear —
// same "left unset, still runs" pattern as the WhatsApp integration).
app.get('/api/billing/plans', requireAuth, requireRole(adminRoles), function (req, res) {
  const companyRow = db.prepare('SELECT isIndividual FROM companies WHERE id = ?').get(req.session.companyId);
  const accountType = accountTypeFor(companyRow);

  // An individual account never sees an Enterprise card at all — Pro
  // already gives it every feature Enterprise would (see the comment on
  // PLAN_PRICING in payments/config.js), so there's nothing to sell it
  // that isn't just Pro under a pricier name.
  const availableTiers = accountType === 'individual' ? ['pro'] : ['pro', 'enterprise'];

  const tiers = availableTiers.map(function (planTier) {
    const limits = planLimitsFor(planTier);
    // The raw tier definition's seatLimit (Pro's 20) is a company number —
    // an individual account is always 1 seat, on any tier it can actually
    // buy, so the plan card has to show that instead of the tier's normal
    // number (see effectiveLimitsFor()).
    const seatLimit = accountType === 'individual' ? 1 : limits.seatLimit;
    return {
      planTier: planTier,
      label: limits.label,
      seatLimit: seatLimit,
      monthlyReportLimit: limits.monthlyReportLimit,
      exportFormats: limits.exportFormats,
      pricing: {
        ngn: { monthly: payments.priceFor(accountType, planTier, 'monthly', 'ngn'), annual: payments.priceFor(accountType, planTier, 'annual', 'ngn') },
        usd: { monthly: payments.priceFor(accountType, planTier, 'monthly', 'usd'), annual: payments.priceFor(accountType, planTier, 'annual', 'usd') }
      }
    };
  });

  res.json({
    tiers: tiers,
    availableProviders: payments.availableProviders()
  });
});

// The admin panel's billing status — current plan, cycle, renewal date,
// and whether a cancellation is already pending.
app.get('/api/billing/status', requireAuth, requireRole(adminRoles), function (req, res) {
  try {
    const companyRow = db.prepare(
      'SELECT planTier, billingCycle, subscriptionStatus, subscriptionProvider, currentPeriodEnd, pendingCancellation, isIndividual, trialEndsAt FROM companies WHERE id = ?'
    ).get(req.session.companyId);

    if (!companyRow) {
      return res.status(404).json({ error: 'Company not found.' });
    }

    const limits = effectiveLimitsFor(companyRow);
    const trial = trialStatusFor(companyRow);

    res.json({
      planTier: companyRow.planTier || 'free',
      planLabel: limits.label,
      billingCycle: companyRow.billingCycle,
      subscriptionStatus: companyRow.subscriptionStatus,
      subscriptionProvider: companyRow.subscriptionProvider,
      currentPeriodEnd: companyRow.currentPeriodEnd,
      pendingCancellation: Boolean(companyRow.pendingCancellation),
      isIndividual: Boolean(companyRow.isIndividual),
      seatLimit: limits.seatLimit,
      monthlyReportLimit: limits.monthlyReportLimit,
      onTrial: trial.onTrial,
      trialExpired: trial.expired,
      trialEndsAt: trial.trialEndsAt
    });
  } catch (err) {
    console.error('Database read error:', err.message);
    res.status(500).json({ error: 'Could not load billing status.' });
  }
});

// Starts a checkout: creates (or reuses) the provider-side Plan/Price,
// opens a checkout session against it, and hands back the URL to
// redirect the browser to. Nothing in our own database changes yet — a
// pending transaction row is written so the eventual webhook has
// something to match against, but the company's planTier only moves once
// the webhook confirms the payment actually went through.
app.post('/api/billing/checkout', requireAuth, requireRole(adminRoles), async function (req, res) {
  const { planTier, billingCycle, provider } = req.body || {};

  if (!['pro', 'enterprise'].includes(planTier)) {
    return res.status(400).json({ error: 'Choose a plan to upgrade to.' });
  }
  if (!['monthly', 'annual'].includes(billingCycle)) {
    return res.status(400).json({ error: 'Choose monthly or annual billing.' });
  }

  const providerModule = payments.getProvider(provider);
  if (!providerModule || !providerModule.configured()) {
    return res.status(400).json({ error: 'That payment method is not available right now.' });
  }

  try {
    const company = db.prepare('SELECT id, name, isIndividual FROM companies WHERE id = ?').get(req.session.companyId);
    if (!company) {
      return res.status(404).json({ error: 'Company not found.' });
    }

    const accountType = accountTypeFor(company);

    // An individual account can't buy Enterprise — there's no such plan
    // for it (see the PLAN_PRICING comment in payments/config.js). This
    // mirrors what GET /api/billing/plans already never offers it, but a
    // direct API call still needs its own server-side check.
    if (accountType === 'individual' && planTier === 'enterprise') {
      return res.status(400).json({ error: 'Enterprise is not available on an individual account — Pro already includes every feature.' });
    }

    const currency = payments.PROVIDER_CURRENCY[provider];
    const amount = payments.priceFor(accountType, planTier, billingCycle, currency);
    if (!amount) {
      return res.status(400).json({ error: 'Could not price that plan.' });
    }

    const reference = 'txn_' + crypto.randomBytes(12).toString('hex');
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO transactions (companyId, provider, providerReference, planTier, billingCycle, amount, currency, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(company.id, provider, reference, planTier, billingCycle, amount, currency, now);

    const origin = req.protocol + '://' + req.get('host');
    const session = await providerModule.createCheckoutSession({
      company: company,
      planTier: planTier,
      planLabel: planLimitsFor(planTier).label,
      billingCycle: billingCycle,
      amount: amount,
      adminEmail: req.session.email,
      reference: reference,
      successUrl: origin + '/billing.html?checkout=success',
      cancelUrl: origin + '/billing.html?checkout=cancelled'
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Checkout creation error:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// Cancels immediately (not "at period end") — the company drops back to
// the free tier as soon as the provider confirms the cancellation. This
// is a deliberate simplification over the more common "keep paid access
// until the period you already paid for runs out": simpler to reason
// about and to build without a scheduled-downgrade job, at the cost of
// not refunding/prorating the unused remainder of the current period.
app.post('/api/billing/cancel', requireAuth, requireRole(adminRoles), async function (req, res) {
  try {
    const company = db.prepare(
      'SELECT id, name, subscriptionProvider, subscriptionRef, subscriptionMeta FROM companies WHERE id = ?'
    ).get(req.session.companyId);

    if (!company || !company.subscriptionProvider || !company.subscriptionRef) {
      return res.status(400).json({ error: 'There is no active paid subscription to cancel.' });
    }

    const providerModule = payments.getProvider(company.subscriptionProvider);
    if (!providerModule) {
      return res.status(400).json({ error: 'Unknown payment provider on file for this company.' });
    }

    await providerModule.cancelSubscription({
      id: company.id,
      subscriptionRef: company.subscriptionRef,
      subscriptionMeta: company.subscriptionMeta,
      adminEmail: req.session.email
    });

    db.prepare(
      "UPDATE companies SET planTier = 'free', billingCycle = NULL, subscriptionStatus = 'canceled', pendingCancellation = 0 WHERE id = ?"
    ).run(company.id);

    logAudit(
      company.id,
      { id: req.session.userId, email: req.session.email },
      'plan_canceled',
      null,
      'was ' + company.subscriptionProvider
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Subscription cancellation error:', err.message);
    res.status(500).json({ error: 'Could not cancel the subscription. Please try again, or contact support.' });
  }
});

// One webhook route per provider — each verifies its own signature
// scheme against the raw request body (see req.rawBody, captured by the
// express.json() verify callback above) before trusting anything in the
// payload. Always responds quickly, per every provider's own advice:
// an unexpected error in the handling logic still returns 200 rather
// than making the provider hammer retries for a bug that a retry can't
// fix — the error is logged server-side for us to catch instead.
function handleWebhook(providerName) {
  return async function (req, res) {
    const providerModule = payments.getProvider(providerName);

    if (!providerModule || !providerModule.configured() || !providerModule.verifySignature(req)) {
      return res.status(400).json({ error: 'Invalid signature.' });
    }

    let event;
    try {
      event = providerModule.parseWebhookEvent(req.body);
    } catch (err) {
      console.error(providerName + ' webhook parse error:', err.message);
      return res.status(200).json({ received: true });
    }

    if (!event) {
      // A real, validly-signed event we simply don't act on (a payout
      // notification, a refund, etc.) — still a success as far as the
      // provider is concerned.
      return res.status(200).json({ received: true });
    }

    try {
      const already = db.prepare(
        'SELECT id FROM processedWebhookEvents WHERE provider = ? AND eventId = ?'
      ).get(providerName, event.eventId);

      if (already) {
        return res.status(200).json({ received: true });
      }

      db.prepare(
        'INSERT INTO processedWebhookEvents (provider, eventId, processedAt) VALUES (?, ?, ?)'
      ).run(providerName, event.eventId, new Date().toISOString());

      if (event.kind === 'payment_success') {
        handlePaymentSuccess(providerName, event);
      } else if (event.kind === 'subscription_linked') {
        handleSubscriptionLinked(providerName, event);
      } else if (event.kind === 'subscription_canceled') {
        handleSubscriptionCanceled(providerName, event);
      } else if (event.kind === 'payment_failed') {
        handlePaymentFailed(providerName, event);
      }
    } catch (err) {
      console.error(providerName + ' webhook handling error:', err.message);
    }

    res.status(200).json({ received: true });
  };
}

function resolveCompanyIdForEvent(event) {
  if (event.companyId) {
    const asNumber = Number(event.companyId);
    if (asNumber) {
      return asNumber;
    }
  }

  if (event.reference) {
    const txn = db.prepare('SELECT companyId FROM transactions WHERE providerReference = ?').get(event.reference);
    if (txn) {
      return txn.companyId;
    }
  }

  if (event.customerEmail) {
    const admin = db.prepare(
      "SELECT companyId FROM users WHERE email = ? AND role = 'admin'"
    ).get(event.customerEmail.toLowerCase());
    if (admin) {
      return admin.companyId;
    }
  }

  return null;
}

function handlePaymentSuccess(providerName, event) {
  const companyId = resolveCompanyIdForEvent(event);
  if (!companyId) {
    console.error(providerName + ' webhook: could not resolve a company for a successful payment. Reference:', event.reference);
    return;
  }

  const company = db.prepare('SELECT planTier, billingCycle FROM companies WHERE id = ?').get(companyId);
  if (!company) {
    return;
  }

  const planTier = event.planTier || company.planTier;
  const billingCycle = event.billingCycle || company.billingCycle || 'monthly';
  const now = new Date();
  const periodEnd = new Date(now);
  if (billingCycle === 'annual') {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  const planChanged = company.planTier !== planTier;

  const updateFields = ['planTier = ?', 'billingCycle = ?', "subscriptionStatus = 'active'", 'subscriptionProvider = ?', 'currentPeriodEnd = ?', 'pendingCancellation = 0'];
  const updateValues = [planTier, billingCycle, providerName, periodEnd.toISOString()];

  if (event.subscriptionRef) {
    updateFields.push('subscriptionRef = ?');
    updateValues.push(event.subscriptionRef);
  }

  updateValues.push(companyId);
  db.prepare('UPDATE companies SET ' + updateFields.join(', ') + ' WHERE id = ?').run(...updateValues);

  if (event.reference) {
    const updated = db.prepare(
      "UPDATE transactions SET status = 'success' WHERE providerReference = ? AND status = 'pending'"
    ).run(event.reference);

    if (updated.changes === 0) {
      // A renewal cycle has no matching pending row (it wasn't started
      // from our checkout flow) — record it as its own transaction.
      db.prepare(`
        INSERT INTO transactions (companyId, provider, providerReference, planTier, billingCycle, amount, currency, status, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?)
      `).run(companyId, providerName, event.reference, planTier, billingCycle, event.amount || 0, event.currency || 'ngn', now.toISOString());
    }
  }

  if (planChanged) {
    const admin = db.prepare("SELECT id, email FROM users WHERE companyId = ? AND role = 'admin' LIMIT 1").get(companyId);
    logAudit(companyId, admin || null, 'plan_upgraded', null, planTier + ' (' + billingCycle + ', via ' + providerName + ')');
  }
}

// Paystack-only: subscription.create fires as a companion event to
// charge.success but doesn't carry our metadata, so it's matched to a
// company by admin email instead — see payments/paystack.js.
function handleSubscriptionLinked(providerName, event) {
  if (!event.customerEmail) {
    return;
  }
  const admin = db.prepare("SELECT companyId FROM users WHERE email = ? AND role = 'admin'").get(event.customerEmail.toLowerCase());
  if (!admin) {
    return;
  }

  const meta = event.subscriptionEmailToken ? JSON.stringify({ emailToken: event.subscriptionEmailToken }) : null;

  db.prepare(
    'UPDATE companies SET subscriptionRef = ?, subscriptionMeta = COALESCE(?, subscriptionMeta) WHERE id = ?'
  ).run(event.subscriptionRef, meta, admin.companyId);
}

function handleSubscriptionCanceled(providerName, event) {
  if (!event.subscriptionRef) {
    return;
  }
  const company = db.prepare(
    'SELECT id FROM companies WHERE subscriptionRef = ? AND subscriptionProvider = ?'
  ).get(event.subscriptionRef, providerName);
  if (!company) {
    return;
  }

  db.prepare(
    "UPDATE companies SET planTier = 'free', billingCycle = NULL, subscriptionStatus = 'canceled', pendingCancellation = 0 WHERE id = ?"
  ).run(company.id);

  const admin = db.prepare("SELECT id, email FROM users WHERE companyId = ? AND role = 'admin' LIMIT 1").get(company.id);
  logAudit(company.id, admin || null, 'plan_canceled', null, 'via ' + providerName + ' webhook');
}

function handlePaymentFailed(providerName, event) {
  if (!event.subscriptionRef) {
    return;
  }
  db.prepare(
    "UPDATE companies SET subscriptionStatus = 'past_due' WHERE subscriptionRef = ? AND subscriptionProvider = ?"
  ).run(event.subscriptionRef, providerName);
}

app.post('/api/webhooks/paystack', handleWebhook('paystack'));
app.post('/api/webhooks/flutterwave', handleWebhook('flutterwave'));
app.post('/api/webhooks/stripe', handleWebhook('stripe'));

// Signup is one of three modes: 'create' (a brand new company, the signer
// becomes its admin — the only path to the admin role), 'join' (an existing
// company via invite code, any role except admin), or 'individual' (a
// company of one, created automatically with no company name or invite code
// ever shown to the person — they just get an account). Under the hood an
// individual signup is really the same thing as 'create': it's still a
// companyId-scoped tenant with its own invite code, so if that person ever
// wants to bring someone else on, they can invite them from the admin panel
// without anything having to change.
app.post('/api/signup', authLimiter, async function (req, res) {
  const {
    mode, email, password, fullName, phone,
    companyName, inviteCode, role,
    termsAccepted, disclaimerAccepted, preferredLanguage
  } = req.body;

  // Carries over whatever language someone already had selected while
  // browsing the public pages before they signed up, so the account
  // doesn't reset to English the moment it's created. Falls back to
  // English for anything unrecognized.
  const initialLanguage = (preferredLanguage && LANGUAGE_NAMES[preferredLanguage]) ? preferredLanguage : 'en';

  if (mode !== 'create' && mode !== 'join' && mode !== 'individual') {
    return res.status(400).json({ error: 'Choose whether you are creating a new company, joining one with an invite code, or signing up as an individual.' });
  }

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const pwError = passwordError(password);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }

  if (mode === 'create' && (!companyName || !companyName.trim())) {
    return res.status(400).json({ error: 'Enter a company name.' });
  }

  let joinCompany = null;

  if (mode === 'join') {
    if (!inviteCode || !inviteCode.trim()) {
      return res.status(400).json({ error: 'Enter your company invite code.' });
    }

    if (!role || !JOIN_SIGNUP_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Select your role.' });
    }

    joinCompany = db.prepare('SELECT id, name FROM companies WHERE inviteCode = ?').get(inviteCode.trim().toUpperCase());

    if (!joinCompany) {
      return res.status(400).json({ error: "That invite code isn't valid. Check it with your company administrator." });
    }

    const seatCheck = checkSeatLimit(joinCompany.id);
    if (!seatCheck.allowed) {
      return res.status(403).json({ error: "This company's plan is full and can't add another teammate right now. Ask your company admin to upgrade the plan." });
    }
  }

  // The checkboxes are already required in the HTML, so this only ever
  // fires against a direct API call that skips the form — but it means
  // there's no path to an account that doesn't have real consent behind
  // it.
  if (!termsAccepted || !disclaimerAccepted) {
    return res.status(400).json({ error: 'You must agree to the Terms and the AI-diagnosis disclaimer to create an account.' });
  }

  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());

    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const phoneNormalized = phone ? normalizePhone(phone) : '';

    if (phoneNormalized) {
      // Matching on the normalized form catches "0801..." and "+234801..."
      // as the same number, not just byte-for-byte identical strings.
      const existingPhone = db.prepare('SELECT id FROM users WHERE phoneNormalized = ?').get(phoneNormalized);

      if (existingPhone) {
        return res.status(409).json({ error: 'An account with that phone number already exists.' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    const finalRole = mode === 'join' ? role : 'admin';

    // Creating the company and the account that owns it happens in one
    // transaction — never left with a company row and no admin, or an admin
    // account pointing at a company that doesn't exist.
    const createUser = db.transaction(function () {
      let companyId;
      let companyDisplayName;

      if (mode === 'create') {
        const newInviteCode = generateUniqueInviteCode();
        const trialEndsAt = trialEndsAtFor(TRIAL_DAYS, now);
        const companyResult = db.prepare(
          "INSERT INTO companies (name, inviteCode, planTier, createdAt, isIndividual, trialEndsAt) VALUES (?, ?, 'free', ?, 0, ?)"
        ).run(companyName.trim(), newInviteCode, now, trialEndsAt);
        companyId = companyResult.lastInsertRowid;
        companyDisplayName = companyName.trim();
      } else if (mode === 'individual') {
        // A real company row all the same — just named after the person
        // and never surfaced as a "company name" field on the form. Gets
        // its own invite code too, so nothing special has to happen later
        // if this person ever wants to add a teammate. isIndividual is what
        // gives it the tighter 1-seat free cap (see effectiveLimitsFor in
        // the PLAN_TIERS section above) — the trial length itself is the
        // same 14 days as a company account.
        const newInviteCode = generateUniqueInviteCode();
        const soloName = (fullName && fullName.trim()) ? fullName.trim() : 'Individual account';
        const trialEndsAt = trialEndsAtFor(TRIAL_DAYS, now);
        const companyResult = db.prepare(
          "INSERT INTO companies (name, inviteCode, planTier, createdAt, isIndividual, trialEndsAt) VALUES (?, ?, 'free', ?, 1, ?)"
        ).run(soloName, newInviteCode, now, trialEndsAt);
        companyId = companyResult.lastInsertRowid;
        companyDisplayName = soloName;
      } else {
        companyId = joinCompany.id;
        companyDisplayName = joinCompany.name;
      }

      const userResult = db.prepare(`
        INSERT INTO users (
          email, passwordHash, fullName, phone, phoneNormalized, company, role, companyId,
          createdAt, termsAcceptedAt, disclaimerAcceptedAt, preferredLanguage
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        email.toLowerCase(),
        passwordHash,
        fullName || '',
        phone || '',
        phoneNormalized,
        companyDisplayName,
        finalRole,
        companyId,
        now,
        now,
        now,
        initialLanguage
      );

      return { userId: userResult.lastInsertRowid, companyId: companyId, companyName: companyDisplayName };
    });

    const created = createUser();

    req.session.userId = created.userId;
    req.session.email = email.toLowerCase();
    req.session.fullName = fullName || '';
    req.session.role = finalRole;
    req.session.companyId = created.companyId;
    req.session.preferredLanguage = initialLanguage;
    req.session.hybridMode = false;

    res.json({
      ok: true,
      email: email.toLowerCase(),
      fullName: fullName || '',
      role: finalRole,
      companyName: created.companyName,
      preferredLanguage: initialLanguage
    });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/login', authLimiter, async function (req, res) {
  const { email, password, rememberMe } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());

    if (!user) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);

    if (!match) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    if (user.active === 0) {
      return res.status(403).json({ error: 'This account has been deactivated. Contact an administrator.' });
    }

    // An account the admin panel created directly comes with a temporary
    // password the admin picked — this is proof the person actually knows
    // that temporary password, but not a real login yet. Send them straight
    // to the same "set a new password" flow a forgotten-password reset
    // uses, instead of establishing a normal session, so nobody ends up
    // using an admin-assigned password indefinitely.
    if (user.mustChangePassword) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 1000 * 60 * 30).toISOString();

      db.prepare('INSERT INTO passwordResets (token, userId, expiresAt, used, createdAt) VALUES (?, ?, ?, 0, ?)')
        .run(token, user.id, expiresAt, new Date().toISOString());

      return res.json({ ok: true, mustChangePassword: true, resetUrl: 'new-password.html?token=' + token });
    }

    // Regenerating the session on login gives this login a brand new
    // session ID (and forces a fresh Set-Cookie to actually reach the
    // browser) instead of reusing whatever session — and whatever cookie
    // lifetime — happened to already be attached to this browser. Without
    // this, someone who previously logged in with "remember me" checked,
    // then logs in again on the same browser WITHOUT it checked, would
    // keep the old 30-day cookie: the server would think nothing about
    // the cookie needed to change, since it never issues a new one for a
    // session it already recognizes. Regenerating also closes off session
    // fixation — a stale or guessed session ID can't be reused to inherit
    // someone else's freshly-authenticated session.
    req.session.regenerate(function (err) {
      if (err) {
        console.error('Login error (session regenerate):', err.message);
        return res.status(500).json({ error: 'Could not log in.' });
      }

      req.session.userId = user.id;
      req.session.email = user.email;
      req.session.fullName = user.fullName;
      req.session.role = user.role;
      req.session.companyId = user.companyId;
      req.session.preferredLanguage = user.preferredLanguage || 'en';
      req.session.hybridMode = Boolean(user.hybridMode);

      // Individual ("Just me") accounts are priced and sold as one person's
      // subscription. Unlike a company account — where sharing a login just
      // means sharing one of several real seats — an individual account has
      // exactly one user by design, so a shared login there is a direct way
      // for other people to use the product without ever subscribing
      // themselves. This won't stop someone determined to take turns with
      // the same login, but it does stop the common case of several people
      // being logged in and using it at once: logging in here logs out
      // whatever session(s) this account already had elsewhere. Scoped to
      // individual accounts only — a company user legitimately switching
      // between their phone and laptop shouldn't get bounced.
      if (user.companyId) {
        const companyRow = db.prepare('SELECT isIndividual FROM companies WHERE id = ?').get(user.companyId);
        if (companyRow && companyRow.isIndividual) {
          try {
            db.prepare(
              "DELETE FROM sessions WHERE sid != ? AND json_extract(sess, '$.userId') = ?"
            ).run(req.sessionID, user.id);
          } catch (err) {
            console.error('Could not clear other sessions for individual account:', err.message);
          }
        }
      }

      // "Remember me" extends the session cookie to 30 days, so it
      // survives closing and reopening the browser/app. Left unchecked,
      // this is explicitly reset to a plain session cookie (expires =
      // null) — the regenerated session has no maxAge by default anyway,
      // but being explicit here means this line still does the right
      // thing even if that global default ever changes.
      if (rememberMe) {
        req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
      } else {
        req.session.cookie.expires = null;
      }

      res.json({ ok: true, email: user.email, fullName: user.fullName, role: user.role, preferredLanguage: user.preferredLanguage || 'en' });
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

app.post('/api/logout', function (req, res) {
  if (!req.session) {
    return res.json({ ok: true });
  }

  req.session.destroy(function (err) {
    if (err) {
      console.error('Logout error:', err.message);
      return res.status(500).json({ error: 'Could not log out.' });
    }

    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.post('/api/request-password-reset', authLimiter, async function (req, res) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  // Same response whether or not the account exists — otherwise this
  // endpoint becomes a way to check which emails are registered.
  const genericResponse = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };

  try {
    const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email.toLowerCase());

    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      // 30 minutes, matching what reset-sent.html already tells people.
      const expiresAt = new Date(Date.now() + 1000 * 60 * 30).toISOString();

      db.prepare('INSERT INTO passwordResets (token, userId, expiresAt, used, createdAt) VALUES (?, ?, ?, 0, ?)')
        .run(token, user.id, expiresAt, new Date().toISOString());

      const resetUrl = (process.env.APP_URL || ('http://localhost:' + PORT)) +
        '/new-password.html?token=' + token;

      await sendPasswordResetEmail(user.email, resetUrl);
    }

    res.json(genericResponse);
  } catch (err) {
    console.error('Password reset request error:', err.message);
    res.status(500).json({ error: 'Could not process the request.' });
  }
});

app.post('/api/reset-password', authLimiter, async function (req, res) {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required.' });
  }

  const pwError = passwordError(password);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }

  try {
    const reset = db.prepare('SELECT * FROM passwordResets WHERE token = ?').get(token);

    if (!reset || reset.used || new Date(reset.expiresAt).getTime() < Date.now()) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const applyReset = db.transaction(function () {
      // Clearing mustChangePassword here too means this same endpoint
      // finishes both an ordinary forgotten-password reset and the
      // required first-time reset on an admin-created account — whichever
      // path got someone to this token, they've now set a real password of
      // their own.
      db.prepare('UPDATE users SET passwordHash = ?, mustChangePassword = 0 WHERE id = ?').run(passwordHash, reset.userId);
      db.prepare('UPDATE passwordResets SET used = 1 WHERE token = ?').run(token);
    });

    applyReset();

    res.json({ ok: true });
  } catch (err) {
    console.error('Password reset error:', err.message);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// --- WhatsApp integration ---
//
// A technician with a working phone signal but no data/app access can do
// everything over WhatsApp that they'd do in the app: ask a diagnostic
// question, report a fault (with a photo), or check a fault's status.
// Every one of those reads and writes the exact same tables the web app
// uses, keyed to the same account (matched by phone number, see phone.js)
// — so nothing lives in a WhatsApp-only silo; it's just another way in.

function getWhatsAppSession(phone) {
  const row = db.prepare('SELECT * FROM whatsappSessions WHERE phone = ?').get(phone);

  if (!row) {
    return { phone: phone, userId: null, mode: 'idle', draft: {} };
  }

  let draft = {};
  try {
    draft = JSON.parse(row.draft || '{}');
  } catch (err) {
    draft = {};
  }

  return { phone: row.phone, userId: row.userId, mode: row.mode, draft: draft };
}

function saveWhatsAppSession(wa) {
  db.prepare(`
    INSERT INTO whatsappSessions (phone, userId, mode, draft, updatedAt)
    VALUES (@phone, @userId, @mode, @draft, @updatedAt)
    ON CONFLICT(phone) DO UPDATE SET
      userId = excluded.userId,
      mode = excluded.mode,
      draft = excluded.draft,
      updatedAt = excluded.updatedAt
  `).run({
    phone: wa.phone,
    userId: wa.userId,
    mode: wa.mode,
    draft: JSON.stringify(wa.draft || {}),
    updatedAt: new Date().toISOString()
  });
}

// No WHATSAPP_TOKEN configured yet — log instead of sending, the same
// fallback pattern as sendPasswordResetEmail, so the rest of the flow is
// still fully testable (with simulated webhook payloads) before real
// Meta credentials exist.
// Shared low-level sender — both a plain text reply and the interactive
// language picker below go through this. Falls back to logging instead of
// sending when Meta credentials aren't configured yet, so the rest of the
// flow (including the picker) is still testable without them.
async function sendWhatsAppPayload(payload) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log('--- WHATSAPP OUTBOUND (no WHATSAPP_TOKEN configured — see .env) ---');
    console.log(JSON.stringify(payload, null, 2));
    console.log('---------------------------------------------------------------------');
    return;
  }

  const url = 'https://graph.facebook.com/' + WHATSAPP_API_VERSION + '/' + WHATSAPP_PHONE_NUMBER_ID + '/messages';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + WHATSAPP_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error('WhatsApp send failed (' + response.status + '): ' + errBody);
  }
}

async function sendWhatsAppMessage(to, text) {
  await sendWhatsAppPayload({
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: text }
  });
}

// The names people would actually recognize in their own language, not
// the English names from LANGUAGE_NAMES — this is what shows in the list
// itself, so "Français" rather than "French".
const LANGUAGE_NATIVE_NAMES = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  sw: 'Kiswahili'
};

// A WhatsApp "List Message" — this renders as an actual tappable button
// ("Select language") that opens a native picker listing every option, not
// a wall of text someone has to type back correctly. Limited for now to
// the languages the web app's interface is actually translated into (see
// UI_TRANSLATED_LANGUAGES) — offering a choice here that only changes the
// AI's reply language, with everything else in this same picker fully
// translated, would be a confusing mix.
async function sendWhatsAppLanguagePicker(to) {
  const rows = UI_TRANSLATED_LANGUAGES.map(function (code) {
    return { id: 'lang_' + code, title: LANGUAGE_NATIVE_NAMES[code] || LANGUAGE_NAMES[code] };
  });

  await sendWhatsAppPayload({
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Choose your language' },
      body: { text: 'Select the language you\'d like Tervexa to use.' },
      action: {
        button: 'Select language',
        sections: [{ title: 'Languages', rows: rows }]
      }
    }
  });
}

// A WhatsApp image message only carries a media id — the actual bytes have
// to be fetched separately, in two hops: first ask Graph for a short-lived
// download URL, then fetch that URL (still with our own bearer token,
// Meta requires it on both calls).
async function downloadWhatsAppMedia(mediaId) {
  const metaUrl = 'https://graph.facebook.com/' + WHATSAPP_API_VERSION + '/' + mediaId;

  const metaResponse = await fetch(metaUrl, {
    headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN }
  });

  if (!metaResponse.ok) {
    throw new Error('Could not resolve media URL (' + metaResponse.status + ')');
  }

  const meta = await metaResponse.json();

  const fileResponse = await fetch(meta.url, {
    headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN }
  });

  if (!fileResponse.ok) {
    throw new Error('Could not download media (' + fileResponse.status + ')');
  }

  const arrayBuffer = await fileResponse.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  return { data: base64, mediaType: meta.mime_type || 'image/jpeg' };
}

function whatsappReportPrompt(step) {
  switch (step) {
    case 'equipment':
      return 'Starting a new fault report. What equipment or system is this about? (e.g. "Conveyor motor, Line 2")';
    case 'location':
      return 'Got it. What site or location is this at?';
    case 'description':
      return 'Thanks. Please describe the fault in at least 20 characters.';
    case 'photo':
      return 'If you have a photo of the equipment, send it now. Otherwise reply "skip".';
    default:
      return '';
  }
}

async function handleStatusCommand(user, to, arg) {
  if (arg) {
    const report = db.prepare('SELECT * FROM reports WHERE id = ? AND userId = ?').get(arg.toUpperCase(), user.id);

    if (!report) {
      await sendWhatsAppMessage(to, 'No report found with ID ' + arg + ' on your account.');
      return;
    }

    await sendWhatsAppMessage(to,
      report.id + ' — ' + report.equipment + ' at ' + report.location + '\n' +
      'Status: ' + report.status +
      (report.diagnosis ? '\n\nDiagnosis: ' + report.diagnosis : ''));
    return;
  }

  const openReports = db.prepare(
    "SELECT id, equipment, status FROM reports WHERE userId = ? AND status != 'Resolved' ORDER BY rowid DESC LIMIT 5"
  ).all(user.id);

  if (openReports.length === 0) {
    await sendWhatsAppMessage(to, 'You have no open fault reports. Reply "report" to file a new one.');
    return;
  }

  const lines = openReports.map(function (r) {
    return r.id + ' — ' + r.equipment + ' (' + r.status + ')';
  });

  await sendWhatsAppMessage(to,
    'Your open reports:\n' + lines.join('\n') +
    '\n\nReply "status F-001" (with the report ID) for details on one of these.');
}

async function continueWhatsAppReportFlow(user, wa, message, text) {
  const to = message.from;
  const draft = wa.draft;

  if (draft.step === 'equipment') {
    if (!text) {
      await sendWhatsAppMessage(to, 'Please reply with the equipment or system name.');
      return;
    }
    draft.fields = { equipment: text };
    draft.step = 'location';
    wa.draft = draft;
    saveWhatsAppSession(wa);
    await sendWhatsAppMessage(to, whatsappReportPrompt('location'));
    return;
  }

  if (draft.step === 'location') {
    if (!text) {
      await sendWhatsAppMessage(to, 'Please reply with the site or location.');
      return;
    }
    draft.fields.location = text;
    draft.step = 'description';
    wa.draft = draft;
    saveWhatsAppSession(wa);
    await sendWhatsAppMessage(to, whatsappReportPrompt('description'));
    return;
  }

  if (draft.step === 'description') {
    if (!text || text.trim().length < 20) {
      await sendWhatsAppMessage(to, 'That description is a bit short — please describe the fault in at least 20 characters.');
      return;
    }
    draft.fields.description = text.trim();
    draft.step = 'photo';
    wa.draft = draft;
    saveWhatsAppSession(wa);
    await sendWhatsAppMessage(to, whatsappReportPrompt('photo'));
    return;
  }

  if (draft.step === 'photo') {
    let photo = null;

    if (message.type === 'image' && message.image && message.image.id) {
      try {
        photo = await downloadWhatsAppMedia(message.image.id);
      } catch (err) {
        console.error('WhatsApp media download failed:', err.message);
        await sendWhatsAppMessage(to, 'Could not download that photo. Reply "skip" to continue without one, or try sending it again.');
        return;
      }
    } else if (!/^skip$/i.test(text)) {
      await sendWhatsAppMessage(to, 'Send a photo now, or reply "skip" to continue without one.');
      return;
    }

    await sendWhatsAppMessage(to, 'Thanks — analyzing this now, one moment.');

    const fields = {
      requestType: 'fault',
      equipment: draft.fields.equipment,
      location: draft.fields.location,
      description: draft.fields.description,
      faultType: '',
      severity: '',
      onset: '',
      language: user.preferredLanguage || 'en'
    };

    let diagnosis = '';
    try {
      diagnosis = await runDiagnosis(fields, photo);
    } catch (err) {
      console.error('WhatsApp diagnosis error:', err.message);
    }

    const newId = insertReport(
      Object.assign({}, fields, { technician: user.fullName || user.email, status: 'Open', diagnosis: diagnosis, date: new Date().toISOString().slice(0, 10) }),
      user.id,
      user.companyId,
      'whatsapp'
    );

    wa.mode = 'idle';
    wa.draft = {};
    saveWhatsAppSession(wa);

    await sendWhatsAppMessage(to,
      'Fault report ' + newId + ' has been logged.' +
      (diagnosis ? '\n\n' + diagnosis : '') +
      '\n\nYou can also view this in the Tervexa app under Fault log.');
  }
}

const LANGUAGE_CONFIRMATION_MESSAGES = {
  en: "Language set to English. I'll reply in English from now on.",
  fr: "Langue définie sur le français. Je répondrai désormais en français.",
  es: "Idioma configurado en español. A partir de ahora responderé en español.",
  pt: "Idioma definido para português. A partir de agora responderei em português.",
  sw: "Lugha imewekwa kuwa Kiswahili. Kuanzia sasa nitajibu kwa Kiswahili."
};

// Applies a language choice made over WhatsApp to the account itself —
// the same field the web app reads and writes via /api/preferred-language,
// so a choice made on either side shows up on the other.
function setPreferredLanguage(user, code) {
  db.prepare('UPDATE users SET preferredLanguage = ? WHERE id = ?').run(code, user.id);
}

async function handleIncomingWhatsAppMessage(message) {
  const to = message.from; // Meta's own shape: digits, country code, no plus sign.
  const phone = normalizePhone(to);
  const text = (message.type === 'text' && message.text && message.text.body) ? message.text.body.trim() : '';

  const user = db.prepare('SELECT * FROM users WHERE phoneNormalized = ?').get(phone);

  if (!user) {
    await sendWhatsAppMessage(to,
      "We couldn't find a Tervexa account with this phone number. Please sign up at " +
      (process.env.APP_URL || ('http://localhost:' + PORT)) +
      '/signup.html using this exact number, then message us again.');
    return;
  }

  const language = user.preferredLanguage || 'en';

  // A tap on one of the language picker's rows arrives as its own message
  // type, separate from a typed text message — handled first and on its
  // own, regardless of whatever else is going on (a report in progress,
  // for instance), since picking a language shouldn't derail anything
  // else mid-flow.
  if (message.type === 'interactive' && message.interactive && message.interactive.type === 'list_reply') {
    const rowId = message.interactive.list_reply.id || '';
    const code = rowId.replace(/^lang_/, '');

    if (UI_TRANSLATED_LANGUAGES.includes(code)) {
      setPreferredLanguage(user, code);
      await sendWhatsAppMessage(to, LANGUAGE_CONFIRMATION_MESSAGES[code] || LANGUAGE_CONFIRMATION_MESSAGES.en);
    } else {
      await sendWhatsAppMessage(to, "Sorry, that wasn't a recognized language option. Message \"language\" to try again.");
    }
    return;
  }

  const wa = getWhatsAppSession(phone);
  wa.userId = user.id;

  if (wa.mode === 'reporting') {
    return continueWhatsAppReportFlow(user, wa, message, text);
  }

  if (/^language\b/i.test(text)) {
    await sendWhatsAppLanguagePicker(to);
    return;
  }

  if (/^report\b/i.test(text)) {
    wa.mode = 'reporting';
    wa.draft = { step: 'equipment', fields: {} };
    saveWhatsAppSession(wa);
    await sendWhatsAppMessage(to, whatsappReportPrompt('equipment'));
    return;
  }

  const statusMatch = text.match(/^status\b\s*(\S+)?/i);
  if (statusMatch) {
    await handleStatusCommand(user, to, statusMatch[1]);
    return;
  }

  if (!text) {
    await sendWhatsAppMessage(to, 'Send a text message with your question, message "report" to file a fault, or "language" to change your reply language.');
    return;
  }

  const history = loadRecentChat(user.id, 10).map(function (m) {
    return { role: m.role, content: m.content };
  });
  history.push({ role: 'user', content: text });

  try {
    const replyText = await runChat(history, language);
    saveChatMessage(user.id, 'whatsapp', 'user', text);
    saveChatMessage(user.id, 'whatsapp', 'assistant', replyText);
    await sendWhatsAppMessage(to, replyText);
  } catch (err) {
    console.error('WhatsApp chat error:', err.message);
    await sendWhatsAppMessage(to, 'Sorry, the assistant is unavailable right now. Please try again shortly.');
  }
}

// Meta calls this once, when the webhook is first configured in the
// developer console, to confirm you actually control this URL. It's a
// GET with three query params; echoing back hub.challenge (as plain text,
// not JSON) if hub.verify_token matches what's configured is the entire
// handshake.
app.get('/webhook/whatsapp', function (req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// Meta expects a fast 200 response and will retry (with duplicate
// deliveries) if one doesn't arrive quickly — so this acknowledges
// immediately and does the actual work (which can take a few seconds,
// since it may call the AI) afterward rather than making Meta wait on it.
app.post('/webhook/whatsapp', function (req, res) {
  res.sendStatus(200);

  try {
    const entry = req.body.entry || [];

    entry.forEach(function (e) {
      const changes = e.changes || [];

      changes.forEach(function (change) {
        const messages = (change.value && change.value.messages) || [];

        messages.forEach(function (message) {
          handleIncomingWhatsAppMessage(message).catch(function (err) {
            console.error('WhatsApp message handling error:', err.message);
          });
        });
      });
    });
  } catch (err) {
    console.error('WhatsApp webhook payload error:', err.message);
  }
});

// Anything that isn't a real route falls here instead of Express's default
// HTML 404 page, so API consumers always get consistent JSON.
app.use(function (req, res) {
  res.status(404).json({ error: 'Not found.' });
});

// Last-resort handler. Anything that throws or rejects without being
// caught by its own try/catch — including a malformed JSON body, which
// express.json() rejects before a route ever runs — ends up here instead
// of Express's default error page, which would otherwise hand back a
// stack trace to the browser.
app.use(function (err, req, res, next) {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed request body.' });
  }

  console.error('Unhandled error:', err.stack || err.message);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, function () {
  console.log('Tervexa server running at http://localhost:' + PORT);
});
