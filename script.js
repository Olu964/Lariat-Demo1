(() => {
  const toast = document.querySelector('.toast');
  let toastTimer;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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

  // Our Vision text reveal: split paragraphs into rendered lines that
  // cascade in with a stagger on open and as the pages scroll.
  const visionLineObserver = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        visionLineObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.4 }) : null;

  function splitVisionLines(dialog) {
    const paragraphs = dialog.querySelectorAll('.vision-prose p');
    let lineIndex = dialog.querySelectorAll('.vline').length;
    paragraphs.forEach((p) => {
      if (p.dataset.split === 'true') return;
      const original = p.textContent.trim().replace(/\s+/g, ' ');
      p.dataset.original = original;
      p.dataset.split = 'true';
      p.textContent = '';
      original.split(' ').forEach((word) => {
        const w = document.createElement('span');
        w.className = 'vword';
        w.textContent = word;
        p.appendChild(w);
        p.appendChild(document.createTextNode(' '));
      });
      const words = Array.from(p.querySelectorAll('.vword'));
      const lines = [];
      let current = [];
      let lastTop = null;
      words.forEach((w) => {
        if (lastTop === null || w.offsetTop !== lastTop) {
          if (current.length) lines.push(current);
          current = [w];
          lastTop = w.offsetTop;
        } else {
          current.push(w);
        }
      });
      if (current.length) lines.push(current);
      p.textContent = '';
      lines.forEach((lineWords) => {
        const line = document.createElement('span');
        line.className = 'vline';
        line.dataset.vindex = String(lineIndex);
        line.style.setProperty('--vdelay', `${Math.min(lineIndex * 60, 700)}ms`);
        lineIndex += 1;
        lineWords.forEach((w, i) => {
          line.appendChild(w);
          if (i < lineWords.length - 1) line.appendChild(document.createTextNode(' '));
        });
        p.appendChild(line);
      });
    });
  }

  function unsplitVisionLines(dialog) {
    dialog.querySelectorAll('.vision-prose p[data-split="true"]').forEach((p) => {
      p.textContent = p.dataset.original || p.textContent;
      delete p.dataset.split;
      delete p.dataset.original;
    });
  }

  document.querySelectorAll('[data-vision-reveal]').forEach((root) => {
    if (reduceMotion.matches) return;
    setupVisionReveal(root);
  });

  function setupVisionReveal(dialog) {
    splitVisionLines(dialog);
    dialog.querySelectorAll('.vline').forEach((line) => {
      if (line.classList.contains('is-visible')) return;
      if (visionLineObserver) visionLineObserver.observe(line);
      else line.classList.add('is-visible');
    });
  }

  let visionResizeTimer;
  window.addEventListener('resize', () => {
    window.clearTimeout(visionResizeTimer);
    visionResizeTimer = window.setTimeout(() => {
      document.querySelectorAll('[data-vision-reveal]').forEach((dialog) => {
        if (!dialog.querySelector('.vline')) return;
        const visibleCount = dialog.querySelectorAll('.vline.is-visible').length;
        unsplitVisionLines(dialog);
        splitVisionLines(dialog);
        dialog.querySelectorAll('.vline').forEach((line, i) => {
          if (i < visibleCount) {
            line.style.setProperty('--vdelay', '0ms');
            line.classList.add('is-visible');
          } else if (visionLineObserver) {
            visionLineObserver.observe(line);
          } else {
            line.classList.add('is-visible');
          }
        });
      });
    }, 200);
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
