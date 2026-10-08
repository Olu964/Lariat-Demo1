/* Your Bills page — renders bills saved in the device-local profile.
 * Saving itself happens in the bill feed (not implemented yet), so this page
 * is empty until then. Reads window.LariatProfile.bookmarkedBills and enriches
 * each ID with title/status from texas_bill_summaries.json when available.
 * External file so CSP script-src 'self' allows it.
 */
(() => {
  'use strict';

  const list = document.querySelector('#your-bills-list');
  const count = document.querySelector('#your-bills-count');
  const hint = document.querySelector('#your-bills-hint');
  const toast = document.querySelector('.toast');

  if (!list) return;

  const escapeHtml = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[c]));

  const showToast = (msg) => {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(window.__yourBillsToast);
    window.__yourBillsToast = setTimeout(() => toast.classList.remove('visible'), 3200);
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
  });

  document.addEventListener('lariat:profile-changed', paint);

  loadBillIndex().finally(paint);
  paint();
})();
