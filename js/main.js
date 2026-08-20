document.addEventListener('DOMContentLoaded', function () {
  let loginLink = document.querySelector('a[href="login.html"]');

  if (loginLink) {
    loginLink.addEventListener('click', function () {
      console.log('Login link clicked');
    });
  }

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
      console.log('--- fault report submitted ---');
      data.forEach(function (value, key) {
        console.log(key, '=', value);
      });
    });
  }
});

