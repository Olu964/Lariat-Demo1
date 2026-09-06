(function () {
  // Dark mode is the default: only an explicit saved choice of light switches
  // the site to the light theme.
  try {
    const savedTheme = localStorage.getItem('lariat-theme');
    document.documentElement.dataset.theme = savedTheme === 'light' ? 'light' : 'dark';
  } catch (error) {
    /* Storage may be blocked; fall back to the dark theme. */
    document.documentElement.dataset.theme = 'dark';
  }
})();
