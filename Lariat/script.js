(() => {
  const toast = document.querySelector('.toast');
  let toastTimer;

  document.querySelectorAll('[data-toast]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!toast) return;
      toast.textContent = button.dataset.toast;
      toast.classList.add('visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
    });
  });

  document.querySelectorAll('.avatar-button').forEach((button) => {
    button.addEventListener('click', () => {
      if (!toast) return;
      toast.textContent = 'Account controls are intentionally disabled in this prototype.';
      toast.classList.add('visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
    });
  });

  const canvas = document.createElement('canvas');
  canvas.className = 'ambient-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const context = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const points = Array.from({ length: 18 }, (_, index) => ({
    x: Math.random(),
    y: Math.random(),
    radius: 1 + Math.random() * 1.5,
    speed: 0.00008 + Math.random() * 0.00013,
    phase: index * 0.8,
  }));

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * ratio;
    canvas.height = window.innerHeight * ratio;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const draw = (time = 0) => {
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (!reduceMotion) {
      points.forEach((point) => {
        const x = point.x * window.innerWidth + Math.sin(time * point.speed + point.phase) * 20;
        const y = point.y * window.innerHeight + Math.cos(time * point.speed + point.phase) * 14;
        context.beginPath();
        context.arc(x, y, point.radius, 0, Math.PI * 2);
        context.fillStyle = 'rgba(39, 131, 187, .12)';
        context.fill();
      });
    }
    if (!reduceMotion) requestAnimationFrame(draw);
  };

  resize();
  window.addEventListener('resize', resize, { passive: true });
  draw();
})();
