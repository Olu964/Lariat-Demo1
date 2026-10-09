(() => {
  'use strict';

  /* ==========================================================================
   * Lariat browser store  -  industry subscriptions, demo plan selection,
   * subscription badge state, and the backend POST helper.
   *
   * Industry subscribe/unsubscribe posts to /api/subscriptions/* and mirrors
   * the result into the local badge store (lariat-subscriptions-v2) so the
   * Your Saves page can render instantly. It keeps:
   *   - the demo plan system (Free / Professional / Business) that powers
   *     the pricing tab and the feed plan display,
   *   - the local subscription badge store (read + adopt into a finalized
   *     profile email),
   *   - `post`, the same-origin backend helper used by profile-page.js.
   * API is same-origin. If the frontend is served separately (for example
   * `python3 -m http.server 8000`), the API base falls back to port 3000.
   * ========================================================================== */

  // Where the backend API lives. Live deployments can point this at a
  // real API in api-config.js, which sets window.LARIAT_API_BASE before this
  // script loads.
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
  const PLAN_DEFINITIONS = Object.freeze({
    free: { id: 'free', name: 'Free', price: '$0/month', maxIndustries: 1 },
    professional: { id: 'professional', name: 'Professional', price: '$29/month', maxIndustries: 5 },
    business: { id: 'business', name: 'Business', price: '$99/month', maxIndustries: Infinity },
  });
  const DEFAULT_PLAN_ID = 'free';

  const readJson = (key) => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      return null;
    }
  };

  const getSubscriptions = () => {
    const stored = readJson(SUBSCRIPTIONS_STORAGE_KEY);
    if (!Array.isArray(stored)) return [];
    const sanitized = stored
      .filter((subscription) => subscription && typeof subscription.industry === 'string')
      .map((subscription) => ({
        email: typeof subscription.email === 'string' ? subscription.email : '',
        industry: subscription.industry,
        ...(typeof subscription.verifiedAt === 'string' ? { verifiedAt: subscription.verifiedAt } : {}),
      }));
    // Remove bearer tokens left by the pre-audit client implementation.
    if (JSON.stringify(sanitized) !== JSON.stringify(stored)) {
      try { localStorage.setItem(SUBSCRIPTIONS_STORAGE_KEY, JSON.stringify(sanitized)); } catch (error) { /* ignore */ }
    }
    return sanitized;
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
    // Choosing a plan is a subscribe attempt: the profile email must be
    // finalized with its code first (see profile.js requireVerifiedEmail).
    if (window.LariatProfile && typeof window.LariatProfile.requireVerifiedEmail === 'function' && !window.LariatProfile.requireVerifiedEmail()) {
      return false;
    }
    try {
      localStorage.setItem(PLAN_STORAGE_KEY, planId);
    } catch (error) {
      showToast('This browser blocked demo plan storage. The selection may not persist.');
    }
    syncPlanControls();
    document.dispatchEvent(new CustomEvent('lariat:plan-changed', { detail: { planId } }));
    return true;
  };

  document.querySelectorAll('[data-select-plan]').forEach((control) => {
    control.addEventListener('click', (event) => {
      event.preventDefault();
      if (!selectPlan(control.dataset.selectPlan)) return;
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
      // `error` may be a non-string shape from a proxy/platform response —
      // only validated strings reach Error, never "[object Object]".
      const serverMessage = data && typeof data.error === 'string' && data.error.trim() ? data.error : '';
      const message = serverMessage || `Request failed (HTTP ${response.status}).`;
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

  // Moves local subscription badges to a newly finalized profile email.
  // Returns the distinct old email addresses that were replaced.
  const adoptEmail = (newEmail) => {
    const clean = String(newEmail || '').trim();
    if (!clean) return [];
    const subscriptions = getSubscriptions();
    const replaced = [...new Set(
      subscriptions
        .map((subscription) => subscription.email || '')
        .filter((address) => address && address.toLowerCase() !== clean.toLowerCase()),
    )];
    if (!replaced.length) return [];
    subscriptions.forEach((subscription) => {
      if (replaced.includes(subscription.email)) subscription.email = clean;
    });
    try {
      localStorage.setItem(SUBSCRIPTIONS_STORAGE_KEY, JSON.stringify(subscriptions));
    } catch (error) { /* badge state only; the backend keeps its own records */ }
    document.dispatchEvent(new CustomEvent('lariat:subscriptions-changed', { detail: {} }));
    return replaced;
  };

  const profileEmail = () => (window.LariatProfile ? window.LariatProfile.get().email : '');

  const profileIndustries = () => (window.LariatProfile && Array.isArray(window.LariatProfile.ALL_INDUSTRIES)
    ? window.LariatProfile.ALL_INDUSTRIES
    : []);

  const matchesBadge = (subscription, industry, email) => subscription.industry === industry
    && (subscription.email || '').toLowerCase() === email.toLowerCase();

  // True when the finalized profile email is subscribed to this industry.
  const isSubscribed = (industry) => {
    const clean = String(industry || '').trim();
    const email = profileEmail();
    if (!clean || !email) return false;
    return getSubscriptions().some((subscription) => matchesBadge(subscription, clean, email));
  };

  const writeBadges = (subscriptions) => {
    try {
      localStorage.setItem(SUBSCRIPTIONS_STORAGE_KEY, JSON.stringify(subscriptions));
    } catch (error) { /* badge state only; the backend keeps its own records */ }
    document.dispatchEvent(new CustomEvent('lariat:subscriptions-changed', { detail: {} }));
  };

  // Subscribes the finalized profile email to one industry.
  //
  // Plan limits (Free 1 / Professional 5 / Business unlimited) are NOT
  // enforced yet — this is still a demo. When plans ship, the maxIndustries
  // check goes right here, before the POST below.
  const subscribe = async (industry) => {
    const clean = String(industry || '').trim();
    if (!profileIndustries().includes(clean)) throw new Error('Unknown industry.');
    const email = profileEmail();
    if (!window.LariatProfile || typeof window.LariatProfile.isEmailFinalized !== 'function' || !window.LariatProfile.isEmailFinalized()) {
      const error = new Error('Please finalize your email with the code before attempting to save a bill or subscribe to an industry');
      error.code = 'email_not_finalized';
      throw error;
    }
    if (isSubscribed(clean)) return { ok: true, alreadySubscribed: true, industry: clean };
    const data = await api('/api/subscriptions/subscribe', { email, industry: clean });
    const subscriptions = getSubscriptions().filter((subscription) => !matchesBadge(subscription, clean, email));
    subscriptions.push({ email, industry: clean, verifiedAt: new Date().toISOString() });
    writeBadges(subscriptions);
    return data;
  };

  // Unsubscribes the profile email from one industry. Always allowed —
  // opting out never requires a finalized email.
  const unsubscribe = async (industry) => {
    const clean = String(industry || '').trim();
    if (!clean) throw new Error('Unknown industry.');
    const email = profileEmail();
    const data = await api('/api/subscriptions/unsubscribe', { email, industry: clean });
    const subscriptions = getSubscriptions().filter((subscription) => {
      if (subscription.industry !== clean) return true;
      return email ? (subscription.email || '').toLowerCase() !== email.toLowerCase() : false;
    });
    writeBadges(subscriptions);
    return data;
  };

  // Mirrors the profile's saved bills to the backend so the daily notification
  // digest can watch them for updates. Fire-and-forget (never throws, never
  // toasts) and debounced so a burst of save toggles becomes one POST.
  // Requires a finalized profile email — same gate as subscribing.
  let savesSyncTimer = null;
  const syncSaves = () => {
    if (API_BASE === null) return;
    if (!window.LariatProfile || typeof window.LariatProfile.isEmailFinalized !== 'function'
      || !window.LariatProfile.isEmailFinalized()) return;
    const email = profileEmail();
    const billIds = (window.LariatProfile.get().bookmarkedBills || []).slice(0, 200);
    clearTimeout(savesSyncTimer);
    savesSyncTimer = setTimeout(() => {
      api('/api/notifications/saves', { email, billIds }).catch(() => {
        // Best-effort: a failed sync only delays update alerts; saves keep
        // working locally either way.
      });
    }, 1500);
  };

  window.LariatSubscriptions = {
    selectPlan,
    getSelectedPlan,
    getSubscriptions,
    adoptEmail,
    isSubscribed,
    subscribe,
    unsubscribe,
    syncSaves,
    post: api,
  };
})();
