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
});

