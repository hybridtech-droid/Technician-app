const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { normalizePhone } = require('./phone');

const OLD_DB_PATH = 'techassist.db';
const DB_PATH = 'tervexa.db';

// The app was built as "TechAssist" before it became Tervexa, and the
// database file kept that name even after everything else was renamed.
// If a real database already exists under the old name and the new name
// doesn't exist yet, rename it in place — a filesystem rename, not a
// copy, so nothing is lost or duplicated. This only ever runs once: after
// tervexa.db exists, this check is skipped on every future start.
if (!fs.existsSync(DB_PATH) && fs.existsSync(OLD_DB_PATH)) {
  fs.renameSync(OLD_DB_PATH, DB_PATH);
  console.log('Renamed techassist.db to tervexa.db (one-time, running data preserved).');
}

const db = new Database(DB_PATH);

// WAL (Write-Ahead Logging) mode lets reads and writes happen at the same
// time instead of the default mode's "one write locks out everyone else,
// even readers" behaviour. With several technicians using the app at once,
// that default mode is what occasionally produces a "database is locked"
// error on a write that lands mid-read. WAL mode fixes that for the normal
// case; `busy_timeout` below is the backstop for the rare moment two writes
// still land at literally the same instant — instead of failing instantly,
// better-sqlite3 quietly retries for up to 5 seconds first.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    technician TEXT,
    equipment TEXT,
    location TEXT,
    requestType TEXT,
    type TEXT,
    severity TEXT,
    onset TEXT,
    installStage TEXT,
    equipmentModel TEXT,
    timeSinceInstall TEXT,
    warrantyStatus TEXT,
    applicationImpact TEXT,
    recurring TEXT,
    date TEXT,
    status TEXT,
    description TEXT,
    diagnosis TEXT,
    rootCause TEXT,
    resolutionNotes TEXT,
    resolvedDate TEXT,
    createdAt TEXT
  )
`);

// userId ties a report to the account that actually created it (used to
// scope the fault log by role). Added after the table already existed in
// deployed copies of this app, so it's applied as a best-effort migration —
// SQLite has no "ADD COLUMN IF NOT EXISTS", so we just swallow the error
// on a database that already has the column.
try {
  db.exec('ALTER TABLE reports ADD COLUMN userId INTEGER');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

// channel records where a report came from — the web form, or a WhatsApp
// conversation — so the fault log can show it and so nothing has to guess.
// Existing rows (all filed through the web app before this existed) default
// to 'web' via the column default, not a backfill statement.
try {
  db.exec("ALTER TABLE reports ADD COLUMN channel TEXT DEFAULT 'web'");
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER
  )
`);

db.prepare(`
  INSERT OR IGNORE INTO counters (name, value) VALUES ('report', 0)
`).run();

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    fullName TEXT,
    phone TEXT,
    company TEXT,
    role TEXT,
    createdAt TEXT
  )
`);

// phoneNormalized is what an incoming WhatsApp message's sender number is
// matched against (see phone.js) — kept as a separate column, rather than
// normalizing `phone` on every lookup, so the match is a plain indexed
// equality check. Added after `users` already existed in deployed copies,
// so this is a best-effort migration like the ones above, followed by a
// one-time backfill for any accounts that signed up before this column
// existed.
try {
  db.exec('ALTER TABLE users ADD COLUMN phoneNormalized TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

// Records that a specific account actually agreed to the Terms/Privacy
// Policy and acknowledged the AI-diagnosis disclaimer at signup — not just
// that the checkboxes happened to be ticked in a browser somewhere, but a
// timestamped fact in the account's own record. Existing accounts created
// before this existed are left NULL rather than backfilled with a guessed
// date — there's no honest timestamp to give them.
try {
  db.exec('ALTER TABLE users ADD COLUMN termsAcceptedAt TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

try {
  db.exec('ALTER TABLE users ADD COLUMN disclaimerAcceptedAt TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

// The language an account wants replies and (where translated) the UI in
// — one value per account, not per browser, specifically so a WhatsApp
// reply and a web page look at the same preference. Defaults to English;
// existing accounts get 'en' for the same reason a first-time visitor's
// dropdown defaults to English.
try {
  db.exec("ALTER TABLE users ADD COLUMN preferredLanguage TEXT DEFAULT 'en'");
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

// Lets an administrator turn a login off without deleting the account or
// its report history — 1 (the default, so every existing account stays
// exactly as usable as before this column existed) or 0 for deactivated.
// Checked both at login and on every already-authenticated request (see
// isActiveUser() in server.js), so deactivating someone who's already
// logged in actually takes effect immediately, not just on their next
// login attempt.
try {
  db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

// Lets a field-facing account (technician, engineer, field application
// specialist) opt into seeing every request type instead of just the ones
// ROLE_REQUEST_TYPES maps to their role — for people doing genuinely
// hybrid work (e.g. covering both engineer- and application-specialist-
// scoped jobs). Defaults to 0 (scoped view) so the scoping actually takes
// effect for everyone unless they turn it on; see the hybrid-mode toggle
// in the nav and its enforcement in server.js.
try {
  db.exec('ALTER TABLE users ADD COLUMN hybridMode INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

const usersMissingNormalizedPhone = db.prepare(
  "SELECT id, phone FROM users WHERE phone IS NOT NULL AND phone != '' AND (phoneNormalized IS NULL OR phoneNormalized = '')"
).all();

if (usersMissingNormalizedPhone.length > 0) {
  const backfillPhone = db.prepare('UPDATE users SET phoneNormalized = ? WHERE id = ?');

  db.transaction(function () {
    usersMissingNormalizedPhone.forEach(function (user) {
      backfillPhone.run(normalizePhone(user.phone), user.id);
    });
  })();

  console.log('Backfilled phoneNormalized for', usersMissingNormalizedPhone.length, 'existing account(s).');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS passwordResets (
    token TEXT PRIMARY KEY,
    userId INTEGER NOT NULL,
    expiresAt TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT
  )
`);

// One conversation history per account, shared across channels — a message
// sent from the web "Ask AI" page and a message sent over WhatsApp both
// land here, tagged by channel, so either surface can show the full
// back-and-forth regardless of where each message actually came from.
db.exec(`
  CREATE TABLE IF NOT EXISTS chatMessages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    channel TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt TEXT
  )
`);

// Tracks what a given WhatsApp number is in the middle of doing —
// WhatsApp delivers one message at a time with no memory of its own, so a
// multi-step flow (like "report a fault", which asks a few questions in
// sequence) needs somewhere server-side to keep its place between
// messages. Keyed by the phone number itself (already normalized to the
// same shape phone.js produces) since a message can arrive before we've
// matched it to an account.
db.exec(`
  CREATE TABLE IF NOT EXISTS whatsappSessions (
    phone TEXT PRIMARY KEY,
    userId INTEGER,
    mode TEXT NOT NULL DEFAULT 'idle',
    draft TEXT NOT NULL DEFAULT '{}',
    updatedAt TEXT
  )
`);

// --- Company / tenant support -------------------------------------------
// Every account now belongs to a real company record instead of a free-text
// "company" field that was never linked to anything — this is what lets the
// fault log, exports and the admin panel be scoped to "your company" rather
// than every signed-up user sharing one pool. inviteCode is what an
// employee types at signup to land inside their employer's company instead
// of a text field nobody validated.
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    inviteCode TEXT UNIQUE NOT NULL,
    createdAt TEXT
  )
`);

try {
  db.exec('ALTER TABLE users ADD COLUMN companyId INTEGER');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

// Set on an account an administrator created directly from the admin panel
// (see POST /api/admin/users in server.js) — the admin picks a temporary
// password on the employee's behalf, so this forces a real password of the
// employee's own choosing on first login, reusing the same "set a new
// password" page and flow as an ordinary forgotten-password reset.
try {
  db.exec('ALTER TABLE users ADD COLUMN mustChangePassword INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

try {
  db.exec('ALTER TABLE reports ADD COLUMN companyId INTEGER');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

function generateDefaultInviteCode() {
  // No 0/O or 1/I — easy to misread out loud over a phone call, which is
  // exactly how a lot of these codes will actually get shared.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += alphabet[crypto.randomInt(alphabet.length)];
  }
  return code;
}

// Backfill: every account (and every report) that existed before companies
// did gets folded into one shared default company, so nothing about what an
// existing user can already see changes because of this migration — they
// could already see every other existing account/report before today, and
// after this they're simply all members of the same one company instead of
// no company at all. This only ever does real work once; after the first
// run every account already has a companyId and the SELECT below comes
// back empty on every later start.
const usersMissingCompany = db.prepare('SELECT id, company FROM users WHERE companyId IS NULL').all();

if (usersMissingCompany.length > 0) {
  // Existing accounts each typed whatever they wanted into the old free-text
  // "company" field, so there's no single authoritative name to inherit —
  // this picks whichever non-empty value the most existing accounts already
  // used, falling back to a generic name if nobody had entered one.
  const nameCounts = {};
  usersMissingCompany.forEach(function (u) {
    const name = (u.company || '').trim();
    if (name) {
      nameCounts[name] = (nameCounts[name] || 0) + 1;
    }
  });

  let defaultCompanyName = 'My company';
  let bestCount = 0;
  Object.keys(nameCounts).forEach(function (name) {
    if (nameCounts[name] > bestCount) {
      bestCount = nameCounts[name];
      defaultCompanyName = name;
    }
  });

  const defaultInviteCode = generateDefaultInviteCode();
  const defaultCompany = db.prepare(
    'INSERT INTO companies (name, inviteCode, createdAt) VALUES (?, ?, ?)'
  ).run(defaultCompanyName, defaultInviteCode, new Date().toISOString());

  const defaultCompanyId = defaultCompany.lastInsertRowid;

  db.transaction(function () {
    db.prepare('UPDATE users SET companyId = ? WHERE companyId IS NULL').run(defaultCompanyId);
    db.prepare(`
      UPDATE reports SET companyId = (
        SELECT companyId FROM users WHERE users.id = reports.userId
      ) WHERE companyId IS NULL
    `).run();
    // A report with no matching user shouldn't exist (every report is
    // created through an authenticated account), but this is the same
    // defensive fallback used elsewhere in this file rather than leaving
    // anything orphaned.
    db.prepare('UPDATE reports SET companyId = ? WHERE companyId IS NULL').run(defaultCompanyId);
  })();

  console.log(
    'Backfilled', usersMissingCompany.length,
    'existing account(s) into a default company ("' + defaultCompanyName + '", invite code ' + defaultInviteCode + ').'
  );
}

// --- Plan tiers -----------------------------------------------------------
// planTier is just a label on the company row; what each tier actually
// allows lives in one place, PLAN_TIERS in server.js, so pricing/limits
// can be tuned without another migration. Seat/report limits are enforced
// (with a grace buffer — see checkSeatLimit/checkReportLimit in server.js)
// now that a real billing flow exists to send an over-limit company to.
try {
  db.exec('ALTER TABLE companies ADD COLUMN planTier TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

// One-time backfill, same IS-NULL pattern as the users/reports companyId
// backfill above: every company that existed before planTier did was using
// the app with no limits at all (there were none), so defaulting them to
// 'free' — the most restrictive tier — would be a real behavior change
// dressed up as a migration. They're grandfathered onto 'pro' instead. A
// company created from here on always gets an explicit planTier at INSERT
// time (see POST /api/signup in server.js), never NULL, so this only ever
// matches pre-existing rows and is a no-op on every later restart.
db.prepare("UPDATE companies SET planTier = 'pro' WHERE planTier IS NULL").run();

// --- Audit log -----------------------------------------------------------
// A record of sensitive account-management actions within a company —
// role changes, activate/deactivate, an admin adding an employee directly,
// and invite code regeneration. Deliberately scoped to just those (not
// every report edit/export — that's a much higher-volume, lower-stakes
// trail that can be added later if it's actually wanted). actorEmail and
// targetEmail are captured as plain text alongside the id columns so the
// log still reads sensibly even if the account it refers to is later
// deleted or changes its email — the log is a historical record, not a
// live join.
db.exec(`
  CREATE TABLE IF NOT EXISTS auditLog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companyId INTEGER NOT NULL,
    actorUserId INTEGER,
    actorEmail TEXT,
    action TEXT NOT NULL,
    targetUserId INTEGER,
    targetEmail TEXT,
    details TEXT,
    createdAt TEXT NOT NULL
  )
`);

// --- Billing / subscriptions ----------------------------------------------
// Everything a company's paid subscription needs to be tracked and acted
// on. All of it lives on the company row itself (a company subscribes, not
// an individual user) plus two small supporting tables:
//   - transactions: a running record of every payment attempt (success or
//     not) — what admin.html's future billing history and support
//     investigations both read from. Never deleted, even on downgrade.
//   - processedWebhookEvents: pure idempotency guard. Every one of the
//     three providers can and will redeliver the same webhook (retries,
//     manual resends) — this table's UNIQUE(provider, eventId) is what
//     stops a redelivered "payment succeeded" from upgrading a company
//     twice or double-logging a transaction.
try {
  db.exec('ALTER TABLE companies ADD COLUMN billingCycle TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

try {
  db.exec('ALTER TABLE companies ADD COLUMN subscriptionStatus TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

try {
  db.exec('ALTER TABLE companies ADD COLUMN subscriptionProvider TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

try {
  db.exec('ALTER TABLE companies ADD COLUMN subscriptionRef TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

try {
  db.exec('ALTER TABLE companies ADD COLUMN currentPeriodEnd TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

try {
  db.exec('ALTER TABLE companies ADD COLUMN pendingCancellation INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

// A small JSON blob for whatever extra, provider-specific bit a
// subscription needs beyond its main reference — right now that's just
// Paystack's separate "email token", which its subscription-disable
// endpoint requires alongside the subscription code. Kept generic (rather
// than a narrow paystackEmailToken column) so a future provider quirk
// doesn't need its own migration.
try {
  db.exec('ALTER TABLE companies ADD COLUMN subscriptionMeta TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

// isIndividual marks a company row created through the solo "individual"
// signup path rather than a real team ("create") signup — same table,
// just a one-person company under the hood (see /api/signup in
// server.js). It's what lets the free tier's seat cap differ: 1 seat for
// an individual, 3 for an actual company.
try {
  db.exec('ALTER TABLE companies ADD COLUMN isIndividual INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

// trialEndsAt is set once, at signup, only for a brand-new free-tier
// company (individual or team) — it's what the free trial's hard cutoff
// (see checkSeatLimit/checkReportLimit in server.js) is measured against.
// Left NULL for any company created before this column existed, which is
// what keeps the trial cutoff from retroactively applying to accounts
// that were already using the app under the old "free, indefinitely"
// terms — a NULL trialEndsAt is treated as "no trial to expire."
try {
  db.exec('ALTER TABLE companies ADD COLUMN trialEndsAt TEXT');
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) {
    throw err;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companyId INTEGER NOT NULL,
    provider TEXT NOT NULL,
    providerReference TEXT,
    planTier TEXT NOT NULL,
    billingCycle TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS processedWebhookEvents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    eventId TEXT NOT NULL,
    processedAt TEXT NOT NULL,
    UNIQUE(provider, eventId)
  )
`);

// Every provider needs a Plan/Price object created on ITS side before it
// can charge anyone against it (Paystack's /plan, Flutterwave's
// /payment-plans, Stripe's Price). Rather than creating one every time the
// server restarts (which would leave a growing pile of duplicate plan
// objects sitting in each provider's dashboard), the id each provider
// hands back the first time is cached here and reused after that.
db.exec(`
  CREATE TABLE IF NOT EXISTS providerPlanCache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    planTier TEXT NOT NULL,
    billingCycle TEXT NOT NULL,
    externalId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    UNIQUE(provider, planTier, billingCycle)
  )
`);

module.exports = db;