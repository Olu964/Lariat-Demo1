/* Redirects the whole site to offline.html only when the server is unreachable.
   navigator.onLine alone is unreliable (false on localhost without internet,
   DevTools offline mode, OS glitches), so we verify with a same-origin fetch
   before redirecting. A sessionStorage bypass stops recovery navigations from
   bouncing straight back to the offline page. */
(() => {
  const OFFLINE_PAGE = 'offline.html';
  const BYPASS_KEY = 'lariat-offline-bypass';
  const VERIFY_TIMEOUT_MS = 3000;

  function onOfflinePage() {
    const path = window.location.pathname || '';
    return path.endsWith('/' + OFFLINE_PAGE) || path.endsWith(OFFLINE_PAGE);
  }

  function consumeBypass() {
    try {
      const value = sessionStorage.getItem(BYPASS_KEY);
      if (value === '1') {
        sessionStorage.removeItem(BYPASS_KEY);
        return true;
      }
    } catch (error) {}
    return false;
  }

  function clearBypass() {
    try { sessionStorage.removeItem(BYPASS_KEY); } catch (error) {}
  }

  function goOffline() {
    if (onOfflinePage()) return;
    if (consumeBypass()) return;
    try { sessionStorage.setItem('lariat-auto-offline', '1'); } catch (error) {}
    window.location.replace(OFFLINE_PAGE);
  }

  async function verifyThenOffline() {
    if (onOfflinePage()) return;
    if (consumeBypass()) return;

    if (typeof fetch !== 'function') {
      goOffline();
      return;
    }

    const signal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
      ? AbortSignal.timeout(VERIFY_TIMEOUT_MS)
      : undefined;

    try {
      await fetch(window.location.href, {
        method: 'GET',
        cache: 'no-store',
        signal,
      });
      // Server responded — the site is reachable despite navigator.onLine.
    } catch (error) {
      goOffline();
    }
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    verifyThenOffline();
  } else {
    // Online: drop any stale recovery bypass so a future real outage still redirects.
    clearBypass();
  }

  window.addEventListener('offline', verifyThenOffline);
})();
