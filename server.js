require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { normalizePhone } = require('./phone');

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

app.use(express.json({ limit: '10mb'}));

app.use(session({
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
const protectedPages = ['/fault-report.html', '/fault-log.html', '/chat.html'];

app.get(protectedPages, function (req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }

  res.redirect('/login.html');
});

app.use(express.static('.'));

const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a while and try again.' }
});

// Separate, tighter limiter for auth endpoints so a login/signup script
// can't be hammered the way the AI endpoints can.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a while and try again.' }
});

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }

  res.status(401).json({ error: 'You must be logged in.' });
}

// Only these roles get scoped to their own reports. Everyone else
// (engineer, supervisor, manager, admin) still sees the full log — there's
// no "site" or "team" concept in the data model yet, so that's as far as
// role-based visibility goes for now.
const ownReportsOnlyRoles = ['technician', 'field-application-specialist'];

// Whitelists matching the actual <option value="..."> sets in the HTML
// forms, so a direct API call can't slip in a value the UI never offers
// (an unrecognized status, a made-up role, etc).
const VALID_REQUEST_TYPES = ['fault', 'installation', 'after-sales', 'application'];
const VALID_REPORT_STATUSES = ['Open', 'In progress', 'Resolved'];
const VALID_ROLES = ['technician', 'field-application-specialist', 'engineer', 'supervisor', 'manager', 'admin'];

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
  if (req.session && req.session.userId) {
    return res.json({
      loggedIn: true,
      email: req.session.email,
      fullName: req.session.fullName,
      role: req.session.role,
      preferredLanguage: req.session.preferredLanguage || 'en',
      uiTranslatedLanguages: UI_TRANSLATED_LANGUAGES
    });
  }

  res.json({ loggedIn: false, uiTranslatedLanguages: UI_TRANSLATED_LANGUAGES });
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
    hasPhoto,
    language
  } = fields;

  const briefs = {
    fault: 'You are assisting a field service technician with a fault diagnosis. Give likely causes and the checks to run, in order.',
    installation: 'You are assisting a field service engineer with an equipment installation or commissioning. Give the checks and steps for this stage, and flag anything that must be verified before handover.',
    'after-sales': 'You are assisting with an after-sales support case on equipment already installed. Give likely causes, what to check, and whether this needs a site visit or can be resolved remotely.',
    application: 'You are assisting a field application specialist with an application or process concern. Assess the likely cause, suggest how to troubleshoot it, and recommend corrective actions including any contamination or process-control measures.'
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

  return brief + '\n\n' +
    context +
    'Reported: ' + description + '\n\n' +
    'Keep it under 200 words. Write in plain prose with no Markdown formatting — no asterisks, hashes, or bullet symbols. ' +
    'Note any safety precautions first if they apply.' + photoNote + languageInstruction(language);
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

  return message.content[0].text;
}

app.post('/api/diagnose', requireAuth, aiLimiter, async function (req, res) {
  const { description, photo } = req.body;

  if (!description || description.trim().length < 20) {
    return res.status(400).json({ error: 'Description too short.' });
  }

  try {
    const diagnosis = await runDiagnosis(req.body, photo);
    res.json({ diagnosis: diagnosis });
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: 'Diagnosis service unavailable.' });
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

  return reply.content[0].text;
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
    res.status(500).json({ error: 'Chat service unavailable.' });
  }
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

app.get('/api/reports', requireAuth, function (req, res) {
  try {
    let rows;

    if (ownReportsOnlyRoles.includes(req.session.role)) {
      rows = db.prepare('SELECT * FROM reports WHERE userId = ? ORDER BY rowid').all(req.session.userId);
    } else {
      rows = db.prepare('SELECT * FROM reports ORDER BY rowid').all();
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
function insertReport(r, userId, channel) {
  const newId = nextReportId();

  const stmt = db.prepare(`
    INSERT INTO reports (
      id, technician, equipment, location, requestType, type, severity, onset,
      installStage, equipmentModel, timeSinceInstall, warrantyStatus,
      applicationImpact, recurring, date, status, description, diagnosis,
      rootCause, resolutionNotes, resolvedDate, userId, channel
    ) VALUES (
      @id, @technician, @equipment, @location, @requestType, @type, @severity, @onset,
      @installStage, @equipmentModel, @timeSinceInstall, @warrantyStatus,
      @applicationImpact, @recurring, @date, @status, @description, @diagnosis,
      @rootCause, @resolutionNotes, @resolvedDate, @userId, @channel
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
    date: r.date || '',
    status: r.status || 'Open',
    description: r.description || '',
    diagnosis: r.diagnosis || '',
    rootCause: r.rootCause || '',
    resolutionNotes: r.resolutionNotes || '',
    resolvedDate: r.resolvedDate || '',
    userId: userId,
    channel: channel
  });

  return newId;
}

app.post('/api/reports', requireAuth, function (req, res) {
  const r = req.body;

  if (!r) {
    return res.status(400).json({ error: 'No report data provided.' });
  }

  if (r.requestType && !VALID_REQUEST_TYPES.includes(r.requestType)) {
    return res.status(400).json({ error: 'Invalid request type.' });
  }

  if (!r.technician || !r.equipment || !r.location) {
    return res.status(400).json({ error: 'Technician name, equipment ID, and location are required.' });
  }

  if (!r.description || r.description.trim().length < 20) {
    return res.status(400).json({ error: 'Description must be at least 20 characters.' });
  }

  try {
    // userId is taken from the session, not the request body — the client
    // can't claim to be someone else's report.
    const newId = insertReport(r, req.session.userId, 'web');
    res.json({ ok: true, id: newId });
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
    if (ownReportsOnlyRoles.includes(req.session.role)) {
      const owned = db.prepare('SELECT id FROM reports WHERE id = ? AND userId = ?').get(id, req.session.userId);

      if (!owned) {
        // Same 404 whether the report doesn't exist or just isn't theirs —
        // no need to confirm to a technician that someone else's report ID
        // is valid.
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

app.post('/api/signup', authLimiter, async function (req, res) {
  const { email, password, fullName, phone, company, role, termsAccepted, disclaimerAccepted, preferredLanguage } = req.body;
  // Carries over whatever language someone already had selected while
  // browsing the public pages before they signed up, so the account
  // doesn't reset to English the moment it's created. Falls back to
  // English for anything unrecognized.
  const initialLanguage = (preferredLanguage && LANGUAGE_NAMES[preferredLanguage]) ? preferredLanguage : 'en';

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

  if (role && !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
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

    const result = db.prepare(`
      INSERT INTO users (
        email, passwordHash, fullName, phone, phoneNormalized, company, role,
        createdAt, termsAcceptedAt, disclaimerAcceptedAt, preferredLanguage
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      email.toLowerCase(),
      passwordHash,
      fullName || '',
      phone || '',
      phoneNormalized,
      company || '',
      role || 'technician',
      now,
      now,
      now,
      initialLanguage
    );

    req.session.userId = result.lastInsertRowid;
    req.session.email = email.toLowerCase();
    req.session.fullName = fullName || '';
    req.session.role = role || 'technician';
    req.session.preferredLanguage = initialLanguage;

    res.json({ ok: true, email: email.toLowerCase(), fullName: fullName || '', preferredLanguage: initialLanguage });
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
      req.session.preferredLanguage = user.preferredLanguage || 'en';

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
      db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(passwordHash, reset.userId);
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