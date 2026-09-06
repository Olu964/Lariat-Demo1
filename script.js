(() => {
  const toast = document.querySelector('.toast');
  let toastTimer;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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

})();
