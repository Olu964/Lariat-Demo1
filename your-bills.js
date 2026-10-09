/* Your Saves page — renders bills saved in the device-local profile plus the
 * industry subscription list. Reads window.LariatProfile.bookmarkedBills and
 * enriches each ID with title/status from texas_bill_summaries.json when
 * available. Industry rows call window.LariatSubscriptions.subscribe /
 * unsubscribe, which POST to the backend and mirror state locally.
 * External file so CSP script-src 'self' allows it.
 */
(() => {
  'use strict';

  const list = document.querySelector('#your-bills-list');
  const count = document.querySelector('#your-bills-count');
  const hint = document.querySelector('#your-bills-hint');
  const industriesList = document.querySelector('#industries-list');
  const industriesCount = document.querySelector('#industries-count');
  const industriesHint = document.querySelector('#industries-hint');
  const toast = document.querySelector('.toast');

  if (!list) return;

  const escapeHtml = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[c]));

  const showToast = (msg) => {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('visible');
    // Shares the site-wide timer key so the profile.js email gate toast and
    // this page's toasts never hide each other early.
    clearTimeout(window.__lariatToastTimer);
    window.__lariatToastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
  };

  const normId = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();

  let billIndex = new Map();

  async function loadBillIndex() {
    try {
      const response = await fetch('texas_bill_summaries.json', { cache: 'default' });
      if (!response.ok) return;
      const bills = await response.json();
      if (!Array.isArray(bills)) return;
      for (const bill of bills) {
        if (!bill || typeof bill.identifier !== 'string') continue;
        billIndex.set(normId(bill.identifier), bill);
      }
    } catch (error) { /* offline or file:// — show IDs without enrichment */ }
  }

  function savedIds() {
    if (!window.LariatProfile) return [];
    return window.LariatProfile.get().bookmarkedBills || [];
  }

  function paint() {
    const ids = savedIds();
    if (count) count.textContent = String(ids.length);
    if (!ids.length) {
      if (hint) hint.textContent = 'No saved bills yet. Browse the feed and save the ones that matter to you.';
      list.innerHTML = '<li class="profile-empty">Nothing here yet — your saved bills will appear on this page.</li>';
      return;
    }
    if (hint) hint.textContent = 'Saved only in this browser. Remove any bill you no longer want to track.';
    list.innerHTML = ids.map((id) => {
      const bill = billIndex.get(normId(id));
      const title = bill && bill.title ? bill.title : 'Bill details load from the feed dataset';
      const meta = bill
        ? [bill.impact_level ? `${bill.impact_level} impact` : '', bill.status || bill.latest_action_description || ''].filter(Boolean).join(' · ')
        : '';
      return `<li><span><strong>${escapeHtml(id)}</strong> — ${escapeHtml(String(title).slice(0, 120))}${meta ? ` <em>(${escapeHtml(meta)})</em>` : ''}</span><button type="button" data-unsave="${escapeHtml(id)}" aria-label="Remove ${escapeHtml(id)}">Remove</button></li>`;
    }).join('');
  }

  list.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-unsave]');
    if (!btn || !window.LariatProfile) return;
    window.LariatProfile.toggleBookmark(btn.dataset.unsave);
    showToast(`Removed ${btn.dataset.unsave}.`);
    paint();
    if (window.LariatSubscriptions && typeof window.LariatSubscriptions.syncSaves === 'function') {
      window.LariatSubscriptions.syncSaves();
    }
  });

  function finalizedEmail() {
    if (!window.LariatProfile || typeof window.LariatProfile.isEmailFinalized !== 'function') return '';
    return window.LariatProfile.isEmailFinalized() ? window.LariatProfile.get().email : '';
  }

  function paintIndustries() {
    if (!industriesList) return;
    const industries = window.LariatProfile && window.LariatProfile.ALL_INDUSTRIES
      ? window.LariatProfile.ALL_INDUSTRIES
      : [];
    const subs = window.LariatSubscriptions;
    const canCheck = subs && typeof subs.isSubscribed === 'function';
    let subscribedTotal = 0;
    industriesList.innerHTML = industries.map((industry) => {
      const subscribed = Boolean(canCheck && subs.isSubscribed(industry));
      if (subscribed) subscribedTotal += 1;
      const label = subscribed ? `Unsubscribe from ${industry}` : `Subscribe to ${industry}`;
      const button = `<button type="button" class="subscribe-button${subscribed ? ' unsubscribe' : ''}" data-subscribe-industry="${escapeHtml(industry)}" aria-label="${escapeHtml(label)}">${subscribed ? 'Unsubscribe' : 'Subscribe'}</button>`;
      const actions = subscribed
        ? `<span class="industry-actions"><span class="subscribed-note">Currently Subscribed</span>${button}</span>`
        : `<span class="industry-actions">${button}</span>`;
      return `<li><span>${escapeHtml(industry)}</span>${actions}</li>`;
    }).join('');
    if (industriesCount) industriesCount.textContent = String(subscribedTotal);
    if (industriesHint) {
      const email = finalizedEmail();
      industriesHint.textContent = email
        ? `A confirmation email goes to ${email} each time you subscribe, and a notice when you unsubscribe.`
        : 'Finalize your email from your profile before subscribing — confirmations are sent there.';
    }
  }

  if (industriesList) {
    industriesList.addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-subscribe-industry]');
      if (!btn) return;
      if (!window.LariatProfile || !window.LariatSubscriptions
        || typeof window.LariatSubscriptions.subscribe !== 'function') {
        showToast('Industry subscriptions are unavailable in this browser.');
        return;
      }
      // Email gate: exact toast from profile.js when the code was never entered.
      if (typeof window.LariatProfile.requireVerifiedEmail === 'function' && !window.LariatProfile.requireVerifiedEmail()) return;
      const industry = btn.dataset.subscribeIndustry;
      const wasSubscribed = typeof window.LariatSubscriptions.isSubscribed === 'function'
        && window.LariatSubscriptions.isSubscribed(industry);
      btn.disabled = true;
      try {
        if (wasSubscribed) {
          await window.LariatSubscriptions.unsubscribe(industry);
          showToast(`Unsubscribed from ${industry}. Notice sent to ${window.LariatProfile.get().email}.`);
        } else {
          await window.LariatSubscriptions.subscribe(industry);
          showToast(`Subscribed to ${industry}. Confirmation sent to ${window.LariatProfile.get().email}.`);
        }
      } catch (error) {
        showToast(error && error.message ? error.message : 'Something went wrong. Please try again.');
      } finally {
        btn.disabled = false;
        paintIndustries();
      }
    });
  }

  document.addEventListener('lariat:profile-changed', () => {
    paint();
    paintIndustries();
    // The email may have just been finalized — mirror saved bills to the
    // notification digest backend as soon as it qualifies.
    if (window.LariatSubscriptions && typeof window.LariatSubscriptions.syncSaves === 'function') {
      window.LariatSubscriptions.syncSaves();
    }
  });
  document.addEventListener('lariat:subscriptions-changed', paintIndustries);

  loadBillIndex().finally(paint);
  paint();
  paintIndustries();
  // Mirror saves on load too (no-op until the profile email is finalized).
  if (window.LariatSubscriptions && typeof window.LariatSubscriptions.syncSaves === 'function') {
    window.LariatSubscriptions.syncSaves();
  }
})();
