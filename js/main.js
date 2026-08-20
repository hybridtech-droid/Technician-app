function getDiagnosis(faultType, severity) {
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

  if (severity === 'critical') {
    text = 'PRIORITY — isolate the equipment before working on it. ' + text;
  }

  return text;
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

      let data = new FormData(faultForm);

      resultBox.hidden = false;
      resultText.textContent = 'Analysing report...';

      setTimeout(function () {
        resultText.textContent = getDiagnosis(
          data.get('fault-type'),
          data.get('fault-severity')
        );
      }, 1200);
    });
  }
});

