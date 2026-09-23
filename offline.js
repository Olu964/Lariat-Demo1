/* Logic for offline.html: retry, live status, auto-return when back online. */
(() => {
  const statusEl = document.querySelector('[data-offline-status]');
  const retryButton = document.querySelector('[data-offline-retry]');

  function setStatus(online) {
    if (statusEl) statusEl.textContent = online ? 'Back online' : 'No connection';
  }

  function returnFromOffline() {
    let auto = null;
    try { auto = sessionStorage.getItem('lariat-auto-offline'); } catch (error) {}
    try { sessionStorage.removeItem('lariat-auto-offline'); } catch (error) {}
    if (auto === '1') {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.replace('index.html');
      }
    }
  }

  retryButton?.addEventListener('click', () => {
    if (navigator.onLine) {
      returnFromOffline();
      window.location.reload();
    } else {
      window.location.reload();
    }
  });

  window.addEventListener('online', () => {
    setStatus(true);
    returnFromOffline();
  });
  window.addEventListener('offline', () => setStatus(false));

  setStatus(typeof navigator !== 'undefined' ? navigator.onLine !== false : false);
})();
