require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const session = require('express-session');
const bcrypt = require('bcrypt');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

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
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 8
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
      role: req.session.role
    });
  }

  res.json({ loggedIn: false });
});

app.post('/api/diagnose', requireAuth, aiLimiter, async function (req, res) {
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
    photo,
    language
  } = req.body;

  if (!description || description.trim().length < 20) {
    return res.status(400).json({ error: 'Description too short.' });
  }

    const briefs = {
    fault: 'You are assisting a field service technician with a fault diagnosis. Give likely causes and the checks to run, in order.',
    installation: 'You are assisting a field service engineer with an equipment installation or commissioning. Give the checks and steps for this stage, and flag anything that must be verified before handover.',
    'after-sales': 'You are assisting with an after-sales support case on equipment already installed. Give likely causes, what to check, and whether this needs a site visit or can be resolved remotely.',
    application: 'You are assisting a field application specialist with an application or process concern. Assess the likely cause, suggest how to troubleshoot it, and recommend corrective actions including any contamination or process-control measures.'
  };

  const brief = briefs[requestType] || briefs.fault;

  const photoNote = photo && photo.data
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

  const prompt =
    brief + '\n\n' +
    context +
    'Reported: ' + description + '\n\n' +
    'Keep it under 200 words. Write in plain prose with no Markdown formatting — no asterisks, hashes, or bullet symbols. ' +
    'Note any safety precautions first if they apply.' + photoNote + languageInstruction(language);

  try {
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

    res.json({ diagnosis: message.content[0].text });
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: 'Diagnosis service unavailable.' });
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

  const systemPrompt =
    'You are Tervexa, assisting field service engineers, technicians and application specialists ' +
    'across engineering and non-engineering fields. Answer practically and concisely. ' +
    'Ask a clarifying question if the request is ambiguous. Note safety precautions where they apply. ' +
    'Write in plain prose with no Markdown formatting. Keep answers under 250 words unless more detail is clearly needed.' +
    languageInstruction(language);

  try {
    const reply = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 700,
      system: systemPrompt,
      messages: messages
    });

    res.json({ reply: reply.content[0].text });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat service unavailable.' });
  }
});

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
    const bump = db.transaction(function () {
      db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run('report');
      const row = db.prepare('SELECT value FROM counters WHERE name = ?').get('report');
      return row.value;
    });

    const nextNumber = bump();
    const newId = 'F-' + String(nextNumber).padStart(3, '0');

    const stmt = db.prepare(`
      INSERT INTO reports (
        id, technician, equipment, location, requestType, type, severity, onset,
        installStage, equipmentModel, timeSinceInstall, warrantyStatus,
        applicationImpact, recurring, date, status, description, diagnosis,
        rootCause, resolutionNotes, resolvedDate, userId
      ) VALUES (
        @id, @technician, @equipment, @location, @requestType, @type, @severity, @onset,
        @installStage, @equipmentModel, @timeSinceInstall, @warrantyStatus,
        @applicationImpact, @recurring, @date, @status, @description, @diagnosis,
        @rootCause, @resolutionNotes, @resolvedDate, @userId
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
      // Taken from the session, not the request body — the client can't
      // claim to be someone else's report.
      userId: req.session.userId
    });

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
  const { email, password, fullName, phone, company, role } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  if (role && !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());

    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    if (phone) {
      const existingPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);

      if (existingPhone) {
        return res.status(409).json({ error: 'An account with that phone number already exists.' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = db.prepare(`
      INSERT INTO users (email, passwordHash, fullName, phone, company, role, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      email.toLowerCase(),
      passwordHash,
      fullName || '',
      phone || '',
      company || '',
      role || 'technician',
      new Date().toISOString()
    );

    req.session.userId = result.lastInsertRowid;
    req.session.email = email.toLowerCase();
    req.session.fullName = fullName || '';
    req.session.role = role || 'technician';

    res.json({ ok: true, email: email.toLowerCase(), fullName: fullName || '' });
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

    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.fullName = user.fullName;
    req.session.role = user.role;

    // "Remember me" extends the session cookie to 30 days; unchecked, it
    // keeps the default 8-hour session set up above. This has to be set
    // per-login, not in the global session() config, since it depends on
    // what the person actually ticked on the form.
    if (rememberMe) {
      req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
    }

    res.json({ ok: true, email: user.email, fullName: user.fullName, role: user.role });
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

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
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