(function () {
  try {
    if (localStorage.getItem('lariat-theme') === 'dark') {
      document.documentElement.dataset.theme = 'dark';
    }
  } catch (error) {
    /* Storage may be blocked; fall back to the light theme. */
  }
})();
