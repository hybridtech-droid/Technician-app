const Database = require('better-sqlite3');

const db = new Database('techassist.db');

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

module.exports = db;