// OS detection for download button
(function () {
  var ua = navigator.userAgent;
  var os = 'unknown';

  if (/Mac/.test(ua)) {
    // Check for Apple Silicon via WebGL renderer or default to arm64 for modern Macs
    try {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl');
      var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
      os = /Apple/.test(renderer) ? 'mac-arm' : 'mac-intel';
    } catch (e) {
      os = 'mac-arm'; // Default to Apple Silicon for newer Macs
    }
  } else if (/Win/.test(ua)) {
    os = 'windows';
  } else if (/Linux/.test(ua)) {
    os = 'linux-appimage';
  }

  // Highlight the matching download card
  var cards = document.querySelectorAll('.download-card[data-os]');
  cards.forEach(function (card) {
    if (card.dataset.os === os) {
      card.classList.add('highlighted');
    }
  });

  // Update hero download button
  var heroBtn = document.getElementById('hero-download');
  if (heroBtn) {
    var labels = {
      'mac-arm': 'Download for Mac (Apple Silicon)',
      'mac-intel': 'Download for Mac (Intel)',
      'windows': 'Download for Windows',
      'linux-appimage': 'Download for Linux'
    };
    if (labels[os]) heroBtn.textContent = labels[os];

    // Link hero button to the right download
    var match = document.querySelector('.download-card[data-os="' + os + '"]');
    if (match && match.href) {
      heroBtn.href = match.href;
    }
  }
})();
