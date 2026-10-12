(() => {
  const STORAGE_KEY = 'lariat-cookie-consent-v1';

  let consented = false;
  try {
    consented = localStorage.getItem(STORAGE_KEY) === 'true';
  } catch (error) {
    consented = false;
  }

  const openCookiePolicyModal = () => {
    const trigger = document.querySelector('[data-modal-open="cookie-modal"]');
    if (!trigger) return false;
    trigger.click();
    return true;
  };

  if (!consented) {
    const banner = document.createElement('div');
    banner.className = 'cookie-consent';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie consent notice');
    banner.innerHTML = [
      '<div class="cookie-consent-inner">',
      '  <div class="cookie-consent-body">',
      '    <h2 class="cookie-consent-title">About cookies on this site</h2>',
      '    <p class="cookie-consent-text">Lariat does not use advertising cookies or analytics trackers. It keeps a small amount of information in your browser (localStorage) to remember your theme, display name, saved bills and notes, demo plan, and other choices on this device. By continuing to use the site, you agree to this essential storage.</p>',
      '  </div>',
      '  <div class="cookie-consent-actions">',
      '    <button class="cookie-consent-accept" type="button">Agree and proceed</button>',
      '    <a class="cookie-consent-settings" href="privacy.html#cookie-modal">View Cookie Settings <span aria-hidden="true">&raquo;</span></a>',
      '  </div>',
      '</div>',
      '<div class="cookie-consent-bar"><a href="privacy.html">Privacy Policy</a><span>Lariat · Texas bill intelligence</span></div>'
    ].join('');

    document.body.appendChild(banner);

    const dismiss = (persist) => {
      if (persist) {
        try {
          localStorage.setItem(STORAGE_KEY, 'true');
        } catch (error) {
          // Storage blocked: the notice simply returns on the next visit.
        }
      }
      banner.classList.add('is-leaving');
      window.setTimeout(() => banner.remove(), 260);
    };

    banner.querySelector('.cookie-consent-accept')?.addEventListener('click', () => dismiss(true));

    banner.querySelectorAll('a[href="privacy.html#cookie-modal"]').forEach((link) => {
      link.addEventListener('click', (event) => {
        if (!document.querySelector('[data-modal-open="cookie-modal"]')) return;
        event.preventDefault();
        openCookiePolicyModal();
      });
    });
  }

  if (window.location.hash === '#cookie-modal') openCookiePolicyModal();
})();
