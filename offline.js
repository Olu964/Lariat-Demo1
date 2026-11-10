/* Logic for offline.html: retry, live status, auto-return when back online.
   Sets a sessionStorage bypass before leaving so offline-redirect.js does not
   immediately bounce the next page back here. */
(() => {
  const statusEl = document.querySelector('[data-offline-status]');
  const retryButton = document.querySelector('[data-offline-retry]');
  const homeLink = document.querySelector('.offline-home');
  const BYPASS_KEY = 'lariat-offline-bypass';

  function setStatus(online) {
    if (statusEl) statusEl.textContent = online ? 'Back online' : 'No connection';
  }

  function setBypass() {
    try { sessionStorage.setItem(BYPASS_KEY, '1'); } catch (error) {}
  }

  function clearAutoFlag() {
    try { sessionStorage.removeItem('lariat-auto-offline'); } catch (error) {}
  }

  function navigateAway() {
    setBypass();
    clearAutoFlag();
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.replace('index.html');
    }
  }

  retryButton?.addEventListener('click', () => {
    if (navigator.onLine) {
      // Online: leave the offline page in one shot — no reload race.
      navigateAway();
    } else {
      window.location.reload();
    }
  });

  homeLink?.addEventListener('click', () => {
    // Let the link navigate to index.html, but pre-arm the bypass so
    // offline-redirect.js on that page does not redirect straight back.
    setBypass();
    clearAutoFlag();
  });

  window.addEventListener('online', () => {
    setStatus(true);
    navigateAway();
  });

  window.addEventListener('offline', () => setStatus(false));

  setStatus(typeof navigator !== 'undefined' ? navigator.onLine !== false : false);
})();
