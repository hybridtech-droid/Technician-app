let currentFaultId = null;
let chatMessages = [];
let allFaults = [];

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

async function getDiagnosis(payload) {
  const response = await fetch('/api/diagnose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error('Diagnosis request failed');
  }

  const data = await response.json();
  return data.diagnosis;
}

async function sendChatMessage(messages) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: messages })
  });

  if (!response.ok) {
    throw new Error('Chat request failed');
  }

  const data = await response.json();
  return data.reply;
}

function addChatBubble(text, role) {
  let chatWindow = document.getElementById('chat-window');
  let bubble = document.createElement('div');

  bubble.className = 'chat-message chat-message--' + role;
  bubble.textContent = text.replace(/\*\*/g, '');

  chatWindow.appendChild(bubble);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  return bubble;
}

async function fetchFaults() {
  const response = await fetch('/api/reports');

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

  if (!response.ok) {
    throw new Error('Could not save report');
  }

  const result = await response.json();
  await fetchFaults();
  return result.id;
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
  metaParts.push('by ' + fault.technician);

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
    fault: 'Fault description',
    installation: 'Installation notes',
    'after-sales': 'Issue description',
    application: 'Application or process concern'
  };

  if (descriptionLabel) {
    descriptionLabel.textContent = labels[type] || 'Description';
  }

    let wording = {
    fault: {
      title: 'Submit a fault report',
      subtitle: 'Fill in the details below. The AI will analyse your report and suggest a diagnosis.',
      button: 'Submit fault report',
      result: 'Diagnosis'
    },
    installation: {
      title: 'Installation and commissioning',
      subtitle: 'Record the installation and get AI guidance on setup, checks and handover.',
      button: 'Submit installation report',
      result: 'Installation guidance'
    },
    'after-sales': {
      title: 'After-sales support',
      subtitle: 'Describe the issue since installation and get AI guidance on next steps.',
      button: 'Submit support request',
      result: 'Support guidance'
    },
    application: {
      title: 'Application and process support',
      subtitle: 'Describe the application or process concern and get AI assessment and recommendations.',
      button: 'Submit application request',
      result: 'Assessment and recommendations'
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
    empty.textContent = 'No resolved reports in this category yet.';
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
    cell.textContent = 'No reports match these filters.';
    cell.style.textAlign = 'center';
    cell.style.color = '#888888';

    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }
  
  ordered.forEach(function (fault) {
    let row = document.createElement('tr');

    let cells = [
      fault.id,
      fault.technician,
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

document.addEventListener('DOMContentLoaded', function () {

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
        fileNameDisplay.textContent = 'No photo selected';
      }
    });
  }
  
  let resultBox = document.getElementById('diagnosis-result');
  let resultText = document.getElementById('diagnosis-text');
  let resultChat = document.getElementById('result-chat');

  let faultForm = document.getElementById('fault-form');

  if (faultForm) {
    faultForm.addEventListener('submit', async function (e) {
      e.preventDefault();
        let descriptionField = document.getElementById('fault-description');
      let descriptionError = document.getElementById('description-error');
      let description = descriptionField.value.trim();

      if (description.length < 20) {
        descriptionError.textContent =
          'Please describe the fault in more detail — at least 20 characters. Include sounds, smells, error codes, or what happened before it failed.';
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
      resultText.textContent = 'Analysing report...';
      resultBox.scrollIntoView({ behavior: 'smooth' });

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
        });

        resultText.textContent = diagnosis;

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

        let savedId = await saveFault(fault);
        if (resultChat) {
          resultChat.href = 'chat.html?report=' + encodeURIComponent(savedId);
          resultChat.hidden = false;
        }
        faultForm.reset();
        fileNameDisplay.textContent = 'No photo selected';
        } catch (err) {
        resultText.textContent =
          'Could not reach the diagnosis service. Check your connection and try again.';
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
    let requestType = document.getElementById('request-type');

  if (requestType) {
    requestType.addEventListener('change', function () {
      applyRequestType(requestType.value);
    });
    applyRequestType(requestType.value);
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

      let thinking = addChatBubble('Thinking...', 'thinking');

      try {
        let recent = chatMessages.slice(-12);
        let reply = await sendChatMessage(recent);

        thinking.remove();
        addChatBubble(reply, 'assistant');
        chatMessages.push({ role: 'assistant', content: reply });
      } catch (err) {
        thinking.remove();
        addChatBubble(
          'Could not reach the assistant. Check your connection and try again.',
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

  fetchFaults()
    .then(function () {
      renderFaultLog();
      seedChatFromReport();
    })
    .catch(function (err) {
      console.error('Could not load reports:', err);
      renderFaultLog();
    });
});

