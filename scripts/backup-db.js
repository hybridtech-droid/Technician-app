// Snapshots tervexa.db into a timestamped file in backups/, using
// SQLite's own online backup API (via better-sqlite3's db.backup()) —
// safe to run even while the live server has the database open and is
// actively writing to it, unlike a plain file copy.
//
// Usage:
//   node scripts/backup-db.js
//
// Scheduling it once deployed (example: daily at 3am, keeping 14 days):
//   0 3 * * * cd /path/to/app && node scripts/backup-db.js >> backup.log 2>&1
//
// Config (all optional, via .env or environment):
//   DB_PATH           path to the live database (default: ./tervexa.db)
//   BACKUP_DIR        where backups are written (default: ./backups)
//   BACKUP_KEEP_COUNT how many recent backups to keep (default: 14)

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// db.js renames the old techassist.db to tervexa.db the first time it
// runs after the app was rebranded — this just needs to know the current
// name, since by the time a backup runs, that rename has already happened.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'tervexa.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP_COUNT = Number(process.env.BACKUP_KEEP_COUNT) || 14;

async function backup() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('No database found at', DB_PATH, '— nothing to back up.');
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(BACKUP_DIR, 'tervexa-' + timestamp + '.db');

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

  try {
    await db.backup(destination);
    console.log('Backup written to', destination);
  } finally {
    db.close();
  }

  pruneOldBackups();
}

function pruneOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(function (f) {
      // Matches both the current "tervexa-" prefix and any older
      // "techassist-" backups made before the rename, so they still count
      // toward the retention window instead of piling up untouched.
      return (f.startsWith('tervexa-') || f.startsWith('techassist-')) && f.endsWith('.db');
    })
    .map(function (f) {
      return { name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs };
    })
    .sort(function (a, b) {
      return b.time - a.time;
    });

  files.slice(KEEP_COUNT).forEach(function (f) {
    fs.unlinkSync(path.join(BACKUP_DIR, f.name));
    console.log('Removed old backup:', f.name);
  });
}

backup().catch(function (err) {
  console.error('Backup failed:', err.message);
  process.exitCode = 1;
});