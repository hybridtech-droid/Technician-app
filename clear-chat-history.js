// clear-chat-history.js — one-off cleanup script.
//
// The "Ask AI" chat shares one running conversation history per account
// (so a question asked over WhatsApp shows up on the web page too, and
// vice versa) — see loadRecentChat/saveChatMessage in server.js. That
// history is stored in tervexa.db and gets resent as context on every
// new chat message. Right now it holds an old exchange naming a specific
// hospital and equipment brand, which is the most likely reason later,
// unrelated questions have started getting refused by the model — the
// old context rides along with every new request.
//
// This clears the whole chatMessages table so every account starts a
// genuinely clean conversation on its next visit to Ask AI or WhatsApp.
// Run it with the server STOPPED (Ctrl+C in the terminal running
// `node server.js`) so nothing is writing to the database at the same
// time.
//
// Usage:  node clear-chat-history.js

const Database = require('better-sqlite3');
const db = new Database('./tervexa.db');

const before = db.prepare('SELECT COUNT(*) AS n FROM chatMessages').get().n;
db.prepare('DELETE FROM chatMessages').run();
const after = db.prepare('SELECT COUNT(*) AS n FROM chatMessages').get().n;

console.log('chatMessages rows before:', before, '/ after:', after);

db.close();
