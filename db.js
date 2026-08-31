const fs = require('fs');
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

module.exports = db;