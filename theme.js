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
    toggle.setAttribute('title', dark ? 'Switch to light mode' : 'Switch to dark mode');
    const icon = toggle.querySelector('.theme-toggle-icon');
    const label = toggle.querySelector('.theme-toggle-label');
    if (icon) icon.textContent = dark ? '☀' : '☾';
    if (label) label.textContent = dark ? 'Light mode' : 'Dark mode';
  };

  const setTheme = (theme, persist = true) => {
    const changing = getTheme() !== theme;
    if (changing) root.classList.add('theme-transitioning');
    root.dataset.theme = theme;
    if (persist) {
      try { localStorage.setItem(storageKey, theme); } catch (error) {}
    }
    updateToggle(theme);
    if (changing) {
      window.setTimeout(() => root.classList.remove('theme-transitioning'), 400);
    }
  };

  updateToggle(getTheme());
  toggle?.addEventListener('click', () => setTheme(getTheme() === 'dark' ? 'light' : 'dark'));
})();
