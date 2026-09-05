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

  const bookStage = document.querySelector('[data-law-book-stage]');
  const lawBook = bookStage?.querySelector('[data-law-book]');
  if (bookStage && lawBook && !reduceMotion.matches && window.matchMedia('(pointer: fine)').matches) {
    let currentAngle = 0;
    let targetAngle = 0;
    let currentSheenX = 50;
    let currentSheenY = 50;
    let targetSheenX = 50;
    let targetSheenY = 50;
    let animationFrame;
    let isActive = false;

    const animateBook = () => {
      const angleDifference = targetAngle - currentAngle;
      currentAngle += angleDifference * 0.065;
      currentSheenX += (targetSheenX - currentSheenX) * 0.08;
      currentSheenY += (targetSheenY - currentSheenY) * 0.08;
      lawBook.style.setProperty('--book-angle', `${currentAngle}deg`);
      lawBook.style.setProperty('--book-sheen-x', `${currentSheenX}%`);
      lawBook.style.setProperty('--book-sheen-y', `${currentSheenY}%`);
      if (isActive || Math.abs(angleDifference) > 0.03 || Math.abs(targetSheenX - currentSheenX) > 0.03) {
        animationFrame = requestAnimationFrame(animateBook);
      } else {
        animationFrame = undefined;
      }
    };

    const startAnimation = () => {
      if (animationFrame === undefined) animationFrame = requestAnimationFrame(animateBook);
    };
    const setTargetAngle = (desiredAngle) => {
      const shortestTurn = ((desiredAngle - currentAngle + 180) % 360 + 360) % 360 - 180;
      targetAngle = currentAngle + shortestTurn;
    };

    document.addEventListener('pointermove', (event) => {
      const bounds = lawBook.getBoundingClientRect();
      const centerX = bounds.left + bounds.width / 2;
      const centerY = bounds.top + bounds.height / 2;
      const desiredAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX) * (180 / Math.PI) + 90;
      setTargetAngle(desiredAngle);
      targetSheenX = Math.max(18, Math.min(82, ((event.clientX - bounds.left) / bounds.width) * 100));
      targetSheenY = Math.max(18, Math.min(82, ((event.clientY - bounds.top) / bounds.height) * 100));
      isActive = true;
      startAnimation();
    }, { passive: true });
    document.addEventListener('pointerleave', () => {
      setTargetAngle(0);
      targetSheenX = 50;
      targetSheenY = 50;
      isActive = false;
      startAnimation();
    });
    document.addEventListener('pointercancel', () => {
      setTargetAngle(0);
      targetSheenX = 50;
      targetSheenY = 50;
      isActive = false;
      startAnimation();
    });
    startAnimation();
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

  const dialogTriggers = new WeakMap();

  const openDialog = (dialog, trigger = null) => {
    if (!dialog || typeof dialog.showModal !== 'function' || dialog.open) return;
    if (trigger) dialogTriggers.set(dialog, trigger);
    dialog.classList.add('is-open');
    dialog.showModal();
    dialog.querySelector('.modal-close')?.focus();
  };

  document.querySelectorAll('[data-modal-open]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      openDialog(document.getElementById(trigger.dataset.modalOpen), trigger);
    });
  });

  const demoNotice = document.querySelector('#demo-notice');
  const demoNoticeStorageKey = 'lariat-demo-notice-seen-v3';
  if (document.body.classList.contains('landing-page')) {
    let hasSeenDemoNotice = false;
    try {
      hasSeenDemoNotice = localStorage.getItem(demoNoticeStorageKey) === 'true';
      if (!hasSeenDemoNotice) localStorage.setItem(demoNoticeStorageKey, 'true');
    } catch (error) {
      // If storage is blocked, show the notice for this visit.
    }
    if (!hasSeenDemoNotice) openDialog(demoNotice);
  }

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
    dialog.addEventListener('close', () => {
      dialog.classList.remove('is-open');
      const trigger = dialogTriggers.get(dialog);
      dialogTriggers.delete(dialog);
      trigger?.focus();
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
