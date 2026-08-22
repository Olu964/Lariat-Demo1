(() => {
  'use strict';

  /* ==========================================================================
   * Lariat subscription flow — backed by the local Node.js backend
   * (server/server.js). The browser never sees an email API key; it only talks
   * to the backend, which verifies codes and sends email server-side.
   *
   *   POST /api/subscriptions/request      { email, industry, accessCode }
   *   POST /api/subscriptions/verify       { email, industry, verificationCode }
   *   POST /api/subscriptions/unsubscribe  { email, industry }
   *
   * When the page itself is served by the backend (http://127.0.0.1:3000) the
   * API is same-origin. If the frontend is served separately (for example
   * `python3 -m http.server 8000`), the API base falls back to port 3000.
   * ========================================================================== */

  // Where the subscription API lives. Live deployments can point this at a
  // real API by setting window.LARIAT_API_BASE before this script loads.
  // Otherwise: same-origin when the page is served by the local backend
  // (:3000), or that backend on this machine for local dev servers. From any
  // other page (e.g. a deployed https site) there is no backend, so API calls
  // are disabled instead of falling back to an insecure cross-origin fetch.
  const API_BASE = (() => {
    if (typeof window.LARIAT_API_BASE === 'string' && window.LARIAT_API_BASE.trim()) {
      return window.LARIAT_API_BASE.trim().replace(/\/+$/, '');
    }
    const { protocol, hostname, port } = window.location;
    const isLocalHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
    if (port === '3000' || port === '') return '';
    if (protocol === 'http:' && isLocalHost) return 'http://127.0.0.1:3000';
    return null;
  })();

  const SUBSCRIPTIONS_STORAGE_KEY = 'lariat-subscriptions-v2';
  const PLAN_STORAGE_KEY = 'lariat-demo-plan-v1';
  const LEGACY_SUBSCRIPTIONS_STORAGE_KEY = 'lariat-subscriptions-v1';
  const LEGACY_PENDING_CODE_STORAGE_KEY = 'lariat-pending-code-v1';
  const ACCESS_CODE_LOCKOUT_STORAGE_KEY = 'lariat-access-code-lockout-v1';
  const ACCESS_CODE_LOCKOUT_MS = 24 * 60 * 60 * 1000;
  const PLAN_DEFINITIONS = Object.freeze({
    free: { id: 'free', name: 'Free', price: '$0/month', maxIndustries: 1 },
    professional: { id: 'professional', name: 'Professional', price: '$29/month', maxIndustries: 5 },
    business: { id: 'business', name: 'Business', price: '$99/month', maxIndustries: Infinity },
  });
  const DEFAULT_PLAN_ID = 'free';

  const modal = document.querySelector('#subscribe-modal');
  const modalBody = document.querySelector('#subscribe-modal-body');
  const modalClose = document.querySelector('#subscribe-modal-close');
  let lastFocusedElement = null;
  let currentIndustry = '';
  let currentEmail = '';
  let accessCodeLockoutTimer = null;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'\"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));

  const readJson = (key) => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      return null;
    }
  };

  const getAccessCodeLockoutUntil = () => {
    try {
      const until = Number(localStorage.getItem(ACCESS_CODE_LOCKOUT_STORAGE_KEY));
      if (until > Date.now() && until <= Date.now() + ACCESS_CODE_LOCKOUT_MS) return until;
      localStorage.removeItem(ACCESS_CODE_LOCKOUT_STORAGE_KEY);
    } catch (error) { /* the backend still enforces the lockout */ }
    return 0;
  };

  const saveAccessCodeLockoutUntil = (until) => {
    try {
      localStorage.setItem(ACCESS_CODE_LOCKOUT_STORAGE_KEY, String(until));
    } catch (error) { /* the backend still enforces the lockout */ }
    updateAccessCodeLockoutUi();
  };

  const formatLockoutCountdown = (milliseconds) => {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  };

  const updateAccessCodeLockoutUi = () => {
    const lockoutMessage = modalBody?.querySelector('[data-access-lockout]');
    const sendButton = modalBody?.querySelector('[data-subscribe-send]');
    const emailInput = modalBody?.querySelector('#subscribe-email');
    const accessCodeInput = modalBody?.querySelector('#subscribe-access-code');
    const until = getAccessCodeLockoutUntil();
    if (!lockoutMessage || !sendButton || !emailInput || !accessCodeInput) return;

    if (!until) {
      lockoutMessage.hidden = true;
      lockoutMessage.textContent = '';
      sendButton.disabled = false;
      sendButton.textContent = 'Send verification code';
      emailInput.disabled = false;
      accessCodeInput.disabled = false;
      if (accessCodeLockoutTimer) window.clearInterval(accessCodeLockoutTimer);
      accessCodeLockoutTimer = null;
      return;
    }

    const refresh = () => {
      const remaining = until - Date.now();
      if (remaining <= 0) {
        try { localStorage.removeItem(ACCESS_CODE_LOCKOUT_STORAGE_KEY); } catch (error) { /* ignore */ }
        updateAccessCodeLockoutUi();
        return;
      }
      lockoutMessage.hidden = false;
      lockoutMessage.textContent = `Subscription access is temporarily locked after 3 incorrect access-code attempts. Try again in ${formatLockoutCountdown(remaining)}.`;
      sendButton.disabled = true;
      sendButton.textContent = 'Locked for 24 hours';
      emailInput.disabled = true;
      accessCodeInput.disabled = true;
    };
    refresh();
    if (!accessCodeLockoutTimer) accessCodeLockoutTimer = window.setInterval(refresh, 1000);
  };

  const getSubscriptions = () => {
    const stored = readJson(SUBSCRIPTIONS_STORAGE_KEY);
    return Array.isArray(stored) ? stored : [];
  };

  const getSelectedPlanId = () => {
    try {
      const stored = localStorage.getItem(PLAN_STORAGE_KEY);
      return PLAN_DEFINITIONS[stored] ? stored : DEFAULT_PLAN_ID;
    } catch (error) {
      return DEFAULT_PLAN_ID;
    }
  };

  const getSelectedPlan = () => PLAN_DEFINITIONS[getSelectedPlanId()];
  const planLimitText = (plan = getSelectedPlan()) =>
    plan.maxIndustries === Infinity ? 'all available industries' : `${plan.maxIndustries} ${plan.maxIndustries === 1 ? 'industry' : 'industries'}`;
  const usageText = (plan = getSelectedPlan()) =>
    plan.maxIndustries === Infinity
      ? `${getSubscriptions().length} industries selected · no demo limit`
      : `${getSubscriptions().length}/${plan.maxIndustries} industries selected`;

  const updatePlanStatus = () => {
    const plan = getSelectedPlan();
    const planName = document.querySelector('[data-plan-name]');
    const planUsage = document.querySelector('[data-plan-usage]');
    if (planName) planName.textContent = `Demo plan: ${plan.name}`;
    if (planUsage) planUsage.textContent = usageText(plan);
  };

  const syncPlanControls = () => {
    const selectedPlanId = getSelectedPlanId();
    document.querySelectorAll('[data-plan-card]').forEach((card) => {
      card.classList.toggle('selected-plan', card.dataset.planCard === selectedPlanId);
    });
    document.querySelectorAll('[data-select-plan]').forEach((control) => {
      const selected = control.dataset.selectPlan === selectedPlanId;
      control.classList.toggle('selected', selected);
      if (selected) control.setAttribute('aria-current', 'true');
      else control.removeAttribute('aria-current');
    });
    updatePlanStatus();
  };

  const selectPlan = (planId) => {
    if (!PLAN_DEFINITIONS[planId]) return false;
    try {
      localStorage.setItem(PLAN_STORAGE_KEY, planId);
    } catch (error) {
      showToast('This browser blocked demo plan storage. The selection may not persist.');
    }
    syncPlanControls();
    document.dispatchEvent(new CustomEvent('lariat:plan-changed', { detail: { planId } }));
    return true;
  };

  const canAddIndustry = (industry) => {
    if (isSubscribed(industry)) return true;
    const plan = getSelectedPlan();
    return plan.maxIndustries === Infinity || getSubscriptions().length < plan.maxIndustries;
  };

  const isSubscribed = (industry) =>
    getSubscriptions().some((subscription) => subscription.industry === industry);

  document.querySelectorAll('[data-select-plan]').forEach((control) => {
    control.addEventListener('click', (event) => {
      event.preventDefault();
      selectPlan(control.dataset.selectPlan);
      window.location.href = control.getAttribute('href') || 'feed.html';
    });
  });
  syncPlanControls();

  const showToast = (message) => {
    const toast = document.querySelector('.toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(window.__lariatToastTimer);
    window.__lariatToastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
  };

  const setStatus = (message, isError = false) => {
    const status = modalBody.querySelector('[data-subscribe-status]');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const openModal = () => {
    if (!modal) return;
    lastFocusedElement = document.activeElement;
    if (typeof modal.showModal === 'function') {
      if (!modal.open) modal.showModal();
    } else {
      modal.setAttribute('open', '');
      modal.classList.add('is-open');
      modal.setAttribute('aria-modal', 'true');
    }
  };

  const closeModal = () => {
    if (!modal) return;
    if (typeof modal.close === 'function' && modal.open) {
      modal.close();
    } else {
      modal.removeAttribute('open');
      modal.classList.remove('is-open');
      modal.removeAttribute('aria-modal');
    }
    if (accessCodeLockoutTimer) window.clearInterval(accessCodeLockoutTimer);
    accessCodeLockoutTimer = null;
    lastFocusedElement?.focus();
  };

  const renderEmailStep = () => {
    modalBody.innerHTML = `
      <form class="subscribe-form" data-subscribe-form novalidate>
        <p class="subscribe-industry-line"><span class="subscribe-industry-label">Industry</span><strong>${escapeHtml(currentIndustry)}</strong></p>
        <p class="subscribe-plan-line"><span class="subscribe-industry-label">Demo plan</span><strong>${escapeHtml(getSelectedPlan().name)}</strong><span>· ${escapeHtml(usageText())}</span></p>
        <label class="subscribe-label" for="subscribe-email">Email address</label>
        <input class="subscribe-input" id="subscribe-email" type="email" name="email" autocomplete="email" placeholder="you@example.com" value="${escapeHtml(currentEmail)}" required>
        <label class="subscribe-label" for="subscribe-access-code">Private access code</label>
        <input class="subscribe-input" id="subscribe-access-code" type="password" name="accessCode" autocomplete="off" placeholder="Provided by your team" aria-describedby="subscribe-access-hint" required>
        <p id="subscribe-access-hint" class="subscribe-hint">Ask your team for the private access code for this trial.</p>
        <p class="subscribe-lockout" data-access-lockout role="status" aria-live="polite" hidden></p>
        <p class="subscribe-status" data-subscribe-status role="status" aria-live="polite"></p>
        <button class="subscribe-button submit" type="submit" data-subscribe-send title="Email a 6-digit verification code">Send verification code</button>
        <p class="subscribe-privacy">Your email is used only for Lariat bill alerts. Verification happens on your local Lariat backend — no email API keys are exposed in the browser. Free for you and for us — no payment or credit card required.</p>
      </form>
    `;
    updateAccessCodeLockoutUi();
  };

  const renderCodeStep = () => {
    modalBody.innerHTML = `
      <form class="subscribe-form" data-subscribe-form novalidate>
        <p class="subscribe-industry-line"><span class="subscribe-industry-label">Industry</span><strong>${escapeHtml(currentIndustry)}</strong></p>
        <p class="subscribe-hint">We sent a 6-digit code to <strong>${escapeHtml(currentEmail)}</strong>. Enter it below to confirm your subscription. The code expires in 10 minutes and can only be used once. If the email doesn't arrive, check your spam folder — it comes from the Lariat alerts address.</p>
        <label class="subscribe-label" for="subscribe-code">Verification code</label>
        <input class="subscribe-input subscribe-code-input" id="subscribe-code" type="text" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" placeholder="123456" required>
        <p class="subscribe-status" data-subscribe-status role="status" aria-live="polite"></p>
        <button class="subscribe-button submit" type="submit" data-subscribe-confirm title="Activate alerts for this industry">Confirm subscription</button>
        <button class="subscribe-button link" type="button" data-subscribe-resend title="Send the verification code again">Resend code</button>
      </form>
    `;
  };

  const api = async (path, body) => {
    if (API_BASE === null) {
      throw new Error('This deployment has no subscription backend configured. Set window.LARIAT_API_BASE, or run the site from the local Lariat backend (node server/server.js).');
    }
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error('Could not reach the Lariat backend. Start it with `node server/server.js`, then try again.');
    }
    let data = {};
    try {
      data = await response.json();
    } catch (error) { /* non-JSON error body */ }
    if (!response.ok || data.ok === false) {
      const message = data && data.error ? data.error : `Request failed (HTTP ${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      error.code = data && data.code;
      error.lockoutUntil = data && data.lockoutUntil;
      error.retryAfterSeconds = data && data.retryAfterSeconds;
      error.attemptsRemaining = data && data.attemptsRemaining;
      throw error;
    }
    return data;
  };

  const sendVerificationCode = async () => {
    if (getAccessCodeLockoutUntil()) {
      updateAccessCodeLockoutUi();
      return;
    }
    const emailInput = modalBody.querySelector('#subscribe-email');
    const accessCodeInput = modalBody.querySelector('#subscribe-access-code');
    const status = modalBody.querySelector('[data-subscribe-status]');
    const sendButton = modalBody.querySelector('[data-subscribe-send]');

    currentEmail = (emailInput?.value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(currentEmail)) {
      setStatus('Please enter a valid email address.', true);
      emailInput?.focus();
      return;
    }
    const accessCode = (accessCodeInput?.value || '').trim();
    if (!accessCode) {
      setStatus('Please enter the private access code.', true);
      accessCodeInput?.focus();
      return;
    }

    if (sendButton) {
      sendButton.disabled = true;
      sendButton.textContent = 'Sending…';
    }
    if (status) status.textContent = 'Sending your verification code…';

    try {
      await api('/api/subscriptions/request', {
        email: currentEmail,
        industry: currentIndustry,
        accessCode,
      });
      renderCodeStep();
      modalBody.querySelector('#subscribe-code')?.focus();
    } catch (error) {
      if (error.code === 'access_code_locked' && error.lockoutUntil) {
        saveAccessCodeLockoutUntil(new Date(error.lockoutUntil).getTime());
      } else {
        setStatus(error.message, true);
      }
      if (sendButton && error.code !== 'access_code_locked') {
        sendButton.disabled = false;
        sendButton.textContent = 'Send verification code';
      }
    }
  };

  const confirmSubscription = async () => {
    const codeInput = modalBody.querySelector('#subscribe-code');
    const entered = (codeInput?.value || '').trim();
    if (!/^[0-9]{6}$/.test(entered)) {
      setStatus('Please enter the 6-digit code from the email.', true);
      codeInput?.focus();
      return;
    }

    if (!canAddIndustry(currentIndustry)) {
      setStatus(`Your ${getSelectedPlan().name} demo plan allows ${planLimitText(getSelectedPlan())}. Choose another plan before confirming.`, true);
      return;
    }

    let data;
    try {
      data = await api('/api/subscriptions/verify', {
        email: currentEmail,
        industry: currentIndustry,
        verificationCode: entered,
      });
    } catch (error) {
      setStatus(error.message, true);
      codeInput?.focus();
      return;
    }

    const subscriptions = getSubscriptions();
    if (!subscriptions.some((subscription) => subscription.industry === currentIndustry)) {
      if (!canAddIndustry(currentIndustry)) {
        closeModal();
        showToast(`Your ${getSelectedPlan().name} demo plan has reached its industry limit.`);
        return;
      }
      const storedSubscription = {
        email: currentEmail,
        industry: currentIndustry,
        verifiedAt: data.subscription?.verifiedAt || new Date().toISOString(),
      };
      // The signed token lets the in-app Unsubscribe button prove ownership of
      // the address without asking for the verification code again.
      if (typeof data.unsubscribeToken === 'string' && data.unsubscribeToken) {
        storedSubscription.unsubscribeToken = data.unsubscribeToken;
      }
      subscriptions.push(storedSubscription);
      try {
        localStorage.setItem(SUBSCRIPTIONS_STORAGE_KEY, JSON.stringify(subscriptions));
      } catch (error) {
        // The backend still has the subscription; only the local badge fails.
        showToast("Subscribed — but the browser couldn't save the badge state.");
      }
    }

    updatePlanStatus();
    closeModal();
    showToast(`You're subscribed to ${currentIndustry} alerts.`);
    document.dispatchEvent(new CustomEvent('lariat:subscriptions-changed', { detail: { industry: currentIndustry } }));
  };

  const unsubscribe = async (industry) => {
    const subscription = getSubscriptions().find((item) => item.industry === industry);
    if (!subscription) {
      showToast(`You're not subscribed to ${industry} alerts in this browser.`);
      return;
    }
    if (!subscription.unsubscribeToken) {
      showToast('Use the unsubscribe link from your welcome email, or subscribe again to get a fresh one.');
      return;
    }
    try {
      await api('/api/subscriptions/unsubscribe', {
        email: subscription.email,
        industry,
        token: subscription.unsubscribeToken,
      });
    } catch (error) {
      showToast(`Could not unsubscribe: ${error.message}`);
      return;
    }
    try {
      localStorage.setItem(
        SUBSCRIPTIONS_STORAGE_KEY,
        JSON.stringify(getSubscriptions().filter((item) => item.industry !== industry)),
      );
    } catch (error) { /* ignore */ }
    updatePlanStatus();
    showToast(`Unsubscribed from ${industry} alerts.`);
    document.dispatchEvent(new CustomEvent('lariat:subscriptions-changed', { detail: { industry } }));
  };

  modalBody?.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-subscribe-form]');
    if (!form) return;
    event.preventDefault();
    if (form.querySelector('#subscribe-email')) {
      sendVerificationCode();
      return;
    }
    confirmSubscription();
  });

  modalBody?.addEventListener('click', (event) => {
    if (event.target.closest('[data-subscribe-resend]')) sendVerificationCode();
  });

  modalClose?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });
  modal?.addEventListener('close', () => lastFocusedElement?.focus());

  const reset = () => {
    try {
      localStorage.removeItem(SUBSCRIPTIONS_STORAGE_KEY);
      localStorage.removeItem(LEGACY_SUBSCRIPTIONS_STORAGE_KEY);
      localStorage.removeItem(LEGACY_PENDING_CODE_STORAGE_KEY);
    } catch (error) { /* ignore */ }
    updatePlanStatus();
    document.dispatchEvent(new CustomEvent('lariat:subscriptions-changed', { detail: {} }));
    showToast('Demo subscriptions reset — the badge state is back to a clean slate. (Records already saved on the backend are kept.)');
  };

  window.LariatSubscriptions = {
    open(industry) {
      if (!modal) return;
      if (isSubscribed(industry)) {
        showToast(`You're already subscribed to ${industry} alerts.`);
        return;
      }
      if (!canAddIndustry(industry)) {
        const plan = getSelectedPlan();
        showToast(`${plan.name} allows ${planLimitText(plan)}. Choose another demo plan on the Pricing page.`);
        return;
      }
      currentIndustry = industry;
      currentEmail = '';
      renderEmailStep();
      openModal();
      modalBody.querySelector('#subscribe-email')?.focus();
    },
    isSubscribed,
    unsubscribe,
    reset,
    selectPlan,
    getSelectedPlan,
    getSubscriptions,
    canAddIndustry,
  };
})();
