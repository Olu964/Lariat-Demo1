/* Compatibility shim — kept so pages that still include user-name.js keep working.
 * Real logic lives in profile.js (device-local, no prompt).
 * This file never prompts anymore; it just renders whatever profile.js stored.
 */
(() => {
  if (window.LariatProfile) return; // profile.js already rendered
  let storedName = null;
  try {
    const raw = localStorage.getItem('lariat-profile-v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.displayName === 'string' && parsed.displayName.trim()) {
        storedName = parsed.displayName.trim().slice(0, 80);
      }
    }
    if (!storedName) {
      const legacy = localStorage.getItem('lariat-user-name');
      if (legacy && legacy !== '__skipped__' && legacy.trim()) {
        storedName = legacy.trim().slice(0, 80);
      }
    }
  } catch (error) { /* storage blocked */ }
  if (!storedName) return;
  const firstName = storedName.split(/\s+/)[0].slice(0, 12);
  document.querySelectorAll('[data-user-name]').forEach((el) => { el.textContent = storedName; });
  document.querySelectorAll('.header-actions').forEach((actions) => {
    const cta = actions.querySelector('.profile-cta');
    const btn = actions.querySelector('.avatar-button');
    if (cta) cta.hidden = true;
    if (btn) {
      btn.hidden = false;
      btn.textContent = firstName;
      btn.classList.add('has-name');
      btn.setAttribute('aria-label', `Open profile for ${storedName}`);
      btn.setAttribute('title', `Profile — ${storedName}`);
    }
  });
})();
