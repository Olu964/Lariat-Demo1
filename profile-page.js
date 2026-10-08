/* Profile page wiring (external file so CSP script-src 'self' allows it). */
(() => {
  'use strict';
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const CODE_RE = /^[0-9]{6}$/;

  const form = document.querySelector('#profile-form');
  const nameInput = document.querySelector('#profile-name');
  const emailInput = document.querySelector('#profile-email');
  const addressInput = document.querySelector('#profile-address');
  const checksWrap = document.querySelector('#profile-industries');
  const status = document.querySelector('#profile-status');
  const toast = document.querySelector('.toast');

  const finalizeBtn = document.querySelector('#finalize-email');
  const verifiedBadge = document.querySelector('#finalize-verified');
  const emailHint = document.querySelector('#email-hint');
  const lockedRow = document.querySelector('#finalize-locked-row');
  const emailDisplay = document.querySelector('#finalize-email-display');
  const editBtn = document.querySelector('#email-edit');
  const finalizePanel = document.querySelector('#finalize-panel');
  const finalizeIntro = document.querySelector('#finalize-intro');
  const codeStep = document.querySelector('#finalize-code-step');
  const codeInput = document.querySelector('#finalize-code');
  const confirmBtn = document.querySelector('#finalize-confirm');
  const resendBtn = document.querySelector('#finalize-resend');
  const finalizeStatus = document.querySelector('#finalize-status');

  // The address the current finalize flow is confirming (captured when the
  // user clicks Finalize Email, so later edits to the field cannot swap it).
  let finalizeEmail = '';
  // True while the user is editing a finalized address (via the Edit button).
  // A finalized address renders as locked text until Edit is pressed.
  let emailEditing = false;

  const showToast = (msg) => {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(window.__profileToast);
    window.__profileToast = setTimeout(() => toast.classList.remove('visible'), 3200);
  };
  const escapeHtml = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[c]));

  const storedProfile = () => (window.LariatProfile ? window.LariatProfile.get() : {
    displayName: '', email: '', emailVerifiedAt: '', industries: [], bookmarkedBills: [], legislatorAddress: '',
  });

  // Distinct subscription emails that differ from `exceptEmail`; these are
  // the old addresses the server will move on a successful finalize.
  const oldSubscriptionEmails = (exceptEmail) => {
    if (!window.LariatSubscriptions || typeof window.LariatSubscriptions.getSubscriptions !== 'function') return [];
    let subscriptions = [];
    try {
      subscriptions = window.LariatSubscriptions.getSubscriptions() || [];
    } catch (error) {
      return [];
    }
    const lowered = String(exceptEmail || '').toLowerCase();
    return [...new Set(
      subscriptions
        .map((subscription) => (subscription && typeof subscription.email === 'string' ? subscription.email.trim() : ''))
        .filter((address) => address && address.toLowerCase() !== lowered),
    )];
  };

  const setFinalizeStatus = (message) => {
    if (finalizeStatus) finalizeStatus.textContent = message || '';
  };

  function paint() {
    if (!window.LariatProfile) return;
    const p = storedProfile();
    if (nameInput && document.activeElement !== nameInput) nameInput.value = p.displayName || '';
    if (emailInput && document.activeElement !== emailInput) emailInput.value = p.email || '';
    if (addressInput && document.activeElement !== addressInput) addressInput.value = p.legislatorAddress || '';
    if (checksWrap && !checksWrap.dataset.built) {
      checksWrap.dataset.built = 'true';
      checksWrap.innerHTML = window.LariatProfile.ALL_INDUSTRIES.map((ind) =>
        `<label class="profile-check"><input type="checkbox" value="${escapeHtml(ind)}"> ${escapeHtml(ind)}</label>`
      ).join('');
    }
    if (checksWrap) {
      checksWrap.querySelectorAll('input[type="checkbox"]').forEach((box) => {
        box.checked = p.industries.includes(box.value);
      });
    }
    const verified = Boolean(p.email && p.emailVerifiedAt);
    // A finalized address locks into read-only text with an Edit button;
    // anything else stays an editable field with the Finalize button.
    const locked = verified && !emailEditing;
    if (verifiedBadge) verifiedBadge.hidden = !verified;
    if (lockedRow) lockedRow.hidden = !locked;
    if (emailDisplay && locked) emailDisplay.textContent = p.email || '';
    if (emailInput) emailInput.hidden = locked;
    if (finalizeBtn) finalizeBtn.hidden = locked;
    // Locked view shows only the address block + Edit (+ Verified badge);
    // the editable field, the hint to finalize, and Get code go away.
    if (emailHint) {
      emailHint.textContent = locked
        ? 'This address receives your industry subscriptions and future bill-update emails. Use Edit to change it.'
        : 'Finalize your email with a code we send you. It\'s used by default for industry subscriptions and future bill-update emails \u2014 changing it moves your existing subscriptions.';
    }
    // Reset the finalize flow whenever the page re-paints from elsewhere.
    if (document.activeElement !== emailInput
      && document.activeElement !== codeInput) {
      hideFinalizePanel();
      if (emailInput) emailInput.value = p.email || '';
    }
  }

  function hideFinalizePanel() {
    finalizeEmail = '';
    if (finalizePanel) finalizePanel.hidden = true;
    if (codeStep) codeStep.hidden = true;
    if (codeInput) codeInput.value = '';
    setFinalizeStatus('');
  }

  const backendErrorHint = (error) => {
    const message = error && error.message ? error.message : '';
    if (/no subscription backend configured|Could not reach the Lariat backend/i.test(message)) {
      return 'Get code needs the local backend: run `node server/server.js`, then try again.';
    }
    return message || 'Something went wrong. Please try again.';
  };

  if (editBtn) {
    editBtn.addEventListener('click', () => {
      emailEditing = true;
      paint();
      if (emailInput) {
        emailInput.focus();
        if (typeof emailInput.select === 'function') {
          try { emailInput.select(); } catch (error) { /* ignore */ }
        }
      }
    });
  }
  if (finalizeBtn) {
    finalizeBtn.addEventListener('click', () => {
      const raw = (emailInput ? emailInput.value : '').trim();
      if (!EMAIL_RE.test(raw)) {
        setFinalizeStatus('Please type a valid email address first.');
        showToast('Please type a valid email address first.');
        if (emailInput) emailInput.focus();
        return;
      }
      const stored = storedProfile();
      if (stored.email === raw && stored.emailVerifiedAt) {
        setFinalizeStatus('');
        showToast('That address is already finalized.');
        if (finalizePanel) finalizePanel.hidden = true;
        return;
      }
      finalizeEmail = raw;
      setFinalizeStatus('');
      if (codeStep) codeStep.hidden = true;
      if (codeInput) codeInput.value = '';
      if (finalizeIntro) {
        const others = oldSubscriptionEmails(raw);
        finalizeIntro.textContent = others.length
          ? `We'll send a 6-digit code to ${raw}. Confirming also moves your existing subscriptions (${others.join(', ')}) to this address.`
          : `We'll send a 6-digit code to ${raw}. Enter it below, then Finalize.`;
      }
      if (finalizePanel) finalizePanel.hidden = false;
      requestCode(false);
    });
  }

  const requestCode = async (isResend) => {
    if (!finalizeEmail) {
      setFinalizeStatus('Click Get code first.');
      return;
    }
    if (!window.LariatSubscriptions || typeof window.LariatSubscriptions.post !== 'function') {
      setFinalizeStatus('Get code needs the local backend: run `node server/server.js`, then try again.');
      return;
    }
    setFinalizeStatus(isResend ? 'Resending the code…' : 'Sending the code…');
    try {
      await window.LariatSubscriptions.post('/api/profile/email/request', {
        email: finalizeEmail,
      });
    } catch (error) {
      const message = backendErrorHint(error);
      setFinalizeStatus(message);
      showToast(message);
      return;
    }
    if (codeStep) codeStep.hidden = false;
    if (codeInput) {
      codeInput.value = '';
      codeInput.focus();
    }
    setFinalizeStatus(`Code sent to ${finalizeEmail}. It expires in 10 minutes and can only be used once.`);
    showToast(`Code sent to ${finalizeEmail}.`);
  };

  if (resendBtn) resendBtn.addEventListener('click', () => requestCode(true));

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      if (!finalizeEmail) {
        setFinalizeStatus('Click Get code first.');
        return;
      }
      const code = (codeInput ? codeInput.value : '').trim();
      if (!CODE_RE.test(code)) {
        setFinalizeStatus('The confirmation code must be 6 digits.');
        showToast('The confirmation code must be 6 digits.');
        if (codeInput) codeInput.focus();
        return;
      }
      if (!window.LariatSubscriptions || typeof window.LariatSubscriptions.post !== 'function') {
        setFinalizeStatus('Get code needs the local backend: run `node server/server.js`, then try again.');
        return;
      }
      const oldEmails = oldSubscriptionEmails(finalizeEmail);
      setFinalizeStatus('Confirming…');
      let data;
      try {
        data = await window.LariatSubscriptions.post('/api/profile/email/verify', {
          email: finalizeEmail,
          code,
          oldEmails,
        });
      } catch (error) {
        setFinalizeStatus(backendErrorHint(error));
        if (codeInput) codeInput.focus();
        return;
      }
      const verifiedAt = new Date().toISOString();
      window.LariatProfile.set({ email: finalizeEmail, emailVerifiedAt: verifiedAt });
      // Move the local subscription badges to the finalized address.
      let replaced = [];
      try {
        if (typeof window.LariatSubscriptions.adoptEmail === 'function') {
          replaced = window.LariatSubscriptions.adoptEmail(finalizeEmail) || [];
        }
      } catch (error) { /* server records already moved; badges catch up on next load */ }
      emailEditing = false;
      hideFinalizePanel();
      paint();
      const moved = data && typeof data.moved === 'number' ? data.moved : replaced.length;
      if (status) status.textContent = 'Email finalized.';
      showToast(moved
        ? `Email finalized — ${moved} subscription${moved === 1 ? '' : 's'} moved to ${finalizeEmail}.`
        : `Email finalized (${finalizeEmail}).`);
    });
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const stored = storedProfile();
      const emailRaw = (emailInput ? emailInput.value : '').trim();
      const industries = [...checksWrap.querySelectorAll('input[type="checkbox"]:checked')].map((b) => b.value);
      // Email changes only through Finalize Email: Save profile keeps the
      // rest and leaves the stored address untouched.
      const emailNote = emailRaw !== (stored.email || '')
        ? ' Email unchanged — click Get code to save a new address.'
        : '';
      // Saving with the stored address untouched re-locks the display.
      if (!emailNote) emailEditing = false;
      window.LariatProfile.set({
        displayName: nameInput.value,
        industries,
        legislatorAddress: addressInput.value,
      });
      if (emailInput) emailInput.value = stored.email || '';
      if (status) status.textContent = `Saved in this browser.${emailNote}`;
      showToast(`Profile saved in this browser.${emailNote}`);
      paint();
    });
  }

  document.querySelector('#profile-clear')?.addEventListener('click', () => {
    window.LariatProfile.clear();
    emailEditing = false;
    hideFinalizePanel();
    if (status) status.textContent = 'Profile cleared in this browser.';
    showToast('Profile cleared.');
    paint();
  });

  document.addEventListener('lariat:profile-changed', paint);
  paint();
})();
