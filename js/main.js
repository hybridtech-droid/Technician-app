function getDiagnosis(faultType, severity, onset) {
  let suggestions = {
    electrical: 'Check supply voltage, breaker condition, and terminal tightness. Inspect cabling for insulation damage or heat discolouration.',
    mechanical: 'Inspect bearings, couplings, and alignment. Check lubrication levels and listen for changes in running noise under load.',
    electronic: 'Verify sensor output against a known reference. Check signal wiring for continuity and inspect boards for damaged components.',
    hvac: 'Check refrigerant pressures, filter condition, and airflow. Inspect the condenser coil for fouling.',
    software: 'Review controller logs around the fault time. Confirm firmware version and check for corrupted configuration.',
    structural: 'Inspect mounting points, welds, and fasteners for cracking or movement. Check foundation for settling.',
    biomedical: 'Run the manufacturer self-test and check calibration records. Verify power supply stability.',
    other: 'Insufficient category data. Escalate to a senior engineer with full observation notes.'
  };

  let text = suggestions[faultType] || suggestions.other;
  
  if (onset === 'sudden') {
    text = text + ' Sudden onset points to a discrete trigger - check for a recent power event, impact, or overload before assuming wear.';
  } else if (onset === 'gradual') {
    text = text + ' Gradual onset suggests wear or contamination - review maintenance history and trend any available readings.';
  } else if (onset === 'external') {
    text = text +' External damage was reported - document it photographically before any repair, as it may affect warranty or insurance.';
  }

  if (severity === 'critical') {
    text = 'PRIORITY — isolate the equipment before working on it. ' + text;
  }

  return text;
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
    low: 'Low'
  };
  return labels[value] || value;
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
      prettyLabel(fault.type),
      prettyLabel(fault.severity),
      fault.date,
      fault.status
    ];

    cells.forEach(function (value) {
      let cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
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
    faultForm.addEventListener('submit', function (e) {
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

      let diagnosis = getDiagnosis(
        data.get('fault-type'),
        data.get('fault-severity'),
        data.get('fault-onset')
      );

      let fault = {
        id: 'F-' + String(loadFaults().length + 1).padStart(3, '0'),
        technician: data.get('technician-name'),
        equipment: data.get('equipment-id'),
        location: data.get('site-location'),
        type: data.get('fault-type'),
        severity: data.get('fault-severity'),
        date: new Date().toLocaleDateString('en-GB'),
        status: 'Open',
        diagnosis: diagnosis
      };

      saveFault(fault);
      faultForm.reset();
      fileNameDisplay.textContent = 'No photo selected';
      
      resultBox.hidden = false;
      resultText.textContent = 'Analysing report...';
      resultBox.scrollIntoView({ behavior: 'smooth' });

      setTimeout(function () {
        resultText.textContent = diagnosis;
      }, 1200);
    });
  }

  renderFaultLog();
});

