(() => {
  const toast = document.querySelector('.toast');
  let toastTimer;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (document.body.classList.contains('landing-page') && !reduceMotion.matches) {
    let scrollFrame;
    const updateScrollDepth = () => {
      scrollFrame = undefined;
      document.documentElement.style.setProperty('--scroll-glow', `${Math.min(window.scrollY * 0.025, 24)}px`);
      document.documentElement.style.setProperty('--scroll-grid', `calc(-22% + ${Math.min(window.scrollY * -0.02, 0)}px)`);
    };
    const requestScrollUpdate = () => {
      if (scrollFrame === undefined) scrollFrame = requestAnimationFrame(updateScrollDepth);
    };
    updateScrollDepth();
    window.addEventListener('scroll', requestScrollUpdate, { passive: true });
    reduceMotion.addEventListener?.('change', (event) => {
      if (event.matches) {
        document.documentElement.style.removeProperty('--scroll-glow');
        document.documentElement.style.removeProperty('--scroll-grid');
        window.removeEventListener('scroll', requestScrollUpdate);
      }
    });
  }

  document.querySelectorAll('[data-toast]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!toast) return;
      toast.textContent = button.dataset.toast;
      toast.classList.add('visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
    });
  });

  document.querySelectorAll('[data-modal-open]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = document.getElementById(button.dataset.modalOpen);
      if (!dialog || typeof dialog.showModal !== 'function') return;
      dialog.classList.add('is-open');
      dialog.showModal();
      dialog.querySelector('.modal-close')?.focus();
    });
  });

  document.querySelectorAll('[data-modal-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = button.closest('dialog');
      if (!dialog) return;
      dialog.classList.remove('is-open');
      dialog.close();
    });
  });

  document.querySelectorAll('dialog[aria-labelledby]').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) {
        dialog.classList.remove('is-open');
        dialog.close();
      }
    });
    dialog.addEventListener('close', () => dialog.classList.remove('is-open'));
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

  // The landing page uses the particle canvas; pricing and privacy pages stay
  // static so they do not spend a continuously running animation frame on
  // content that does not benefit from it.
  if (!document.body.classList.contains('landing-page')) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'ambient-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const context = canvas.getContext('2d');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const points = Array.from({ length: 18 }, (_, index) => ({
    x: Math.random(),
    y: Math.random(),
    radius: 1 + Math.random() * 1.5,
    speed: 0.00008 + Math.random() * 0.00013,
    phase: index * 0.8,
  }));

  if (context && !prefersReducedMotion) {
    let animationFrame;
    let isVisible = document.visibilityState !== 'hidden';

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = window.innerWidth * ratio;
      canvas.height = window.innerHeight * ratio;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    let resizeTimer;
    const scheduleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 120);
    };

    const draw = (time = 0) => {
      animationFrame = undefined;
      if (!isVisible) return;
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
      points.forEach((point) => {
        const x = point.x * window.innerWidth + Math.sin(time * point.speed + point.phase) * 20;
        const y = point.y * window.innerHeight + Math.cos(time * point.speed + point.phase) * 14;
        context.beginPath();
        context.arc(x, y, point.radius, 0, Math.PI * 2);
        context.fillStyle = 'rgba(39, 131, 187, .12)';
        context.fill();
      });
      animationFrame = requestAnimationFrame(draw);
    };

    const updateVisibility = () => {
      isVisible = document.visibilityState !== 'hidden';
      if (!isVisible) {
        if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
      } else if (animationFrame === undefined) {
        animationFrame = requestAnimationFrame(draw);
      }
    };

    resize();
    window.addEventListener('resize', scheduleResize, { passive: true });
    document.addEventListener('visibilitychange', updateVisibility);
    animationFrame = requestAnimationFrame(draw);
  }
})();
