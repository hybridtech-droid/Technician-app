const fs = require('fs');
const Database = require('better-sqlite3');

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

db.exec(`
  CREATE TABLE IF NOT EXISTS passwordResets (
    token TEXT PRIMARY KEY,
    userId INTEGER NOT NULL,
    expiresAt TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT
  )
`);

module.exports = db;