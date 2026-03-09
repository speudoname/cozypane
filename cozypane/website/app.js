// Fetch latest release from GitHub and populate download links
(function () {
  var REPO = 'speudoname/cozypane';
  var API = 'https://api.github.com/repos/' + REPO + '/releases/latest';

  // OS detection
  var ua = navigator.userAgent;
  var os = 'unknown';

  if (/Mac/.test(ua)) {
    try {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl');
      var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
      os = /Apple/.test(renderer) ? 'mac-arm' : 'mac-intel';
    } catch (e) {
      os = 'mac-arm';
    }
  } else if (/Win/.test(ua)) {
    os = 'windows';
  } else if (/Linux/.test(ua)) {
    os = 'linux-appimage';
  }

  // Highlight matching download card
  var cards = document.querySelectorAll('.download-card[data-os]');
  cards.forEach(function (card) {
    if (card.dataset.os === os) {
      card.classList.add('highlighted');
    }
  });

  // Update hero button text
  var heroBtn = document.getElementById('hero-download');
  if (heroBtn) {
    var labels = {
      'mac-arm': 'Download for Mac (Apple Silicon)',
      'mac-intel': 'Download for Mac (Intel)',
      'windows': 'Download for Windows',
      'linux-appimage': 'Download for Linux'
    };
    if (labels[os]) heroBtn.textContent = labels[os];
  }

  // Fetch latest release and set download URLs
  fetch(API)
    .then(function (res) { return res.json(); })
    .then(function (release) {
      var assets = release.assets || [];
      var version = release.tag_name || '';

      // Show version
      var versionEl = document.getElementById('download-version');
      if (versionEl) versionEl.textContent = 'Latest: ' + version;
      var footerEl = document.getElementById('footer-version');
      if (footerEl) footerEl.textContent = 'CozyPane ' + version;

      // Match assets to download cards
      cards.forEach(function (card) {
        var pattern = card.dataset.pattern;
        var exclude = card.dataset.exclude;
        if (!pattern) return;

        var match = assets.find(function (a) {
          var name = a.name.toLowerCase();
          var patLower = pattern.toLowerCase();
          if (name.indexOf(patLower) === -1 && !name.endsWith(patLower)) return false;
          if (exclude && name.indexOf(exclude.toLowerCase()) !== -1) return false;
          return true;
        });

        if (match) {
          card.href = match.browser_download_url;
          card.classList.remove('disabled');
        } else {
          card.classList.add('disabled');
          card.removeAttribute('href');
        }
      });

      // Update hero button link
      if (heroBtn) {
        var heroCard = document.querySelector('.download-card.highlighted');
        if (heroCard && heroCard.href && heroCard.href !== '#') {
          heroBtn.href = heroCard.href;
        }
      }
    })
    .catch(function () {
      // Fallback: link to releases page
      cards.forEach(function (card) {
        card.href = 'https://github.com/' + REPO + '/releases/latest';
      });
    });
})();
