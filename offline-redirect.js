/* Redirects the whole site to offline.html when the browser reports no connection. */
(() => {
  const OFFLINE_PAGE = 'offline.html';

  function onOfflinePage() {
    const path = window.location.pathname || '';
    return path.endsWith('/' + OFFLINE_PAGE) || path.endsWith(OFFLINE_PAGE);
  }

  function goOffline() {
    if (onOfflinePage()) return;
    try { sessionStorage.setItem('lariat-auto-offline', '1'); } catch (error) {}
    window.location.replace(OFFLINE_PAGE);
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    goOffline();
    return;
  }

  window.addEventListener('offline', goOffline);
})();
