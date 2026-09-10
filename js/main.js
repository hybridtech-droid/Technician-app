let currentFaultId = null;
let chatMessages = [];

// Mirrors the server's password rule exactly (see PASSWORD_PATTERN in
// server.js) — at least 8 characters, with at least one letter and one
// number. Checking it here too means someone gets told about a weak
// password immediately, instead of only after a round trip to the server.
// Returns an error message string, or null if the password is valid.
function passwordError(password) {
  if (!password || password.length < 8) {
    return t('errors.passwordTooShort');
  }

  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return t('errors.passwordNeedsLetterNumber');
  }

  return null;
}
let allFaults = [];

function redirectToLogin() {
  let path = window.location.pathname;
  let onAuthPage = path.endsWith('login.html') || path.endsWith('signup.html');

  if (!onAuthPage) {
    window.location.href = 'login.html';
  }
}

// Turns a button into a two-click confirmation instead of a native
// window.confirm() dialog — the first click swaps the label to a "click
// again to confirm" prompt for a few seconds; a second click within that
// window actually runs the action. Clicking elsewhere, or letting it time
// out, reverts the button with nothing having happened. Used for anything
// destructive (deleting a report, deactivating an account) that shouldn't
// fire on a single accidental click.
function armConfirmButton(button, confirmText, onConfirm) {
  let armed = false;
  let originalText = button.textContent;
  let resetTimer = null;

  function reset() {
    armed = false;
    button.textContent = originalText;
    button.classList.remove('btn-confirm-armed');
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
  }

  button.addEventListener('click', function () {
    if (!armed) {
      originalText = button.textContent;
      armed = true;
      button.textContent = confirmText;
      button.classList.add('btn-confirm-armed');
      resetTimer = setTimeout(reset, 4000);
      return;
    }

    reset();
    onConfirm();
  });

  document.addEventListener('click', function (e) {
    if (armed && e.target !== button) {
      reset();
    }
  });
}

function readPhotoAsBase64(file) {
  return new Promise(function (resolve, reject) {
    let reader = new FileReader();

    reader.onload = function () {
      let img = new Image();

      img.onload = function () {
        let maxSide = 1200;
        let scale = Math.min(1, maxSide / Math.max(img.width, img.height));

        let canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);

        let ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        let dataUrl = canvas.toDataURL('image/jpeg', 0.8);

        resolve({
          data: dataUrl.split(',')[1],
          mediaType: 'image/jpeg'
        });
      };

      img.onerror = function () {
        reject(new Error('Could not read the photo.'));
      };

      img.src = reader.result;
    };

    reader.onerror = function () {
      reject(new Error('Could not read the photo.'));
    };

    reader.readAsDataURL(file);
  });
}

// getStoredLanguage(), setStoredLanguage(), t(), applyTranslations(), and
// initLanguage() all live in js/i18n.js, loaded before this file.

// /api/diagnose streams its response as plain text rather than one JSON
// body (see the route's own comment in server.js) specifically so this can
// hand words to onChunk as they arrive — the model's total generation time
// is unchanged, but whoever's waiting sees the diagnosis build up in real
// time instead of a static "Analysing..." message for the whole several-
// second round trip. onChunk is optional so any future caller that just
// wants the finished text can still await this normally.
async function getDiagnosis(payload, onChunk) {
  const response = await fetch('/api/diagnose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, payload, { language: getStoredLanguage() }))
  });

  if (response.status === 401) {
    redirectToLogin();
    throw new Error('Not logged in');
  }

  if (!response.ok || !response.body) {
    // A pre-stream failure (bad input, no API key, rate limited) comes back
    // as JSON with an error field — a mid-stream failure instead just ends
    // the body early (see the route), which the reader loop below treats
    // as "stop reading", not an error.
    let message = 'Diagnosis request failed';
    try {
      const data = await response.json();
      if (data && data.error) {
        message = data.error;
      }
    } catch (err) {
      // Body wasn't JSON (or was already consumed) — fall back to the
      // generic message above rather than letting this secondary failure
      // mask the real one.
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunkText = decoder.decode(value, { stream: true });
    full += chunkText;
    if (onChunk) {
      onChunk(full);
    }
  }

  if (!full) {
    throw new Error('Diagnosis service unavailable.');
  }

  return full;
}

async function sendChatMessage(messages) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: messages, language: getStoredLanguage() })
  });

  if (response.status === 401) {
    redirectToLogin();
    throw new Error('Not logged in');
  }

  if (!response.ok) {
    let errData = {};
    try {
      errData = await response.json();
    } catch (err) {
      // fall back to the generic error below
    }
    // A refusal means the assistant looked at this specific message and
    // declined to answer — not that the service is unreachable. Flagging
    // it lets the caller show a message that matches what actually
    // happened instead of a generic connectivity error.
    let chatErr = new Error(errData.error || 'Chat request failed');
    chatErr.isRefusal = Boolean(errData.refusal);
    throw chatErr;
  }

  const data = await response.json();
  return data.reply;
}

function addChatBubble(text, role, channel) {
  let chatWindow = document.getElementById('chat-window');
  let bubble = document.createElement('div');

  bubble.className = 'chat-message chat-message--' + role;

  // A message that came in over WhatsApp gets a small label so it's clear
  // this conversation is shared across both — not two separate histories
  // that happen to look similar.
  if (channel === 'whatsapp') {
    let tag = document.createElement('span');
    tag.className = 'chat-channel-tag';
    tag.textContent = 'WhatsApp';
    bubble.appendChild(tag);
  }

  let body = document.createElement('span');
  body.textContent = text.replace(/\*\*/g, '');
  bubble.appendChild(body);

  chatWindow.appendChild(bubble);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  return bubble;
}

// Loads the account's conversation history (from either channel) so a
// question asked over WhatsApp shows up here, and vice versa — this is
// what makes "linked to the user profile" actually visible, not just true
// in the database.
async function loadConversationHistory() {
  let chatWindow = document.getElementById('chat-window');

  if (!chatWindow) {
    return;
  }

  try {
    const response = await fetch('/api/conversation');

    if (response.status === 401) {
      redirectToLogin();
      return;
    }

    if (!response.ok) {
      return;
    }

    const history = await response.json();

    history.forEach(function (msg) {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      addChatBubble(msg.content, role, msg.channel);
      chatMessages.push({ role: msg.role, content: msg.content });
    });
  } catch (err) {
    console.error('Could not load conversation history:', err);
  }
}

async function fetchFaults() {
  const response = await fetch('/api/reports');

  if (response.status === 401) {
    redirectToLogin();
    throw new Error('Not logged in');
  }

  if (!response.ok) {
    throw new Error('Could not load reports');
  }

  allFaults = await response.json();
  return allFaults;
}

function loadFaults() {
  return allFaults;
}

async function saveFault(fault) {
  const response = await fetch('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fault)
  });

  if (response.status === 401) {
    redirectToLogin();
    throw new Error('Not logged in');
  }

  if (!response.ok) {
    // A blocked-by-plan-limit response carries its own explanation
    // (checkReportLimit's message in server.js) — surface that instead of
    // a generic failure, and flag it so the caller can point at
    // billing.html rather than treating this like any other error.
    let data = await response.json().catch(function () { return {}; });
    let err = new Error(data.error || 'Could not save report');
    err.upgradeRequired = Boolean(data.upgradeRequired);
    throw err;
  }

  const result = await response.json();
  await fetchFaults();
  return { id: result.id, overLimit: result.overLimit };
}

function findFaultById(id) {
  let faults = loadFaults();
  let match = null;

  faults.forEach(function (fault) {
    if (fault.id === id) {
      match = fault;
    }
  });

  return match;
}

function buildReportSummary(fault) {
  let parts = [];

  parts.push('Report ' + fault.id + ' (' + prettyLabel(fault.requestType || 'fault') + ')');
  parts.push('Equipment: ' + fault.equipment);
  parts.push('Location: ' + fault.location);

  if (fault.type) {
    parts.push('Fault category: ' + prettyLabel(fault.type));
  }
  if (fault.severity) {
    parts.push('Severity: ' + prettyLabel(fault.severity));
  }
  if (fault.onset) {
    parts.push('Onset: ' + prettyLabel(fault.onset));
  }

  parts.push('Reported: ' + (fault.description || 'No description recorded.'));

  return parts.join('\n');
}

async function updateFaultStatus(id, newStatus) {
  const body = {
    status: newStatus,
    rootCause: '',
    resolutionNotes: '',
    resolvedDate: ''
  };

  const response = await fetch('/api/reports/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (response.status === 401) {
    redirectToLogin();
    throw new Error('Not logged in');
  }

  if (!response.ok) {
    throw new Error('Could not update status');
  }

  await fetchFaults();
  return true;
}

async function saveResolution(id, rootCause, notes) {
  const body = {
    status: 'Resolved',
    rootCause: rootCause,
    resolutionNotes: notes,
    resolvedDate: new Date().toLocaleDateString('en-GB')
  };

  const response = await fetch('/api/reports/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (response.status === 401) {
    redirectToLogin();
    throw new Error('Not logged in');
  }

  if (!response.ok) {
    throw new Error('Could not save resolution');
  }

  await fetchFaults();
  return true;
}

function prettyLabel(value) {
  let labels = {
    electrical: 'Electrical',
    mechanical: 'Mechanical',
    electronic: 'Electronic and instrumentation',
    hvac: 'HVAC and refrigeration',
    software: 'Software and controls',
    structural: 'Structural and civil',
    biomedical: 'Biomedical',
    other: 'Other',
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    fault: 'Fault',
    installation: 'Installation',
    'after-sales': 'After-sales',
    application: 'Application',
    'under-1-month': 'Under 1 month',
    '1-6-months': '1 to 6 months',
    '6-12-months': '6 to 12 months',
    '1-3-years': '1 to 3 years',
    'over-3-years': 'Over 3 years',
    'under-warranty': 'Under warranty',
    'service-contract': 'Under service contract',
    expired: 'Expired',
    unknown: 'Not known',
    'pre-site': 'Pre-site survey',
    delivery: 'Delivery and unpacking',
    assembly: 'Assembly and positioning',
    connection: 'Power, water or network connection',
    calibration: 'Calibration and verification',
    handover: 'Handover and sign-off',
    'output-quality': 'Output or result quality',
    throughput: 'Throughput or speed',
    contamination: 'Contamination or carryover',
    'calibration-drift': 'Calibration or accuracy drift',
    'user-technique': 'User technique or workflow',
    consumables: 'Consumables or reagents',
    'first-time': 'First time observed',
    intermittent: 'Intermittent',
    consistent: 'Happens consistently',
    consumable: 'Consumable or reagent',
    worsening: 'Getting worse over time',
    'component-failure': 'Component failure',
    wear: 'Normal wear',
    'installation-error': 'Installation or setup error',
    'user-error': 'User or operator error',
    'power-supply': 'Power supply or environment',
    'no-fault-found': 'No fault found'
  };
  return labels[value] || value;
}

// --- AI diagnosis: animated step-by-step resolution guide ---------------
// Deliberately an ABSTRACT process diagram (Prepare -> Inspect -> Test ->
// Resolve -> Confirm), not a rendering of what's actually happening inside
// the equipment. An AI-generated "simulation" of a specific instrument's
// real internals (e.g. a vacuum manifold mid-fault) can look convincing
// and still be mechanically wrong — and a technician trusting a wrong
// picture while servicing real equipment is worse than no picture at all.
// So this always shows the same five generic, safe steps; only the
// wording under each one changes: instantly, from the report's own fields
// (buildGenericDiagSteps — no network call, no added wait), or on request,
// rewritten by the AI to match the specific report more closely
// (fetchTailoredDiagSteps) — same five steps, same safe framing, just
// better-targeted phrasing.
const DIAG_STEP_KEYS = ['prepare', 'inspect', 'test', 'resolve', 'confirm'];

const DIAG_STEP_ICONS = {
  prepare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  inspect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  test: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"/><path d="M12 12 15 8.5"/><path d="M12 4v1.5"/></svg>',
  resolve: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.75-3.75a6 6 0 0 1-7.94 7.93l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/></svg>',
  confirm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
};

const DIAG_REQUEST_ICONS = {
  fault: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.75-3.75a6 6 0 0 1-7.94 7.93l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/></svg>',
  installation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
  'after-sales': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Zm-18 0a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3Z"/></svg>',
  application: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M10 3v6.5L4.8 18a1 1 0 0 0 .9 1.5h12.6a1 1 0 0 0 .9-1.5L14 9.5V3"/></svg>'
};

// diag.anim.detail.<segment>.<step> i18n keys use camelCase segments —
// 'after-sales' (the actual requestType value throughout the rest of this
// app) isn't a valid bare identifier, so afterSales is the on-disk key
// segment for that one case only; this map is what bridges the two.
const DIAG_REQUEST_I18N_SEGMENT = {
  fault: 'fault',
  installation: 'installation',
  'after-sales': 'afterSales',
  application: 'application'
};

function diagCategoryLabelFor(fields) {
  let requestType = fields.requestType || 'fault';
  if (requestType === 'fault' && fields.faultType) {
    return prettyLabel(fields.faultType).toLowerCase();
  }
  if (requestType === 'application' && fields.applicationImpact) {
    return prettyLabel(fields.applicationImpact).toLowerCase();
  }
  return prettyLabel(requestType).toLowerCase();
}

// fields: { requestType, equipment, faultType, applicationImpact }. Same
// shape whether it's read live off the report form or off a saved fault
// record — see the two call sites below.
function buildGenericDiagSteps(fields) {
  let requestType = fields.requestType || 'fault';
  let segment = DIAG_REQUEST_I18N_SEGMENT[requestType] || 'fault';
  let equipment = fields.equipment || t('diag.anim.genericEquipment');
  let category = diagCategoryLabelFor(fields);

  return DIAG_STEP_KEYS.map(function (stepKey) {
    let detail = t('diag.anim.detail.' + segment + '.' + stepKey)
      .replace(/\{equipment\}/g, equipment)
      .replace(/\{category\}/g, category);
    return { title: t('diag.anim.step.' + stepKey), detail: detail };
  });
}

// Tracks the last-rendered state per container (fields/steps/tailored) so
// a language switch can redraw it — see the tervexa:languagechange
// listener below. Keyed by the container element itself since there are
// two of these on the page at different times (fault-report.html's live
// result, fault-log.html's saved-fault detail panel).
const diagAnimState = new WeakMap();

// Renders (or re-renders) the five-step track into container. steps is the
// array buildGenericDiagSteps()/fetchTailoredDiagSteps() returns —
// [{title, detail}, ...], always exactly DIAG_STEP_KEYS.length long.
function renderDiagAnimation(container, fields, steps, tailored) {
  if (!container) {
    return;
  }

  diagAnimState.set(container, { fields: fields, steps: steps, tailored: Boolean(tailored) });

  let requestType = fields.requestType || 'fault';
  let badge = container.querySelector('.diag-anim-badge');
  if (badge) {
    badge.innerHTML = DIAG_REQUEST_ICONS[requestType] || DIAG_REQUEST_ICONS.fault;
  }

  let headingEl = container.querySelector('.diag-anim-heading');
  if (headingEl) {
    headingEl.innerHTML = '';
    headingEl.appendChild(document.createTextNode(t('diag.anim.heading')));
    if (tailored) {
      let tag = document.createElement('span');
      tag.className = 'diag-anim-tailored-tag';
      tag.textContent = t('diag.anim.tailoredTag');
      headingEl.appendChild(tag);
    }
  }

  let track = container.querySelector('.diag-anim-track');
  if (!track) {
    return;
  }
  track.innerHTML = '';

  steps.forEach(function (step, i) {
    let stepEl = document.createElement('div');
    stepEl.className = 'diag-anim-step';
    stepEl.style.animationDelay = (i * 0.18) + 's';

    let iconCol = document.createElement('div');
    iconCol.className = 'diag-anim-icon-col';

    let icon = document.createElement('div');
    icon.className = 'diag-anim-icon';
    icon.innerHTML = DIAG_STEP_ICONS[DIAG_STEP_KEYS[i]] || DIAG_STEP_ICONS.prepare;
    iconCol.appendChild(icon);

    if (i < steps.length - 1) {
      let connector = document.createElement('div');
      connector.className = 'diag-anim-connector';
      connector.style.animationDelay = (i * 0.18 + 0.12) + 's';
      iconCol.appendChild(connector);
    }

    stepEl.appendChild(iconCol);

    let body = document.createElement('div');
    body.className = 'diag-anim-body';

    let titleEl = document.createElement('div');
    titleEl.className = 'diag-anim-step-title';
    titleEl.textContent = step.title;
    body.appendChild(titleEl);

    let detailEl = document.createElement('div');
    detailEl.className = 'diag-anim-step-detail';
    detailEl.textContent = step.detail;
    body.appendChild(detailEl);

    stepEl.appendChild(body);
    track.appendChild(stepEl);
  });
}

// Asks the model to rewrite just the five step details (not the titles,
// not the step count or order) so they speak to the specifics of this one
// report — same abstract, safe five-step shape, better-targeted wording.
// Returns null on any failure (bad JSON, wrong shape, network/auth error)
// so the caller can fall back to the generic version rather than show a
// broken or partial result.
async function fetchTailoredDiagSteps(fields, description, diagnosis) {
  const response = await fetch('/api/diagnose/animate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestType: fields.requestType,
      equipment: fields.equipment,
      faultType: fields.faultType,
      applicationImpact: fields.applicationImpact,
      description: description,
      diagnosis: diagnosis,
      language: getStoredLanguage()
    })
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.details) || data.details.length !== DIAG_STEP_KEYS.length) {
    return null;
  }

  return DIAG_STEP_KEYS.map(function (stepKey, i) {
    return { title: t('diag.anim.step.' + stepKey), detail: String(data.details[i] || '').trim() };
  });
}

// Wires the "Generate a version tailored to this report" button that sits
// under an already-rendered generic animation. Shared by fault-report.html
// (a report just submitted, diagnosis in hand) and fault-log.html's detail
// panel (a saved report, reusing its stored diagnosis text) — both call
// this once, right after they've called renderDiagAnimation() with the
// generic version.
function wireDiagAnimationTailorButton(container, fields, description, diagnosis) {
  let existingBtn = container.querySelector('.diag-anim-tailor-btn');
  let errorEl = container.querySelector('.diag-anim-tailor-error');
  if (!existingBtn) {
    return;
  }

  // This can run more than once against the same DOM (browsing between
  // faults in the log's detail panel, or submitting more than one report
  // in a single page session) — renderDiagAnimation() rebuilds the track
  // but leaves this button element in place, so a plain addEventListener
  // here would stack a new click handler (closed over the OLD fields/
  // description/diagnosis) on top of every previous one. Cloning the node
  // drops any listeners from a prior call before attaching this call's.
  let btn = existingBtn.cloneNode(true);
  existingBtn.parentNode.replaceChild(btn, existingBtn);

  btn.textContent = t('diag.anim.tailorButton');
  btn.hidden = false;
  if (errorEl) {
    errorEl.hidden = true;
  }

  btn.addEventListener('click', async function () {
    btn.disabled = true;
    let originalText = btn.textContent;
    btn.textContent = t('diag.anim.tailorLoading');
    if (errorEl) {
      errorEl.hidden = true;
    }

    try {
      let tailoredSteps = await fetchTailoredDiagSteps(fields, description, diagnosis);
      if (!tailoredSteps) {
        throw new Error('No tailored steps returned');
      }
      renderDiagAnimation(container, fields, tailoredSteps, true);
      btn.hidden = true;
    } catch (err) {
      console.error('Tailored diagnosis animation failed:', err);
      btn.disabled = false;
      btn.textContent = originalText;
      if (errorEl) {
        errorEl.textContent = t('diag.anim.tailorError');
        errorEl.hidden = false;
      }
    }
  });
}

// buildGenericDiagSteps()/renderDiagAnimation() build all their text with
// t() calls at render time, not [data-i18n] attributes on static markup —
// same situation billing.html's plan grid had — so switching language only
// re-translates an already-rendered diagram if something re-runs it after
// the switch. Whichever of the two diag-anim containers is on the current
// page (fault-report.html's live result or fault-log.html's saved-fault
// detail panel) gets redrawn here if it's currently showing something.
//
// A tailored version keeps its AI-generated step DETAILS as-is (that text
// was generated in whichever language was selected at request time, same
// as the diagnosis text itself — it doesn't get retranslated) but still
// refreshes the step TITLES, which are i18n keys like everything else.
document.addEventListener('tervexa:languagechange', function () {
  [document.getElementById('diagnosis-animation'), document.getElementById('detail-diagnosis-animation')].forEach(function (container) {
    if (!container || container.hidden) {
      return;
    }
    let state = diagAnimState.get(container);
    if (!state) {
      return;
    }

    let freshSteps = state.tailored
      ? state.steps.map(function (step, i) { return { title: t('diag.anim.step.' + DIAG_STEP_KEYS[i]), detail: step.detail }; })
      : buildGenericDiagSteps(state.fields);

    renderDiagAnimation(container, state.fields, freshSteps, state.tailored);

    // renderDiagAnimation() only touches the badge/heading/track — the
    // tailor button and error hint are static i18n strings set once when
    // the button was wired (see wireDiagAnimationTailorButton), so refresh
    // those separately rather than re-wiring, which would touch the click
    // handler for no reason.
    let btn = container.querySelector('.diag-anim-tailor-btn');
    if (btn && !btn.disabled && !btn.hidden) {
      btn.textContent = t('diag.anim.tailorButton');
    }
    let errorEl = container.querySelector('.diag-anim-tailor-error');
    if (errorEl && !errorEl.hidden) {
      errorEl.textContent = t('diag.anim.tailorError');
    }
  });
});

function showFaultDetail(fault) {
  let panel = document.getElementById('fault-detail');

  if (!panel) {
    return;
  }
    currentFaultId = fault.id;

  document.getElementById('detail-title').textContent =
    fault.id + ' — ' + fault.equipment;

  let metaParts = [];

  metaParts.push(prettyLabel(fault.requestType || 'fault'));

  if (fault.type) {
    metaParts.push(prettyLabel(fault.type));
  }
  if (fault.severity) {
    metaParts.push(prettyLabel(fault.severity));
  }

  metaParts.push(fault.location);
  metaParts.push('reported ' + fault.date);
  // Always includes the reporting account's email here (not just when a
  // name collides, unlike the table row below) — this is a single report's
  // full detail view, so there's room, and it's useful context regardless.
  metaParts.push('by ' + fault.technician + (fault.reporterEmail ? ' (' + fault.reporterEmail + ')' : ''));

  document.getElementById('detail-meta').textContent = metaParts.join(' · ');

  let extras = [];

  if (fault.equipmentModel) {
    extras.push('Model: ' + fault.equipmentModel);
  }
  if (fault.installStage) {
    extras.push('Stage: ' + prettyLabel(fault.installStage));
  }
  if (fault.timeSinceInstall) {
    extras.push('Time since install: ' + prettyLabel(fault.timeSinceInstall));
  }
  if (fault.warrantyStatus) {
    extras.push('Warranty: ' + prettyLabel(fault.warrantyStatus));
  }
  if (fault.applicationImpact) {
    extras.push('Affected: ' + prettyLabel(fault.applicationImpact));
  }
  if (fault.recurring) {
    extras.push('Recurrence: ' + prettyLabel(fault.recurring));
  }

  let extrasEl = document.getElementById('detail-extras');
  extrasEl.textContent = extras.join('  ·  ');
  extrasEl.hidden = extras.length === 0;

  document.getElementById('detail-description').textContent =
    fault.description || 'No description recorded for this report.';

  document.getElementById('detail-diagnosis').textContent =
    fault.diagnosis || 'No diagnosis recorded.';

  // Same instant-generic-then-optional-tailor animation as the report page,
  // just re-hydrated from a saved fault's own fields instead of a live form.
  let detailAnimBox = document.getElementById('detail-diagnosis-animation');
  if (detailAnimBox) {
    if (fault.diagnosis) {
      let detailDiagFields = {
        requestType: fault.requestType || 'fault',
        equipment: fault.equipment,
        faultType: fault.type,
        applicationImpact: fault.applicationImpact
      };
      renderDiagAnimation(detailAnimBox, detailDiagFields, buildGenericDiagSteps(detailDiagFields), false);
      detailAnimBox.hidden = false;
      wireDiagAnimationTailorButton(detailAnimBox, detailDiagFields, fault.description || '', fault.diagnosis);
    } else {
      detailAnimBox.hidden = true;
    }
  }

  document.getElementById('detail-status').value = fault.status;

  let resDisplay = document.getElementById('resolution-display');

  if (resDisplay) {
    if (fault.resolutionNotes) {
      document.getElementById('resolution-meta').textContent =
        'Root cause: ' + prettyLabel(fault.rootCause) +
        '  ·  Resolved ' + fault.resolvedDate;
      document.getElementById('resolution-text').textContent = fault.resolutionNotes;
      resDisplay.hidden = false;
    } else {
      resDisplay.hidden = true;
    }
  }

  let resFields = document.getElementById('resolution-fields');

  if (resFields) {
    resFields.hidden = true;
  }

  let chatLink = document.getElementById('detail-chat');

  if (chatLink) {
    chatLink.href = 'chat.html?report=' + encodeURIComponent(fault.id);
  }

  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth' });
}

function applyRequestType(type) {
    let groupClasses = {
    fault: 'fault-only',
    installation: 'install-only',
    'after-sales': 'aftersales-only',
    application: 'application-only'
  };

  Object.keys(groupClasses).forEach(function (key) {
    let show = key === type;
    let groups = document.querySelectorAll('.' + groupClasses[key]);

    groups.forEach(function (group) {
      group.hidden = !show;

      let inputs = group.querySelectorAll('input, select, textarea');
      inputs.forEach(function (input) {
        if (input.type === 'radio') {
          input.required = false;
        } else {
          input.required = show;
        }
      });
    });
  });

  let descriptionLabel = document.getElementById('description-label');
  let labels = {
    fault: t('report.descriptionLabel.fault'),
    installation: t('report.descriptionLabel.installation'),
    'after-sales': t('report.descriptionLabel.afterSales'),
    application: t('report.descriptionLabel.application')
  };

  if (descriptionLabel) {
    descriptionLabel.textContent = labels[type] || labels.fault;
  }

    let wording = {
    fault: {
      title: t('report.pageTitle'),
      subtitle: t('report.pageSubtitle'),
      button: t('report.submit'),
      result: t('report.resultTitle')
    },
    installation: {
      title: t('report.wording.installation.title'),
      subtitle: t('report.wording.installation.subtitle'),
      button: t('report.wording.installation.button'),
      result: t('report.wording.installation.result')
    },
    'after-sales': {
      title: t('report.wording.afterSales.title'),
      subtitle: t('report.wording.afterSales.subtitle'),
      button: t('report.wording.afterSales.button'),
      result: t('report.wording.afterSales.result')
    },
    application: {
      title: t('report.wording.application.title'),
      subtitle: t('report.wording.application.subtitle'),
      button: t('report.wording.application.button'),
      result: t('report.wording.application.result')
    }
  };

  let text = wording[type] || wording.fault;

  let pageTitle = document.getElementById('page-title');
  let pageSubtitle = document.getElementById('page-subtitle');
  let submitButton = document.getElementById('submit-button');
  let resultTitle = document.getElementById('result-title');

  if (pageTitle) {
    pageTitle.textContent = text.title;
  }
  if (pageSubtitle) {
    pageSubtitle.textContent = text.subtitle;
  }
  if (submitButton) {
    submitButton.textContent = text.button;
  }
  if (resultTitle) {
    resultTitle.textContent = text.result;
  }
}

// Hides the request-type options that fall outside the signed-in account's
// role scope (see ROLE_REQUEST_TYPES in server.js — meData.allowedRequestTypes
// is that same mapping, already resolved for whichever role is signed in,
// so nothing here needs its own copy of the mapping). allowedRequestTypes
// is null for a role that's never scoped, and hybridMode:true means "show
// everything regardless of role" — both cases leave every option visible.
// A no-op on any page without a #request-type element, so it's safe to
// call from anywhere (e.g. right after the hybrid-mode toggle changes).
function applyRoleRequestTypeScope(meData) {
  let select = document.getElementById('request-type');

  if (!select || !meData) {
    return;
  }

  let allowed = meData.allowedRequestTypes;
  let unrestricted = !allowed || meData.hybridMode;
  let options = Array.prototype.slice.call(select.options);
  let selectedOptionIsHidden = false;

  options.forEach(function (option) {
    if (!option.value) {
      return;
    }

    let inScope = unrestricted || allowed.includes(option.value);
    option.hidden = !inScope;
    option.disabled = !inScope;

    if (!inScope && option.selected) {
      selectedOptionIsHidden = true;
    }
  });

  if (selectedOptionIsHidden) {
    let firstVisible = options.find(function (option) { return option.value && !option.hidden; });
    if (firstVisible) {
      select.value = firstVisible.value;
    }
  }

  applyRequestType(select.value);
}

function renderRootCauses() {
  let container = document.getElementById('root-cause-summary');
  let list = document.getElementById('cause-list');

  if (!container || !list) {
    return;
  }

  let faults = loadFaults();

  let filterEl = document.getElementById('cause-filter');
  let filter = filterEl ? filterEl.value : 'all';

  let anyResolved = faults.some(function (f) {
    return Boolean(f.rootCause);
  });

  container.hidden = !anyResolved;
  list.innerHTML = '';

  if (!anyResolved) {
    return;
  }

  let counts = {};

  faults.forEach(function (fault) {
    let typeMatches = filter === 'all' || (fault.requestType || 'fault') === filter;

    if (fault.rootCause && typeMatches) {
      if (counts[fault.rootCause]) {
        counts[fault.rootCause] = counts[fault.rootCause] + 1;
      } else {
        counts[fault.rootCause] = 1;
      }
    }
  });

  let causes = Object.keys(counts);

  if (causes.length === 0) {
    let empty = document.createElement('li');
    empty.textContent = t('log.noResolvedInCategory');
    list.appendChild(empty);
    return;
  }

  causes.sort(function (a, b) {
    return counts[b] - counts[a];
  });

  causes.forEach(function (cause) {
    let item = document.createElement('li');
    let label = document.createElement('span');
    let count = document.createElement('span');

    label.textContent = prettyLabel(cause);
    count.textContent = counts[cause];
    count.className = 'cause-count';

    item.appendChild(label);
    item.appendChild(count);
    list.appendChild(item);
  });
}

function seedChatFromReport() {
  let chatWindow = document.getElementById('chat-window');

  if (!chatWindow) {
    return;
  }

  let params = new URLSearchParams(window.location.search);
  let reportId = params.get('report');

  if (!reportId) {
    return;
  }

  let fault = findFaultById(reportId);

  if (!fault) {
    return;
  }

  let summary = buildReportSummary(fault);

  addChatBubble('Continuing from ' + fault.id + '.\n\n' + summary, 'user');
  chatMessages.push({
    role: 'user',
    content: 'I submitted this report:\n\n' + summary
  });

  addChatBubble(fault.diagnosis || 'No diagnosis recorded.', 'assistant');
  chatMessages.push({
    role: 'assistant',
    content: fault.diagnosis || 'No diagnosis was recorded for this report.'
  });
}

// Lets someone wipe the shared account conversation (web + WhatsApp) and
// start fresh, instead of the "Ask AI" page always carrying every past
// exchange forward forever (see loadConversationHistory() above). Uses
// the same two-click armConfirmButton pattern as deleting a report, since
// this deletes the account's saved chat history on the server and can't
// be undone.
function wireClearChatButton() {
  let btn = document.getElementById('clear-chat-btn');
  let chatWindow = document.getElementById('chat-window');
  let errorEl = document.getElementById('clear-chat-error');

  if (!btn || !chatWindow) {
    return;
  }

  armConfirmButton(btn, t('chat.clearChatConfirm'), async function () {
    if (errorEl) {
      errorEl.hidden = true;
    }
    btn.disabled = true;

    try {
      const response = await fetch('/api/conversation', { method: 'DELETE' });

      if (response.status === 401) {
        redirectToLogin();
        return;
      }

      if (!response.ok) {
        throw new Error('Could not clear conversation');
      }

      chatMessages = [];
      chatWindow.innerHTML = '';
      addChatBubble(t('chat.welcomeMessage'), 'assistant');
    } catch (err) {
      console.error('Could not clear conversation:', err);
      if (errorEl) {
        errorEl.textContent = t('chat.clearChatError');
        errorEl.hidden = false;
      }
    } finally {
      btn.disabled = false;
    }
  });
}

function renderFaultLog() {
  let tbody = document.getElementById('fault-log-body');
  let emptyMessage = document.getElementById('no-faults');

  renderRootCauses();

  if (!tbody) {
    return;
  }

  let faults = loadFaults();
  let totalEl = document.getElementById('count-total');
  let openEl = document.getElementById('count-open');
  let progressEl = document.getElementById('count-progress');
  let resolvedEl = document.getElementById('count-resolved');

  let open = 0;
  let progress = 0;
  let resolved = 0;

  faults.forEach(function (fault) {
    if (fault.status === 'Open') {
      open = open + 1;
    } else if (fault.status === 'In progress') {
      progress = progress + 1;
    } else if (fault.status === 'Resolved') {
      resolved = resolved + 1;
    }
  });

  totalEl.textContent = faults.length;
  openEl.textContent = open;
  progressEl.textContent = progress;
  resolvedEl.textContent = resolved;

   tbody.innerHTML = '';

  if (faults.length === 0) {
    emptyMessage.hidden = false;
    return;
  }

  emptyMessage.hidden = true;

  // Counted once per render across the whole log (not just the filtered
  // rows below) so the "reported by" column only grows a disambiguating
  // email when two reports genuinely share a name — most rows stay clean.
  let nameCounts = {};
  faults.forEach(function (fault) {
    let key = (fault.technician || '').trim().toLowerCase();
    if (key) {
      nameCounts[key] = (nameCounts[key] || 0) + 1;
    }
  });

  let statusFilterEl = document.getElementById('filter-status');
  let typeFilterEl = document.getElementById('filter-type');

  let statusFilter = statusFilterEl ? statusFilterEl.value : 'all';
  let typeFilter = typeFilterEl ? typeFilterEl.value : 'all';

  let ordered = faults.slice().reverse().filter(function (fault) {
    let statusOk = statusFilter === 'all' || fault.status === statusFilter;
    let typeOk = typeFilter === 'all' || (fault.requestType || 'fault') === typeFilter;
    return statusOk && typeOk;
  });

  if (ordered.length === 0) {
    let row = document.createElement('tr');
    let cell = document.createElement('td');

    cell.colSpan = 8;
    cell.textContent = t('log.noReportsMatchFilters');
    cell.style.textAlign = 'center';
    cell.style.color = '#888888';

    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  ordered.forEach(function (fault) {
    let row = document.createElement('tr');

    let nameKey = (fault.technician || '').trim().toLowerCase();
    let reportedByDisplay = fault.technician;
    if (nameKey && nameCounts[nameKey] > 1 && fault.reporterEmail) {
      reportedByDisplay = fault.technician + ' (' + fault.reporterEmail + ')';
    }

    let cells = [
      fault.id,
      reportedByDisplay,
      fault.equipment,
      fault.location,
      prettyLabel(fault.requestType || 'fault'),
      fault.severity ? prettyLabel(fault.severity) : '—',
      fault.date,
      fault.status
    ];

    cells.forEach(function (value, index) {
      let cell = document.createElement('td');
      cell.textContent = value;

      if (index === 7) {
        cell.className = 'status-cell status-' + value.toLowerCase().replace(' ', '-');
      }

      row.appendChild(cell);
    });

    row.classList.add('clickable-row');
    row.addEventListener('click', function () {
      showFaultDetail(fault);
    });

    tbody.appendChild(row);
  });
}

function firstNameFrom(data) {
  if (data.fullName && data.fullName.trim().length > 0) {
    return data.fullName.trim().split(/\s+/)[0];
  }

  // Older accounts, or ones that skipped the name field, fall back to
  // whatever's before the @ in their email rather than showing nothing.
  if (data.email) {
    return data.email.split('@')[0];
  }

  return 'there';
}

// Cached so a later language switch can redraw the "Hi, <name>" / "Log out"
// nav text (built with document.createElement, so it has no [data-i18n]
// attribute for applyTranslations to find on its own) without a second
// /api/me round trip.
let lastMeData = null;

document.addEventListener('tervexa:languagechange', function () {
  if (lastMeData && lastMeData.loggedIn) {
    let nameSpan = document.getElementById('nav-username');
    let logoutLink = document.getElementById('nav-logout');
    let hybridToggle = document.getElementById('nav-hybrid-toggle');
    if (nameSpan) {
      nameSpan.textContent = t('nav.greetingPrefix') + firstNameFrom(lastMeData);
    }
    if (hybridToggle && !hybridToggle.hidden) {
      updateHybridToggleLabel(hybridToggle, lastMeData);
    }
    if (logoutLink) {
      logoutLink.textContent = t('nav.logout');
    }
  }
});

// Mirrors submitReportRoles / adminRoles in server.js — this only ever
// hides or shows a nav link, so it's not a security boundary on its own
// (the matching server-side checks are what actually enforce it), just
// what keeps someone from seeing a link to a page they'd immediately get
// redirected away from.
const SUBMIT_REPORT_ROLES = ['technician', 'field-application-specialist', 'engineer'];
const ADMIN_ROLES = ['admin'];
const DELETE_REPORT_ROLES = ['manager', 'admin'];
const EXPORT_REPORTS_ROLES = ['engineer', 'supervisor', 'manager', 'admin'];

// Keeps the nav's hybrid-mode toggle's visible text/state in sync with
// whatever /api/me most recently reported — pulled out on its own since
// both updateAuthNav() and the tervexa:languagechange handler need it.
function updateHybridToggleLabel(toggleEl, data) {
  toggleEl.textContent = data.hybridMode ? t('nav.hybridModeOn') : t('nav.hybridModeOff');
  toggleEl.title = t('nav.hybridModeTooltip');
  toggleEl.setAttribute('aria-pressed', data.hybridMode ? 'true' : 'false');
}

async function updateAuthNav() {
  let navLinksEl = document.querySelector('.nav-links');

  if (!navLinksEl) {
    return;
  }

  let loginLink = navLinksEl.querySelector('a[href="login.html"]');
  let signupLink = navLinksEl.querySelector('a[href="signup.html"]');
  let reportLink = navLinksEl.querySelector('a[href="fault-report.html"]');
  let adminLink = navLinksEl.querySelector('a[href="admin.html"]');

  try {
    let response = await fetch('/api/me');
    let data = await response.json();
    lastMeData = data;

    if (data.loggedIn) {
      if (loginLink) {
        loginLink.hidden = true;
      }
      if (signupLink) {
        signupLink.hidden = true;
      }
      if (reportLink) {
        reportLink.hidden = !SUBMIT_REPORT_ROLES.includes(data.role);
      }
      if (adminLink) {
        adminLink.hidden = !ADMIN_ROLES.includes(data.role);
      }

      let nameSpan = document.getElementById('nav-username');

      if (!nameSpan) {
        nameSpan = document.createElement('span');
        nameSpan.id = 'nav-username';
        nameSpan.className = 'nav-user';
        navLinksEl.appendChild(nameSpan);
      }

      nameSpan.textContent = t('nav.greetingPrefix') + firstNameFrom(data);

      // Only a role with a scoped request-type set (technician, engineer,
      // field-application-specialist — see ROLE_REQUEST_TYPES in
      // server.js) ever needs this; supervisor/manager/admin get
      // allowedRequestTypes: null from /api/me and never see the button,
      // since there's no restriction on them for it to lift.
      let hybridToggle = document.getElementById('nav-hybrid-toggle');

      if (data.allowedRequestTypes) {
        if (!hybridToggle) {
          hybridToggle = document.createElement('button');
          hybridToggle.type = 'button';
          hybridToggle.id = 'nav-hybrid-toggle';
          hybridToggle.className = 'nav-hybrid-toggle';

          hybridToggle.addEventListener('click', async function () {
            let nextState = !(lastMeData && lastMeData.hybridMode);
            hybridToggle.disabled = true;

            try {
              let response = await fetch('/api/hybrid-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: nextState })
              });

              if (response.ok && lastMeData) {
                lastMeData.hybridMode = nextState;
                updateHybridToggleLabel(hybridToggle, lastMeData);
                // Re-apply live, on whichever page this actually affects —
                // both are no-ops on a page without the matching element.
                applyRoleRequestTypeScope(lastMeData);
                if (typeof fetchFaults === 'function') {
                  fetchFaults().then(function () {
                    if (typeof renderFaultLog === 'function') {
                      renderFaultLog();
                    }
                  }).catch(function (err) {
                    console.error('Could not refresh reports after changing hybrid mode:', err);
                  });
                }
              }
            } catch (err) {
              console.error('Could not update hybrid mode:', err);
            } finally {
              hybridToggle.disabled = false;
            }
          });

          navLinksEl.appendChild(hybridToggle);
        }

        updateHybridToggleLabel(hybridToggle, data);
        hybridToggle.hidden = false;
      } else if (hybridToggle) {
        hybridToggle.hidden = true;
      }

      let logoutLink = document.getElementById('nav-logout');

      if (!logoutLink) {
        logoutLink = document.createElement('a');
        logoutLink.href = '#';
        logoutLink.id = 'nav-logout';
        logoutLink.className = 'nav-logout';

        logoutLink.addEventListener('click', async function (e) {
          e.preventDefault();

          try {
            await fetch('/api/logout', { method: 'POST' });
          } catch (err) {
            console.error('Logout request failed:', err);
          }

          window.location.href = 'login.html';
        });

        navLinksEl.appendChild(logoutLink);
      }

      logoutLink.textContent = t('nav.logout');
    } else {
      if (loginLink) {
        loginLink.hidden = false;
      }
      if (signupLink) {
        signupLink.hidden = false;
      }
      if (reportLink) {
        reportLink.hidden = false;
      }
      if (adminLink) {
        adminLink.hidden = true;
      }

      let existingName = document.getElementById('nav-username');
      if (existingName) {
        existingName.remove();
      }

      let existingHybridToggle = document.getElementById('nav-hybrid-toggle');
      if (existingHybridToggle) {
        existingHybridToggle.remove();
      }

      let existingLogout = document.getElementById('nav-logout');
      if (existingLogout) {
        existingLogout.remove();
      }
    }

    // Handed back so the caller can reuse this same /api/me response for
    // language resolution too, instead of a second fetch.
    return data;
  } catch (err) {
    console.error('Could not check login status:', err);
    return null;
  }
}

// Wires up every "show/hide password" button on the page (login, signup —
// works on any page with the markup, no page-specific guard needed since
// querySelectorAll just returns nothing where there's none). Each button
// carries data-toggle-password="<input id>" pointing at the field it
// controls, and two inline SVGs (.icon-eye / .icon-eye-off) it swaps via
// [hidden] rather than replacing markup. The aria-label is kept in sync
// through the same data-i18n-aria-label mechanism applyTranslations()
// uses elsewhere, so a language change mid-session (or a page reload)
// still shows the right label for whichever state the field is in.
function wireUpPasswordToggles() {
  document.querySelectorAll('.password-toggle-btn').forEach(function (btn) {
    let targetId = btn.getAttribute('data-toggle-password');
    let input = targetId ? document.getElementById(targetId) : null;

    if (!input) {
      return;
    }

    let eyeIcon = btn.querySelector('.icon-eye');
    let eyeOffIcon = btn.querySelector('.icon-eye-off');

    btn.addEventListener('click', function () {
      let showing = input.type === 'text';
      let nextShowing = !showing;

      input.type = nextShowing ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(nextShowing));

      let labelKey = nextShowing ? 'auth.hidePassword' : 'auth.showPassword';
      btn.setAttribute('data-i18n-aria-label', labelKey);
      btn.setAttribute('aria-label', t(labelKey));

      // Toggling the .hidden IDL property doesn't reliably reflect to the
      // actual `hidden` attribute on an <svg> element in every browser
      // (unlike a plain HTML element, where it's guaranteed) — it can
      // silently become a no-op JS expando instead, leaving both icons
      // visible at once. Setting the attribute directly works regardless.
      if (eyeIcon && eyeOffIcon) {
        if (nextShowing) {
          eyeIcon.setAttribute('hidden', '');
          eyeOffIcon.removeAttribute('hidden');
        } else {
          eyeIcon.removeAttribute('hidden');
          eyeOffIcon.setAttribute('hidden', '');
        }
      }

      // Re-focus the field (rather than leaving focus on the button) so
      // typing can continue right where it left off.
      input.focus();
    });
  });
}

document.addEventListener('DOMContentLoaded', async function () {

  let meData = await updateAuthNav();
  initLanguage(meData);
  wireUpPasswordToggles();

  let menuToggle = document.getElementById('menuToggle');
  let navLinks = document.querySelector('.nav-links');

  if (menuToggle && navLinks) {
    menuToggle.addEventListener('click', function () {
      navLinks.classList.toggle('open');
    });
  }

  let photoInput = document.getElementById('fault-photo');
  let fileNameDisplay = document.getElementById('file-name');

  if (photoInput && fileNameDisplay) {
    photoInput.addEventListener('change', function () {
      if (photoInput.files.length > 0) {
        fileNameDisplay.textContent = photoInput.files[0].name;
      } else {
        fileNameDisplay.textContent = t('common.noPhotoSelected');
      }
    });
  }

  let resultBox = document.getElementById('diagnosis-result');
  let resultText = document.getElementById('diagnosis-text');
  let resultChat = document.getElementById('result-chat');
  let animBox = document.getElementById('diagnosis-animation');

  let faultForm = document.getElementById('fault-form');

  if (faultForm) {
    faultForm.addEventListener('submit', async function (e) {
      e.preventDefault();
        let descriptionField = document.getElementById('fault-description');
      let descriptionError = document.getElementById('description-error');
      let description = descriptionField.value.trim();

      if (description.length < 20) {
        descriptionError.textContent = t('report.descriptionTooShortError');
        descriptionError.hidden = false;
        descriptionField.classList.add('input-invalid');
        descriptionField.focus();
        return;
      }

      descriptionError.hidden = true;
      descriptionField.classList.remove('input-invalid');

           let data = new FormData(faultForm);

           let photo = null;
           let photoField = document.getElementById('fault-photo');

           if (photoField && photoField.files.length > 0) {
             try {
               photo = await readPhotoAsBase64(photoField.files[0]);
             } catch (err) {
               console.error('Photo read failed:', err);
               photo = null;
             }
           }

      resultBox.hidden = false;
      if (resultChat) {
        resultChat.hidden = true;
      }
      if (animBox) {
        animBox.hidden = true;
      }
      resultText.textContent = t('common.analysingReport');
      resultBox.scrollIntoView({ behavior: 'smooth' });

      let diagFields = {
        requestType: data.get('request-type'),
        equipment: data.get('equipment-id'),
        faultType: data.get('fault-type'),
        applicationImpact: data.get('application-impact')
      };

      try {
        let diagnosis = await getDiagnosis({
          requestType: data.get('request-type'),
          equipment: data.get('equipment-id'),
          location: data.get('site-location'),
          description: description,
          faultType: data.get('fault-type'),
          severity: data.get('fault-severity'),
          onset: data.get('fault-onset'),
          installStage: data.get('install-stage'),
          equipmentModel: data.get('equipment-model'),
          timeSinceInstall: data.get('time-since-install'),
          warrantyStatus: data.get('warranty-status'),
          applicationImpact: data.get('application-impact'),
          recurring: data.get('recurring'),
          photo: photo
        }, function (partialText) {
          // Replaces the "Analysing your report..." placeholder the moment
          // the first words arrive, then keeps growing as more stream in —
          // this is the whole point of streaming the response instead of
          // waiting for the complete diagnosis before showing anything.
          resultText.textContent = partialText;
        });

        resultText.textContent = diagnosis;

        // The resolution-guide animation is separate from the diagnosis
        // text above: it renders instantly off the form's own fields (no
        // extra wait), then offers a button to have the AI reword it to
        // match this report more closely.
        if (animBox) {
          renderDiagAnimation(animBox, diagFields, buildGenericDiagSteps(diagFields), false);
          animBox.hidden = false;
          wireDiagAnimationTailorButton(animBox, diagFields, description, diagnosis);
        }

        let fault = {
          technician: data.get('technician-name'),
          equipment: data.get('equipment-id'),
          location: data.get('site-location'),
          requestType: data.get('request-type'),
          type: data.get('fault-type'),
          severity: data.get('fault-severity'),
          onset: data.get('fault-onset'),
          installStage: data.get('install-stage'),
          equipmentModel: data.get('equipment-model'),
          timeSinceInstall: data.get('time-since-install'),
          warrantyStatus: data.get('warranty-status'),
          applicationImpact: data.get('application-impact'),
          recurring: data.get('recurring'),
          date: new Date().toLocaleDateString('en-GB'),
          status: 'Open',
          description: description,
          diagnosis: diagnosis
        };

        let saved = await saveFault(fault);
        if (resultChat) {
          resultChat.href = 'chat.html?report=' + encodeURIComponent(saved.id);
          resultChat.hidden = false;
        }
        if (saved.overLimit) {
          resultText.textContent += '\n\n' + t('report.overLimitWarning');
        }
        faultForm.reset();
        fileNameDisplay.textContent = t('common.noPhotoSelected');
        } catch (err) {
        // A plan-limit block carries its own clear explanation from the
        // server — show that instead of the generic "couldn't reach"
        // message, since retrying won't help here, only upgrading will.
        resultText.textContent = err.upgradeRequired
          ? err.message + ' ' + t('report.upgradeLinkHint')
          : t('common.couldNotReachDiagnosis');
      }
    });
  }

  let detailStatus = document.getElementById('detail-status');
  let detailClose = document.getElementById('detail-close');

  let resolutionFields = document.getElementById('resolution-fields');
  let rootCauseField = document.getElementById('root-cause');
  let resolutionNotes = document.getElementById('resolution-notes');
  let resolutionError = document.getElementById('resolution-error');
  let saveResolutionBtn = document.getElementById('save-resolution');

  if (detailStatus) {
    detailStatus.addEventListener('change', function () {
      if (detailStatus.value === 'Resolved') {
        let existing = findFaultById(currentFaultId);

        if (existing && existing.resolutionNotes) {
          return;
        }

        if (resolutionFields) {
          resolutionFields.hidden = false;
        }
        return;
      }

      if (resolutionFields) {
        resolutionFields.hidden = true;
      }

      updateFaultStatus(currentFaultId, detailStatus.value)
        .then(function () {
          renderFaultLog();
        })
        .catch(function (err) {
          console.error('Status update failed:', err);
        });
    });
  }

    if (saveResolutionBtn) {
    saveResolutionBtn.addEventListener('click', function () {
      let cause = rootCauseField.value;
      let notes = resolutionNotes.value.trim();

      if (!cause) {
        resolutionError.textContent = 'Please select a root cause.';
        resolutionError.hidden = false;
        return;
      }

      if (notes.length < 15) {
        resolutionError.textContent =
          'Please describe what was done to resolve it — at least 15 characters.';
        resolutionError.hidden = false;
        resolutionNotes.focus();
        return;
      }

      resolutionError.hidden = true;

      saveResolution(currentFaultId, cause, notes)
        .then(function () {
          rootCauseField.value = '';
          resolutionNotes.value = '';
          resolutionFields.hidden = true;
          document.getElementById('fault-detail').hidden = true;
          renderFaultLog();
        })
        .catch(function (err) {
          console.error('Resolution save failed:', err);
          resolutionError.textContent = 'Could not save. Check your connection.';
          resolutionError.hidden = false;
        });
    });
  }

  if (detailClose) {
    detailClose.addEventListener('click', function () {
      document.getElementById('fault-detail').hidden = true;
    });
  }

  let detailDelete = document.getElementById('detail-delete');
  let detailDeleteError = document.getElementById('detail-delete-error');

  if (detailDelete) {
    detailDelete.hidden = !DELETE_REPORT_ROLES.includes(meData && meData.role);

    armConfirmButton(detailDelete, t('log.deleteReportConfirm'), function () {
      if (!currentFaultId) {
        return;
      }

      fetch('/api/reports/' + encodeURIComponent(currentFaultId), { method: 'DELETE' })
        .then(function (response) {
          if (response.status === 401) {
            redirectToLogin();
            throw new Error('Not logged in');
          }
          if (!response.ok) {
            throw new Error('Could not delete report');
          }
          return fetchFaults();
        })
        .then(function () {
          document.getElementById('fault-detail').hidden = true;
          renderFaultLog();
        })
        .catch(function (err) {
          console.error('Delete failed:', err);
          if (detailDeleteError) {
            detailDeleteError.textContent = t('log.deleteReportError');
            detailDeleteError.hidden = false;
          }
        });
    });
  }

  let logToolbar = document.getElementById('log-toolbar');

  if (logToolbar) {
    logToolbar.hidden = !EXPORT_REPORTS_ROLES.includes(meData && meData.role);

    function currentLogFilters() {
      let statusEl = document.getElementById('filter-status');
      let typeEl = document.getElementById('filter-type');
      let params = new URLSearchParams();
      if (statusEl && statusEl.value !== 'all') {
        params.set('status', statusEl.value);
      }
      if (typeEl && typeEl.value !== 'all') {
        params.set('requestType', typeEl.value);
      }
      return params;
    }

    let logPrint = document.getElementById('log-print');
    if (logPrint) {
      logPrint.addEventListener('click', function () {
        window.print();
      });
    }

    function downloadExport(format) {
      let params = currentLogFilters();
      params.set('format', format);
      window.location.href = '/api/reports/export?' + params.toString();
    }

    let exportCsv = document.getElementById('log-export-csv');
    let exportXlsx = document.getElementById('log-export-xlsx');
    let exportPdf = document.getElementById('log-export-pdf');

    if (exportCsv) {
      exportCsv.addEventListener('click', function () { downloadExport('csv'); });
    }
    if (exportXlsx) {
      exportXlsx.addEventListener('click', function () { downloadExport('xlsx'); });
    }
    if (exportPdf) {
      exportPdf.addEventListener('click', function () { downloadExport('pdf'); });
    }
  }

  let detailToolbar = document.getElementById('detail-toolbar');
  let detailToolbarLabel = document.getElementById('detail-toolbar-label');

  if (detailToolbar) {
    let canExport = EXPORT_REPORTS_ROLES.includes(meData && meData.role);
    detailToolbar.hidden = !canExport;
    if (detailToolbarLabel) {
      detailToolbarLabel.hidden = !canExport;
    }

    function downloadSingleReport(format) {
      if (!currentFaultId) {
        return;
      }
      let params = new URLSearchParams();
      params.set('id', currentFaultId);
      params.set('format', format);
      window.location.href = '/api/reports/export?' + params.toString();
    }

    let detailExportCsv = document.getElementById('detail-export-csv');
    let detailExportXlsx = document.getElementById('detail-export-xlsx');
    let detailExportPdf = document.getElementById('detail-export-pdf');

    if (detailExportCsv) {
      detailExportCsv.addEventListener('click', function () { downloadSingleReport('csv'); });
    }
    if (detailExportXlsx) {
      detailExportXlsx.addEventListener('click', function () { downloadSingleReport('xlsx'); });
    }
    if (detailExportPdf) {
      detailExportPdf.addEventListener('click', function () { downloadSingleReport('pdf'); });
    }
  }

    let requestType = document.getElementById('request-type');

  // Corrects the picker to the signed-in account's role scope (hiding any
  // out-of-scope option and switching off it if it was somehow selected —
  // e.g. the "fault" default on a field-application-specialist account)
  // before the change listener below does its first applyRequestType call,
  // so the fields shown at load match the option actually left selected.
  applyRoleRequestTypeScope(meData);

  if (requestType) {
    requestType.addEventListener('change', function () {
      applyRequestType(requestType.value);
    });
    applyRequestType(requestType.value);
    document.addEventListener('tervexa:languagechange', function () {
      applyRequestType(requestType.value);
    });
  }

  let chatForm = document.getElementById('chat-form');
  let chatInput = document.getElementById('chat-input');

  if (chatForm && chatInput) {
    chatForm.addEventListener('submit', async function (e) {
      e.preventDefault();

      let question = chatInput.value.trim();

      if (question.length === 0) {
        return;
      }

      addChatBubble(question, 'user');
      chatMessages.push({ role: 'user', content: question });

      chatInput.value = '';
      chatInput.disabled = true;

      let thinking = addChatBubble(t('common.thinking'), 'thinking');

      try {
        let recent = chatMessages.slice(-12);
        let reply = await sendChatMessage(recent);

        thinking.remove();
        addChatBubble(reply, 'assistant');
        chatMessages.push({ role: 'assistant', content: reply });
      } catch (err) {
        thinking.remove();
        addChatBubble(
          err.isRefusal ? t('common.assistantCouldNotRespond') : t('common.couldNotReachAssistant'),
          'assistant'
        );
      }

      chatInput.disabled = false;
      chatInput.focus();
    });
  }

  let filterStatus = document.getElementById('filter-status');
  let filterType = document.getElementById('filter-type');

  if (filterStatus) {
    filterStatus.addEventListener('change', function () {
      renderFaultLog();
    });
  }

  if (filterType) {
    filterType.addEventListener('change', function () {
      renderFaultLog();
    });
  }

  let causeFilter = document.getElementById('cause-filter');

  if (causeFilter) {
    causeFilter.addEventListener('change', function () {
      renderRootCauses();
    });
  }

  let loginForm = document.getElementById('login-form');

  if (loginForm) {
    loginForm.addEventListener('submit', async function (e) {
      e.preventDefault();

      let errorBox = document.getElementById('login-error');
      let submitBtn = document.getElementById('login-submit');
      let email = document.getElementById('email').value.trim();
      let password = document.getElementById('password').value;
      let rememberField = document.getElementById('remember-me');
      let rememberMe = Boolean(rememberField && rememberField.checked);

      errorBox.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = t('login.submitBusy');

      try {
        let response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, password: password, rememberMe: rememberMe })
        });

        let data = await response.json();

        if (!response.ok) {
          // data.error comes straight from the server, which always
          // responds in English regardless of this page's language.
          errorBox.textContent = data.error || 'Could not log in.';
          errorBox.hidden = false;
          submitBtn.disabled = false;
          submitBtn.textContent = t('login.submit');
          return;
        }

        // An admin-created account's temporary password proved valid, but
        // there's no real session yet — this sends them to set their own
        // password (the same page and flow a forgotten-password reset
        // uses) before they can actually get in.
        if (data.mustChangePassword) {
          window.location.href = data.resetUrl;
          return;
        }

        window.location.href = 'index.html';
      } catch (err) {
        errorBox.textContent = t('errors.couldNotReachServer');
        errorBox.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = t('login.submit');
      }
    });
  }

  let signupForm = document.getElementById('signup-form');

  if (signupForm) {
    let modeCreateField = document.getElementById('mode-create');
    let modeJoinField = document.getElementById('mode-join');
    let modeIndividualField = document.getElementById('mode-individual');
    let createOnlyGroup = document.querySelector('.mode-create-only');
    let joinOnlyGroup = document.querySelector('.mode-join-only');
    let individualOnlyGroup = document.querySelector('.mode-individual-only');
    let companyNameField = document.getElementById('company-name');
    let inviteCodeField = document.getElementById('invite-code');
    let roleField = document.getElementById('role');

    function applySignupMode() {
      let isJoin = Boolean(modeJoinField && modeJoinField.checked);
      let isIndividual = Boolean(modeIndividualField && modeIndividualField.checked);

      if (createOnlyGroup) {
        createOnlyGroup.hidden = isJoin || isIndividual;
      }
      if (joinOnlyGroup) {
        joinOnlyGroup.hidden = !isJoin;
      }
      if (individualOnlyGroup) {
        individualOnlyGroup.hidden = !isIndividual;
      }
      if (companyNameField) {
        companyNameField.required = !isJoin && !isIndividual;
      }
      if (inviteCodeField) {
        inviteCodeField.required = isJoin;
      }
      if (roleField) {
        roleField.required = isJoin;
      }
    }

    if (modeCreateField) {
      modeCreateField.addEventListener('change', applySignupMode);
    }
    if (modeJoinField) {
      modeJoinField.addEventListener('change', applySignupMode);
    }
    if (modeIndividualField) {
      modeIndividualField.addEventListener('change', applySignupMode);
    }
    applySignupMode();

    signupForm.addEventListener('submit', async function (e) {
      e.preventDefault();

      let errorBox = document.getElementById('signup-error');
      let confirmError = document.getElementById('confirm-password-error');
      let submitBtn = document.getElementById('signup-submit');
      let confirmField = document.getElementById('confirm-password');

      errorBox.hidden = true;
      confirmError.hidden = true;
      confirmField.classList.remove('input-invalid');

      let mode = (modeJoinField && modeJoinField.checked) ? 'join' : (modeIndividualField && modeIndividualField.checked) ? 'individual' : 'create';
      let fullName = document.getElementById('full-name').value.trim();
      let phone = document.getElementById('phone').value.trim();
      let email = document.getElementById('email').value.trim();
      let password = document.getElementById('password').value;
      let confirmPassword = confirmField.value;
      let termsField = document.getElementById('terms');
      let disclaimerField = document.getElementById('disclaimer');
      let termsAccepted = Boolean(termsField && termsField.checked);
      let disclaimerAccepted = Boolean(disclaimerField && disclaimerField.checked);

      let signupPwError = passwordError(password);
      if (signupPwError) {
        errorBox.textContent = signupPwError;
        errorBox.hidden = false;
        return;
      }

      if (password !== confirmPassword) {
        confirmError.textContent = t('errors.passwordsDontMatch');
        confirmError.hidden = false;
        confirmField.classList.add('input-invalid');
        confirmField.focus();
        return;
      }

      let payload = {
        mode: mode,
        email: email,
        password: password,
        fullName: fullName,
        phone: phone,
        termsAccepted: termsAccepted,
        disclaimerAccepted: disclaimerAccepted,
        // Carries over whatever language they already had selected
        // while browsing before signing up, so the new account isn't
        // reset to English.
        preferredLanguage: getStoredLanguage()
      };

      if (mode === 'create') {
        payload.companyName = companyNameField ? companyNameField.value.trim() : '';
      } else if (mode === 'join') {
        payload.inviteCode = inviteCodeField ? inviteCodeField.value.trim() : '';
        payload.role = roleField ? roleField.value : '';
      }
      // mode === 'individual' needs nothing extra — the server creates a
      // one-person company automatically.

      submitBtn.disabled = true;
      submitBtn.textContent = t('signup.submitBusy');

      try {
        let response = await fetch('/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        let data = await response.json();

        if (!response.ok) {
          errorBox.textContent = data.error || 'Could not create account.';
          errorBox.hidden = false;
          submitBtn.disabled = false;
          submitBtn.textContent = t('signup.submit');
          return;
        }

        window.location.href = 'index.html';
      } catch (err) {
        errorBox.textContent = t('errors.couldNotReachServer');
        errorBox.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = t('signup.submit');
      }
    });
  }

  let resetRequestForm = document.getElementById('reset-request-form');

  if (resetRequestForm) {
    resetRequestForm.addEventListener('submit', async function (e) {
      e.preventDefault();

      let errorBox = document.getElementById('reset-request-error');
      let submitBtn = document.getElementById('reset-request-submit');
      let email = document.getElementById('email').value.trim();

      errorBox.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = t('reset.submitBusy');

      try {
        let response = await fetch('/api/request-password-reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email })
        });

        let data = await response.json();

        if (!response.ok) {
          errorBox.textContent = data.error || 'Could not send reset link.';
          errorBox.hidden = false;
          submitBtn.disabled = false;
          submitBtn.textContent = t('reset.submit');
          return;
        }

        // Same response whether or not the account exists, so this page
        // always moves on to "check your email" rather than confirming
        // one way or the other.
        window.location.href = 'reset-sent.html';
      } catch (err) {
        errorBox.textContent = t('errors.couldNotReachServer');
        errorBox.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = t('reset.submit');
      }
    });
  }

  let resetForm = document.getElementById('reset-form');

  if (resetForm) {
    let resetToken = new URLSearchParams(window.location.search).get('token');
    let resetError = document.getElementById('reset-error');
    let confirmError = document.getElementById('confirm-error');

    if (!resetToken) {
      resetError.textContent = t('newPassword.missingToken');
      resetError.hidden = false;
      let submitBtn = document.getElementById('reset-submit');
      if (submitBtn) {
        submitBtn.disabled = true;
      }
    }

    resetForm.addEventListener('submit', async function (e) {
      e.preventDefault();

      let submitBtn = document.getElementById('reset-submit');
      let newPassword = document.getElementById('new-password').value;
      let confirmPassword = document.getElementById('confirm-password').value;

      resetError.hidden = true;
      confirmError.hidden = true;

      let resetPwError = passwordError(newPassword);
      if (resetPwError) {
        resetError.textContent = resetPwError;
        resetError.hidden = false;
        return;
      }

      if (newPassword !== confirmPassword) {
        confirmError.textContent = t('errors.passwordsDontMatch');
        confirmError.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = t('newPassword.submitBusy');

      try {
        let response = await fetch('/api/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: resetToken, password: newPassword })
        });

        let data = await response.json();

        if (!response.ok) {
          resetError.textContent = data.error || 'Could not reset password.';
          resetError.hidden = false;
          submitBtn.disabled = false;
          submitBtn.textContent = t('newPassword.submit');
          return;
        }

        window.location.href = 'login.html';
      } catch (err) {
        resetError.textContent = t('errors.couldNotReachServer');
        resetError.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = t('newPassword.submit');
      }
    });
  }

  // Shared by the admin page and billing.html — a plain-language line
  // about the free trial: how many days are left, or that it's over and
  // what to do next. Returns nothing to render (element stays hidden)
  // once a company isn't on a trial at all — already paid, or created
  // before the trial feature existed (see trialStatusFor in server.js).
  // Defined here, outside either page's own `if` block below, because a
  // function declared inside one block is scoped to that block only —
  // billing.html's block couldn't see a copy declared inside admin.html's.
  function renderTrialStatusLine(el, data) {
    if (!el) {
      return;
    }
    if (!data.onTrial) {
      el.hidden = true;
      return;
    }
    if (data.trialExpired) {
      el.textContent = t('billing.current.trialExpired');
      el.hidden = false;
      return;
    }
    let msPerDay = 24 * 60 * 60 * 1000;
    let daysLeft = Math.max(0, Math.ceil((new Date(data.trialEndsAt).getTime() - Date.now()) / msPerDay));
    el.textContent = t('billing.current.trialActive').replace('{n}', daysLeft);
    el.hidden = false;
  }

  let adminUsersBody = document.getElementById('admin-users-body');

  if (adminUsersBody) {
    let adminTable = document.getElementById('admin-table');
    let adminLoading = document.getElementById('admin-loading');
    let adminFeedback = document.getElementById('admin-feedback');

    let ROLE_OPTIONS = ['technician', 'field-application-specialist', 'engineer', 'supervisor', 'manager', 'admin'];
    let ROLE_I18N_KEYS = {
      technician: 'role.technician',
      'field-application-specialist': 'role.fieldApplicationSpecialist',
      engineer: 'role.engineer',
      supervisor: 'role.supervisor',
      manager: 'role.manager',
      admin: 'role.admin'
    };

    function showAdminFeedback(message, isError) {
      if (!adminFeedback) {
        return;
      }
      adminFeedback.textContent = message;
      adminFeedback.className = 'admin-feedback' + (isError ? ' admin-feedback-error' : ' admin-feedback-ok');
      adminFeedback.hidden = false;
      setTimeout(function () { adminFeedback.hidden = true; }, 4000);
    }

    function updateAdminUser(id, patch) {
      fetch('/api/admin/users/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok) {
              let err = new Error(data.error || t('admin.saveError'));
              err.upgradeRequired = Boolean(data.upgradeRequired);
              throw err;
            }
            return data;
          });
        })
        .then(function () {
          showAdminFeedback(t('admin.saved'), false);
          // A role or active-status change is exactly what the audit log
          // and seat-usage count both track, so refresh both alongside
          // the accounts table rather than waiting for a page reload.
          loadAdminAuditLog();
          loadAdminCompany();
          return loadAdminUsers();
        })
        .catch(function (err) {
          console.error('Admin update failed:', err);
          showAdminFeedback(err.message + (err.upgradeRequired ? ' ' + t('report.upgradeLinkHint') : ''), true);
          // Roll the dropdown/toggle back to what it actually is server-side
          // — a blocked change shouldn't leave the control showing the
          // value the admin tried to set.
          loadAdminUsers();
        });
    }

    let exportReporterSelect = document.getElementById('admin-export-reporter');
    let exportCsvBtn = document.getElementById('admin-export-csv');
    let exportXlsxBtn = document.getElementById('admin-export-xlsx');
    let exportPdfBtn = document.getElementById('admin-export-pdf');

    // Rebuilt every time the employee table re-renders (add, deactivate, a
    // role change) so the picker never drifts out of sync with who's
    // actually on the team. Deactivated employees stay listed here on
    // purpose — their past reports are still real company history, and an
    // admin may specifically want that person's log after they've left.
    function populateExportReporterOptions(users) {
      if (!exportReporterSelect) {
        return;
      }
      let previousValue = exportReporterSelect.value;
      exportReporterSelect.innerHTML = '';

      let allOption = document.createElement('option');
      allOption.value = '';
      allOption.textContent = t('admin.exportByReporter.allOption');
      exportReporterSelect.appendChild(allOption);

      users.forEach(function (user) {
        let opt = document.createElement('option');
        opt.value = user.id;
        opt.textContent = (user.fullName || user.email) + ' (' + user.email + ')';
        exportReporterSelect.appendChild(opt);
      });

      if (previousValue && users.some(function (u) { return String(u.id) === previousValue; })) {
        exportReporterSelect.value = previousValue;
      }
    }

    function downloadAdminExport(format) {
      let params = new URLSearchParams();
      if (exportReporterSelect && exportReporterSelect.value) {
        params.set('reporterId', exportReporterSelect.value);
      }
      params.set('format', format);
      window.location.href = '/api/reports/export?' + params.toString();
    }

    if (exportCsvBtn) {
      exportCsvBtn.addEventListener('click', function () { downloadAdminExport('csv'); });
    }
    if (exportXlsxBtn) {
      exportXlsxBtn.addEventListener('click', function () { downloadAdminExport('xlsx'); });
    }
    if (exportPdfBtn) {
      exportPdfBtn.addEventListener('click', function () { downloadAdminExport('pdf'); });
    }

    function renderAdminUsers(users) {
      adminUsersBody.innerHTML = '';
      populateExportReporterOptions(users);

      users.forEach(function (user) {
        let row = document.createElement('tr');

        let nameCell = document.createElement('td');
        nameCell.textContent = user.fullName || '—';
        row.appendChild(nameCell);

        let emailCell = document.createElement('td');
        emailCell.textContent = user.email;
        row.appendChild(emailCell);

        let roleCell = document.createElement('td');
        let roleSelect = document.createElement('select');

        ROLE_OPTIONS.forEach(function (roleValue) {
          let opt = document.createElement('option');
          opt.value = roleValue;
          opt.textContent = t(ROLE_I18N_KEYS[roleValue]);
          if (roleValue === user.role) {
            opt.selected = true;
          }
          roleSelect.appendChild(opt);
        });

        roleSelect.addEventListener('change', function () {
          updateAdminUser(user.id, { role: roleSelect.value });
        });

        roleCell.appendChild(roleSelect);
        row.appendChild(roleCell);

        let statusCell = document.createElement('td');
        let badge = document.createElement('span');
        badge.className = 'status-badge ' + (user.active ? 'status-badge-active' : 'status-badge-inactive');
        badge.textContent = user.active ? t('admin.statusActive') : t('admin.statusInactive');
        statusCell.appendChild(badge);
        row.appendChild(statusCell);

        let actionsCell = document.createElement('td');
        let toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'btn-secondary btn-small';

        if (user.active) {
          toggleBtn.textContent = t('admin.deactivate');
          armConfirmButton(toggleBtn, t('admin.deactivateConfirm'), function () {
            updateAdminUser(user.id, { active: false });
          });
        } else {
          toggleBtn.textContent = t('admin.activate');
          toggleBtn.addEventListener('click', function () {
            updateAdminUser(user.id, { active: true });
          });
        }

        actionsCell.appendChild(toggleBtn);
        row.appendChild(actionsCell);

        adminUsersBody.appendChild(row);
      });
    }

    function loadAdminUsers() {
      return fetch('/api/admin/users')
        .then(function (response) {
          if (response.status === 401) {
            redirectToLogin();
            throw new Error('Not logged in');
          }
          if (response.status === 403) {
            window.location.href = 'fault-log.html';
            throw new Error('Forbidden');
          }
          if (!response.ok) {
            throw new Error(t('admin.loadError'));
          }
          return response.json();
        })
        .then(function (users) {
          renderAdminUsers(users);
          if (adminLoading) {
            adminLoading.hidden = true;
          }
          if (adminTable) {
            adminTable.hidden = false;
          }
        });
    }

    loadAdminUsers().catch(function (err) {
      console.error('Could not load admin accounts:', err);
      if (adminLoading) {
        adminLoading.textContent = t('admin.loadError');
      }
    });

    // Copies plain text to the clipboard, with a graceful no-op if the
    // browser refuses (an insecure context, or permissions) rather than
    // throwing — the code/password is still right there to select by hand.
    function copyTextToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(function () {});
      }
      return Promise.resolve();
    }

    let companyNameEl = document.getElementById('admin-company-name');
    let inviteCodeEl = document.getElementById('admin-invite-code');
    let copyInviteBtn = document.getElementById('admin-copy-invite');
    let regenerateInviteBtn = document.getElementById('admin-regenerate-invite');
    let inviteCopiedEl = document.getElementById('admin-invite-copied');
    let companyPlanEl = document.getElementById('admin-company-plan');
    let trialStatusEl = document.getElementById('admin-trial-status');
    let seatsTextEl = document.getElementById('admin-usage-seats-text');
    let seatsBarEl = document.getElementById('admin-usage-seats-bar');
    let reportsTextEl = document.getElementById('admin-usage-reports-text');
    let reportsBarEl = document.getElementById('admin-usage-reports-bar');

    // A null limit means "unlimited" (see PLAN_TIERS in server.js) — shown
    // as "used / Unlimited" with the bar hidden rather than faked at some
    // arbitrary width, since there's no ceiling to measure against.
    function renderUsageStat(textEl, barEl, used, limit) {
      if (textEl) {
        textEl.textContent = limit === null || limit === undefined
          ? used + ' / ' + t('admin.company.unlimited')
          : used + ' / ' + limit;
      }
      if (barEl) {
        if (limit === null || limit === undefined || limit <= 0) {
          barEl.parentElement.hidden = true;
        } else {
          barEl.parentElement.hidden = false;
          let pct = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
          barEl.style.width = pct + '%';
          barEl.style.backgroundColor = pct >= 100 ? '#c0392b' : '';
        }
      }
    }

    function loadAdminCompany() {
      fetch('/api/admin/company')
        .then(function (response) { return response.json(); })
        .then(function (data) {
          if (companyNameEl) {
            companyNameEl.textContent = data.name || '—';
          }
          if (inviteCodeEl) {
            inviteCodeEl.textContent = data.inviteCode || '--------';
          }
          if (companyPlanEl) {
            companyPlanEl.textContent = data.planLabel || '—';
          }
          renderTrialStatusLine(trialStatusEl, data);
          let usage = data.usage || {};
          renderUsageStat(seatsTextEl, seatsBarEl, usage.seatCount || 0, data.seatLimit);
          renderUsageStat(reportsTextEl, reportsBarEl, usage.reportsThisMonth || 0, data.monthlyReportLimit);
        })
        .catch(function (err) {
          console.error('Could not load company details:', err);
        });
    }

    if (companyNameEl || inviteCodeEl) {
      loadAdminCompany();
    }

    let auditBody = document.getElementById('admin-audit-body');
    let auditTable = document.getElementById('admin-audit-table');
    let auditEmpty = document.getElementById('admin-audit-empty');

    const AUDIT_ACTION_LABELS = {
      role_changed: 'admin.auditLog.action.roleChanged',
      account_activated: 'admin.auditLog.action.accountActivated',
      account_deactivated: 'admin.auditLog.action.accountDeactivated',
      employee_added: 'admin.auditLog.action.employeeAdded',
      invite_code_regenerated: 'admin.auditLog.action.inviteCodeRegenerated',
      plan_upgraded: 'admin.auditLog.action.planUpgraded',
      plan_canceled: 'admin.auditLog.action.planCanceled'
    };

    function loadAdminAuditLog() {
      if (!auditBody) {
        return;
      }
      fetch('/api/admin/audit-log')
        .then(function (response) { return response.json(); })
        .then(function (entries) {
          auditBody.innerHTML = '';

          if (!Array.isArray(entries) || entries.length === 0) {
            if (auditTable) { auditTable.hidden = true; }
            if (auditEmpty) { auditEmpty.hidden = false; }
            return;
          }

          if (auditTable) { auditTable.hidden = false; }
          if (auditEmpty) { auditEmpty.hidden = true; }

          entries.forEach(function (entry) {
            let row = document.createElement('tr');
            let cells = [
              new Date(entry.createdAt).toLocaleString(),
              entry.actorEmail || '—',
              t(AUDIT_ACTION_LABELS[entry.action] || entry.action),
              entry.targetEmail || '—',
              entry.details || ''
            ];
            cells.forEach(function (value, index) {
              let cell = document.createElement('td');
              cell.textContent = value;
              if (index === 4) {
                cell.className = 'audit-details-cell';
              }
              row.appendChild(cell);
            });
            auditBody.appendChild(row);
          });
        })
        .catch(function (err) {
          console.error('Could not load activity log:', err);
        });
    }

    loadAdminAuditLog();

    if (copyInviteBtn) {
      copyInviteBtn.addEventListener('click', function () {
        if (!inviteCodeEl) {
          return;
        }
        copyTextToClipboard(inviteCodeEl.textContent).then(function () {
          if (inviteCopiedEl) {
            inviteCopiedEl.hidden = false;
            setTimeout(function () { inviteCopiedEl.hidden = true; }, 2500);
          }
        });
      });
    }

    if (regenerateInviteBtn) {
      armConfirmButton(regenerateInviteBtn, t('admin.company.regenerateConfirm'), function () {
        fetch('/api/admin/company/invite-code', { method: 'POST' })
          .then(function (response) {
            return response.json().then(function (data) {
              if (!response.ok) {
                throw new Error(data.error || t('admin.saveError'));
              }
              return data;
            });
          })
          .then(function (data) {
            if (inviteCodeEl) {
              inviteCodeEl.textContent = data.inviteCode;
            }
            showAdminFeedback(t('admin.saved'), false);
            loadAdminAuditLog();
          })
          .catch(function (err) {
            console.error('Invite code regeneration failed:', err);
            showAdminFeedback(err.message, true);
          });
      });
    }

    let addEmployeeForm = document.getElementById('add-employee-form');

    if (addEmployeeForm) {
      let addEmployeeError = document.getElementById('add-employee-error');
      let addEmployeeSubmit = document.getElementById('add-employee-submit');
      let addEmployeeResult = document.getElementById('add-employee-result');
      let addEmployeeTempPassword = document.getElementById('add-employee-temp-password');
      let copyPasswordBtn = document.getElementById('add-employee-copy-password');

      addEmployeeForm.addEventListener('submit', function (e) {
        e.preventDefault();

        if (addEmployeeError) {
          addEmployeeError.hidden = true;
        }
        if (addEmployeeResult) {
          addEmployeeResult.hidden = true;
        }

        let payload = {
          fullName: document.getElementById('add-employee-name').value.trim(),
          phone: document.getElementById('add-employee-phone').value.trim(),
          email: document.getElementById('add-employee-email').value.trim(),
          role: document.getElementById('add-employee-role').value
        };

        addEmployeeSubmit.disabled = true;

        fetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
          .then(function (response) {
            return response.json().then(function (data) {
              if (!response.ok) {
                let err = new Error(data.error || t('admin.addEmployee.error'));
                err.upgradeRequired = Boolean(data.upgradeRequired);
                throw err;
              }
              return data;
            });
          })
          .then(function (data) {
            addEmployeeForm.reset();
            if (addEmployeeResult && addEmployeeTempPassword) {
              addEmployeeTempPassword.textContent = data.tempPassword;
              addEmployeeResult.hidden = false;
            }
            if (data.overLimit) {
              showAdminFeedback(t('admin.addEmployee.overLimitWarning'), false);
            }
            loadAdminAuditLog();
            loadAdminCompany();
            return loadAdminUsers();
          })
          .catch(function (err) {
            console.error('Add employee failed:', err);
            if (addEmployeeError) {
              addEmployeeError.textContent = err.message + (err.upgradeRequired ? ' ' + t('report.upgradeLinkHint') : '');
              addEmployeeError.hidden = false;
            }
          })
          .then(function () {
            addEmployeeSubmit.disabled = false;
          });
      });

      if (copyPasswordBtn) {
        copyPasswordBtn.addEventListener('click', function () {
          if (addEmployeeTempPassword) {
            copyTextToClipboard(addEmployeeTempPassword.textContent);
          }
        });
      }
    }
  }

  // --- billing.html: plan comparison, checkout, cancellation -------------
  let billingPlansGrid = document.getElementById('billing-plans-grid');

  if (billingPlansGrid) {
    let currentPlanEl = document.getElementById('billing-current-plan');
    let billingTrialStatusEl = document.getElementById('billing-trial-status');
    let currentCycleEl = document.getElementById('billing-current-cycle');
    let currentRenewalEl = document.getElementById('billing-current-renewal');
    let currentPastDueEl = document.getElementById('billing-current-pastdue');
    let cancelBtn = document.getElementById('billing-cancel-btn');
    let monthlyBtn = document.getElementById('billing-cycle-monthly');
    let annualBtn = document.getElementById('billing-cycle-annual');
    let providerPicker = document.getElementById('billing-provider-picker');
    let providerPickerPlan = document.getElementById('billing-provider-picker-plan');
    let providerButtons = document.getElementById('billing-provider-buttons');
    let providerError = document.getElementById('billing-provider-error');
    let providerCancelBtn = document.getElementById('billing-provider-cancel');
    let checkoutBanner = document.getElementById('billing-checkout-banner');

    let selectedCycle = 'monthly';
    let plansResponse = null;
    let statusResponse = null;

    const PROVIDER_LABELS = {
      paystack: 'Paystack',
      flutterwave: 'Flutterwave',
      stripe: 'Stripe (USD, card)'
    };

    // Amounts everywhere in this app's billing layer are in the smallest
    // currency unit (kobo/cents — see payments/config.js), same convention
    // the payment providers themselves use.
    function formatMoney(amount, currency) {
      if (amount === null || amount === undefined) {
        return '—';
      }
      let major = amount / 100;
      return currency === 'usd'
        ? '$' + major.toLocaleString('en-US', { maximumFractionDigits: 0 })
        : '₦' + major.toLocaleString('en-NG', { maximumFractionDigits: 0 });
    }

    function showCheckoutBanner(message, isError) {
      if (!checkoutBanner) {
        return;
      }
      checkoutBanner.textContent = message;
      checkoutBanner.className = 'admin-feedback' + (isError ? ' admin-feedback-error' : ' admin-feedback-ok');
      checkoutBanner.hidden = false;
    }

    function renderCurrentPlan() {
      if (!statusResponse) {
        return;
      }
      if (currentPlanEl) {
        currentPlanEl.textContent = statusResponse.planLabel || '—';
      }
      renderTrialStatusLine(billingTrialStatusEl, statusResponse);
      if (currentCycleEl) {
        if (statusResponse.billingCycle) {
          currentCycleEl.textContent = statusResponse.billingCycle === 'annual'
            ? t('billing.current.billedAnnually')
            : t('billing.current.billedMonthly');
          currentCycleEl.hidden = false;
        } else {
          currentCycleEl.hidden = true;
        }
      }
      if (currentRenewalEl) {
        if (statusResponse.currentPeriodEnd && statusResponse.subscriptionStatus === 'active') {
          currentRenewalEl.textContent = t('billing.current.renews') + ' ' + new Date(statusResponse.currentPeriodEnd).toLocaleDateString();
          currentRenewalEl.hidden = false;
        } else {
          currentRenewalEl.hidden = true;
        }
      }
      if (currentPastDueEl) {
        currentPastDueEl.hidden = statusResponse.subscriptionStatus !== 'past_due';
      }
      if (cancelBtn) {
        cancelBtn.hidden = statusResponse.planTier === 'free' || !statusResponse.subscriptionStatus || statusResponse.subscriptionStatus === 'canceled';
      }
    }

    function renderPlansGrid() {
      if (!plansResponse) {
        return;
      }
      billingPlansGrid.innerHTML = '';

      let freeCard = document.createElement('div');
      freeCard.className = 'billing-plan-card' + (statusResponse && statusResponse.planTier === 'free' ? ' billing-plan-card--current' : '');
      freeCard.innerHTML =
        '<div class="billing-plan-name">' + t('admin.company.planLabel').replace(':', '') + ' — Free</div>' +
        '<div class="billing-plan-price">₦0</div>' +
        '<ul class="billing-plan-features"></ul>';
      let freeFeatures = freeCard.querySelector('.billing-plan-features');
      let freeSeatCount = (statusResponse && statusResponse.isIndividual) ? '1' : '3';
      [t('billing.feature.seats').replace('{n}', freeSeatCount), t('billing.feature.reportsPerMonth').replace('{n}', '15'), t('billing.feature.exportCsvOnly')].forEach(function (line) {
        let li = document.createElement('li');
        li.textContent = line;
        freeFeatures.appendChild(li);
      });
      billingPlansGrid.appendChild(freeCard);

      plansResponse.tiers.forEach(function (tier) {
        let isCurrent = statusResponse && statusResponse.planTier === tier.planTier;
        let card = document.createElement('div');
        card.className = 'billing-plan-card' + (isCurrent ? ' billing-plan-card--current' : '');

        let name = document.createElement('div');
        name.className = 'billing-plan-name';
        name.textContent = tier.label;
        card.appendChild(name);

        let price = document.createElement('div');
        price.className = 'billing-plan-price';
        let ngnAmount = tier.pricing.ngn[selectedCycle];
        let periodLabel = selectedCycle === 'annual' ? t('billing.perYear') : t('billing.perMonth');
        price.innerHTML = formatMoney(ngnAmount, 'ngn') + ' <small>' + periodLabel + '</small>';
        card.appendChild(price);

        // Naira stays the prominent figure (Paystack/Flutterwave settle in
        // it, and it's the right default for a Nigeria-first product) —
        // this is just a smaller reference underneath, in USD, for anyone
        // paying via Stripe or simply thinking in dollars. See the pricing
        // comment in payments/config.js for where this fixed USD figure
        // comes from.
        let usdAmount = tier.pricing.usd[selectedCycle];
        if (usdAmount !== null && usdAmount !== undefined) {
          let priceUsd = document.createElement('div');
          priceUsd.className = 'billing-plan-price-usd';
          priceUsd.textContent = '≈ ' + formatMoney(usdAmount, 'usd') + ' ' + periodLabel;
          card.appendChild(priceUsd);
        }

        let features = document.createElement('ul');
        features.className = 'billing-plan-features';
        let lines = [
          tier.seatLimit === null ? t('billing.feature.seatsUnlimited') : t('billing.feature.seats').replace('{n}', tier.seatLimit),
          tier.monthlyReportLimit === null ? t('billing.feature.reportsUnlimited') : t('billing.feature.reportsPerMonth').replace('{n}', tier.monthlyReportLimit),
          t('billing.feature.exportAll'),
          t('billing.feature.auditLog')
        ];
        lines.forEach(function (line) {
          let li = document.createElement('li');
          li.textContent = line;
          features.appendChild(li);
        });
        card.appendChild(features);

        let btn = document.createElement('button');
        btn.type = 'button';
        btn.className = isCurrent ? 'btn-secondary' : 'btn-primary';
        btn.disabled = isCurrent;
        btn.textContent = isCurrent ? t('billing.currentPlanBtn') : t('billing.upgradeBtn');
        if (!isCurrent) {
          btn.addEventListener('click', function () {
            openProviderPicker(tier.planTier, tier.label, selectedCycle);
          });
        }
        card.appendChild(btn);

        billingPlansGrid.appendChild(card);
      });
    }

    function openProviderPicker(planTier, planLabel, billingCycle) {
      if (!providerPicker) {
        return;
      }
      if (providerPickerPlan) {
        providerPickerPlan.textContent = planLabel + ' — ' + (billingCycle === 'annual' ? t('billing.cycle.annual') : t('billing.cycle.monthly'));
      }
      if (providerError) {
        providerError.hidden = true;
      }
      providerButtons.innerHTML = '';

      let available = (plansResponse && plansResponse.availableProviders) || [];
      if (available.length === 0) {
        let none = document.createElement('p');
        none.className = 'field-hint';
        none.textContent = t('billing.providerPicker.noneConfigured');
        providerButtons.appendChild(none);
      }

      available.forEach(function (providerName) {
        let btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-primary';
        btn.textContent = PROVIDER_LABELS[providerName] || providerName;
        btn.addEventListener('click', function () {
          startCheckout(planTier, billingCycle, providerName, btn);
        });
        providerButtons.appendChild(btn);
      });

      providerPicker.hidden = false;
    }

    function startCheckout(planTier, billingCycle, providerName, btn) {
      btn.disabled = true;
      if (providerError) {
        providerError.hidden = true;
      }

      fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planTier: planTier, billingCycle: billingCycle, provider: providerName })
      })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok) {
              throw new Error(data.error || t('billing.providerPicker.checkoutError'));
            }
            return data;
          });
        })
        .then(function (data) {
          window.location.href = data.checkoutUrl;
        })
        .catch(function (err) {
          console.error('Checkout failed:', err);
          btn.disabled = false;
          if (providerError) {
            providerError.textContent = err.message;
            providerError.hidden = false;
          }
        });
    }

    if (providerCancelBtn) {
      providerCancelBtn.addEventListener('click', function () {
        providerPicker.hidden = true;
      });
    }

    if (cancelBtn) {
      armConfirmButton(cancelBtn, t('billing.current.cancelConfirm'), function () {
        cancelBtn.disabled = true;
        fetch('/api/billing/cancel', { method: 'POST' })
          .then(function (response) {
            return response.json().then(function (data) {
              if (!response.ok) {
                throw new Error(data.error || t('billing.current.cancelError'));
              }
              return data;
            });
          })
          .then(function () {
            showCheckoutBanner(t('billing.current.cancelled'), false);
            return loadBillingStatus();
          })
          .catch(function (err) {
            console.error('Cancellation failed:', err);
            showCheckoutBanner(err.message, true);
          })
          .then(function () {
            cancelBtn.disabled = false;
          });
      });
    }

    if (monthlyBtn && annualBtn) {
      monthlyBtn.addEventListener('click', function () {
        selectedCycle = 'monthly';
        monthlyBtn.classList.add('is-active');
        annualBtn.classList.remove('is-active');
        renderPlansGrid();
      });
      annualBtn.addEventListener('click', function () {
        selectedCycle = 'annual';
        annualBtn.classList.add('is-active');
        monthlyBtn.classList.remove('is-active');
        renderPlansGrid();
      });
    }

    function loadBillingStatus() {
      return fetch('/api/billing/status')
        .then(function (response) { return response.json(); })
        .then(function (data) {
          statusResponse = data;
          renderCurrentPlan();
          renderPlansGrid();
        });
    }

    function loadBillingPlans() {
      let loadingEl = document.getElementById('billing-plans-loading');
      return fetch('/api/billing/plans')
        .then(function (response) { return response.json(); })
        .then(function (data) {
          plansResponse = data;
          if (loadingEl) {
            loadingEl.hidden = true;
          }
          renderPlansGrid();
        });
    }

    // renderCurrentPlan()/renderPlansGrid() build their text with t() calls
    // at render time, not [data-i18n] attributes on static markup — so
    // switching language only re-translates them if something re-runs the
    // render after the switch. Without this, the three plan cards (feature
    // bullets, the Upgrade/Current plan button, the "/month" and "≈ $x"
    // labels) stay in whatever language the page first loaded in. Both
    // functions already no-op safely if their data hasn't loaded yet, so
    // it's safe to just call them again here.
    document.addEventListener('tervexa:languagechange', function () {
      renderCurrentPlan();
      renderPlansGrid();
    });

    // The provider redirects back here with ?checkout=success or
    // ?checkout=cancelled — this is just a friendly landing message, NOT
    // what confirms payment (the webhook already did that, likely before
    // the browser even finishes redirecting back). Clean the query string
    // off afterward so refreshing the page doesn't re-show the banner.
    let checkoutParam = new URLSearchParams(window.location.search).get('checkout');
    if (checkoutParam === 'success') {
      showCheckoutBanner(t('billing.checkout.successBanner'), false);
      window.history.replaceState({}, '', 'billing.html');
    } else if (checkoutParam === 'cancelled') {
      showCheckoutBanner(t('billing.checkout.cancelledBanner'), true);
      window.history.replaceState({}, '', 'billing.html');
    }

    Promise.all([loadBillingStatus(), loadBillingPlans()]).catch(function (err) {
      console.error('Could not load billing information:', err);
    });
  }

  wireClearChatButton();

  let needsFaultData = document.getElementById('fault-log-body') ||
    document.getElementById('chat-window') ||
    document.getElementById('fault-form');

  if (needsFaultData) {
    fetchFaults()
      .then(async function () {
        renderFaultLog();
        await loadConversationHistory();
        seedChatFromReport();
      })
      .catch(function (err) {
        console.error('Could not load reports:', err);
        renderFaultLog();
      });
  }
});
