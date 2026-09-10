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

  // Keep the header in normal document flow, but hide it while the user is
  // reading lower on the page. It returns as soon as the viewport reaches the
  // top, preventing the navigation from covering page content.
  const header = document.querySelector('.site-header');
  let scrollTicking = false;
  const updateHeaderVisibility = () => {
    const currentScrollY = window.scrollY;
    header?.classList.toggle('is-scroll-hidden', currentScrollY > 12);
    scrollTicking = false;
  };
  window.addEventListener('scroll', () => {
    if (!scrollTicking) {
      window.requestAnimationFrame(updateHeaderVisibility);
      scrollTicking = true;
    }
  }, { passive: true });
  updateHeaderVisibility();
})();
