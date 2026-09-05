(() => {
  const storageKey = 'lariat-user-name';
  const skippedValue = '__skipped__';
  let storedName = null;
  try {
    storedName = localStorage.getItem(storageKey);
  } catch (error) {
    /* Storage may be blocked; the generic greeting is kept. */
  }

  // First visit in this browser: ask for a name, then remember it so we
  // never ask again. Declining is also remembered so the prompt does not
  // reappear on every page load.
  if (!storedName) {
    const entered = (window.prompt('Welcome to Lariat — what should we call you?') || '').trim();
    storedName = entered || skippedValue;
    try {
      localStorage.setItem(storageKey, storedName);
    } catch (error) {
      /* Storage may be blocked; the name still applies to this visit. */
    }
  }

  if (storedName === skippedValue) return; // visitor declined; keep generic defaults

  const displayName = storedName.trim();
  const parts = displayName.split(/\s+/);
  const firstInitial = (parts[0] || '').charAt(0).toUpperCase();
  const lastInitial = parts.length > 1
    ? (parts[parts.length - 1] || '').charAt(0).toUpperCase()
    : (parts[0] || '').charAt(1).toUpperCase();
  const initials = `${firstInitial}${lastInitial}` || '?';

  document.querySelectorAll('[data-user-name]').forEach((element) => {
    element.textContent = displayName;
  });
  document.querySelectorAll('.avatar-button').forEach((button) => {
    button.textContent = initials;
  });
})();