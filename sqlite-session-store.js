// A persistent, SQLite-backed session store for express-session.
//
// express-session's default store (MemoryStore) keeps every logged-in
// session in a plain JS object in server memory. That has two problems for
// a real deployment: memory grows forever as sessions pile up (it's not
// even meant for production — express-session logs a warning about this on
// startup), and every session is wiped out the instant the server process
// restarts (a crash, a redeploy, `nodemon` picking up a file change) —
// every logged-in user gets silently logged out at once.
//
// This store fixes both by keeping sessions as rows in the same
// tervexa.db SQLite file everything else already lives in, via the same
// better-sqlite3 connection (see db.js) — no extra database, no extra
// dependency.
'use strict';

const noop = function () {};

// Sessions with no explicit cookie.maxAge (the common case here — see the
// comment in server.js) fall back to this when deciding how long to keep
// the row before it's swept up as expired. It does not affect how long the
// browser keeps the cookie — only how long an inactive session stays in
// the database before cleanup removes it.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function buildStore(Store) {
  class SqliteSessionStore extends Store {
    constructor(options) {
      options = options || {};

      if (!options.client) {
        throw new Error('SqliteSessionStore requires a `client` (a better-sqlite3 database connection).');
      }

      super(options);

      this.client = options.client;
      this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
      const sweepIntervalMs = options.sweepIntervalMs || 15 * 60 * 1000; // 15 min

      this.client.exec(
        'CREATE TABLE IF NOT EXISTS sessions (' +
        '  sid TEXT PRIMARY KEY,' +
        '  sess TEXT NOT NULL,' +
        '  expiresAt INTEGER NOT NULL' +
        ')'
      );
      this.client.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expiresAt ON sessions (expiresAt)');

      this._sweepExpired();
      this._sweepTimer = setInterval(this._sweepExpired.bind(this), sweepIntervalMs);
      // Don't let this timer keep the process alive on its own.
      if (this._sweepTimer.unref) {
        this._sweepTimer.unref();
      }
    }

    _expiryFor(sess) {
      if (sess && sess.cookie && sess.cookie.expires) {
        const t = new Date(sess.cookie.expires).getTime();
        if (!isNaN(t)) return t;
      }
      return Date.now() + this.ttlMs;
    }

    _sweepExpired() {
      try {
        this.client.prepare('DELETE FROM sessions WHERE expiresAt < ?').run(Date.now());
      } catch (err) {
        console.error('Session store cleanup failed:', err.message);
      }
    }

    get(sid, cb) {
      cb = cb || noop;
      try {
        const row = this.client
          .prepare('SELECT sess FROM sessions WHERE sid = ? AND expiresAt >= ?')
          .get(sid, Date.now());

        if (!row) return cb(null, null);
        cb(null, JSON.parse(row.sess));
      } catch (err) {
        cb(err);
      }
    }

    set(sid, sess, cb) {
      cb = cb || noop;
      try {
        const expiresAt = this._expiryFor(sess);
        this.client
          .prepare('INSERT OR REPLACE INTO sessions (sid, sess, expiresAt) VALUES (?, ?, ?)')
          .run(sid, JSON.stringify(sess), expiresAt);
        cb(null);
      } catch (err) {
        cb(err);
      }
    }

    touch(sid, sess, cb) {
      cb = cb || noop;
      try {
        const expiresAt = this._expiryFor(sess);
        this.client
          .prepare('UPDATE sessions SET expiresAt = ? WHERE sid = ?')
          .run(expiresAt, sid);
        cb(null);
      } catch (err) {
        cb(err);
      }
    }

    destroy(sid, cb) {
      cb = cb || noop;
      try {
        this.client.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        cb(null);
      } catch (err) {
        cb(err);
      }
    }

    length(cb) {
      cb = cb || noop;
      try {
        const row = this.client.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expiresAt >= ?').get(Date.now());
        cb(null, row.count);
      } catch (err) {
        cb(err);
      }
    }

    clear(cb) {
      cb = cb || noop;
      try {
        this.client.prepare('DELETE FROM sessions').run();
        cb(null);
      } catch (err) {
        cb(err);
      }
    }

    all(cb) {
      cb = cb || noop;
      try {
        const rows = this.client.prepare('SELECT sid, sess FROM sessions WHERE expiresAt >= ?').all(Date.now());
        const sessions = {};
        for (const row of rows) {
          sessions[row.sid] = JSON.parse(row.sess);
        }
        cb(null, sessions);
      } catch (err) {
        cb(err);
      }
    }
  }

  return SqliteSessionStore;
}

module.exports = buildStore;