(() => {
  const storageKey = 'lariat-theme';
  const root = document.documentElement;
  const toggle = document.querySelector('[data-theme-toggle]');

  const getTheme = () => root.dataset.theme === 'dark' ? 'dark' : 'light';

  const updateToggle = (theme) => {
    if (!toggle) return;
    const dark = theme === 'dark';
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    toggle.querySelector('.theme-toggle-icon').textContent = dark ? '☀' : '☾';
    toggle.querySelector('.theme-toggle-label').textContent = dark ? 'Light mode' : 'Dark mode';
  };

  const setTheme = (theme, persist = true) => {
    root.dataset.theme = theme;
    if (persist) {
      try { localStorage.setItem(storageKey, theme); } catch (error) {}
    }
    updateToggle(theme);
  };

  updateToggle(getTheme());
  toggle?.addEventListener('click', () => setTheme(getTheme() === 'dark' ? 'light' : 'dark'));
})();
