let currentFaultId = null;

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

function loadFaults() {
  let stored = localStorage.getItem('faults');
  if (stored) {
    return JSON.parse(stored);
  }
  return [];
}

function saveFault(fault) {
  let faults = loadFaults();
  faults.push(fault);
  localStorage.setItem('faults', JSON.stringify(faults));
}

function updateFaultStatus(id, newStatus) {
  let faults = loadFaults();

  faults.forEach(function (fault) {
    if (fault.id === id) {
      fault.status = newStatus;
    }
  });

  localStorage.setItem('faults', JSON.stringify(faults));
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
    application: 'Application'
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

  document.getElementById('detail-meta').textContent =
    prettyLabel(fault.type) + ' · ' + prettyLabel(fault.severity) +
    ' · ' + fault.location + ' · reported ' + fault.date +
    ' by ' + fault.technician;

  document.getElementById('detail-description').textContent =
    fault.description || 'No description recorded for this report.';

  document.getElementById('detail-diagnosis').textContent =
    fault.diagnosis || 'No diagnosis recorded.';

  document.getElementById('detail-status').value = fault.status;

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

function renderFaultLog() {
  let tbody = document.getElementById('fault-log-body');
  let emptyMessage = document.getElementById('no-faults');

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

  faults.forEach(function (fault) {
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

    cells.forEach(function (value) {
      let cell = document.createElement('td');
      cell.textContent = value;
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

      resultBox.hidden = false;
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
          recurring: data.get('recurring')
        });

        resultText.textContent = diagnosis;

        let fault = {
          id: 'F-' + String(loadFaults().length + 1).padStart(3, '0'),
          technician: data.get('technician-name'),
          equipment: data.get('equipment-id'),
          location: data.get('site-location'),
          requestType: data.get('request-type'),
          type: data.get('fault-type'),
          severity: data.get('fault-severity'),
          date: new Date().toLocaleDateString('en-GB'),
          status: 'Open',
          description: description,
          diagnosis: diagnosis
        };

        saveFault(fault);
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

  if (detailStatus) {
    detailStatus.addEventListener('change', function () {
      updateFaultStatus(currentFaultId, detailStatus.value);
      renderFaultLog();
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
  renderFaultLog();
});

