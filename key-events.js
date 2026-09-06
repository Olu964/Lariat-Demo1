(() => {
  // Key dates for the 90th Texas Legislature regular session.
  // Based on the official Texas legislative calendar.
  const EVENTS = [
    { date: 'Nov 3, 2026', event: 'General Election Day', why: 'Determines who actually sits in the 90th Legislature and which committee chairs run point on the bills.' },
    { date: 'November 9, 2026', event: 'Prefiling opens', why: 'First day new bills can officially be filed for the 90th session.' },
    { date: 'January 12, 2027', event: '90th Legislature convenes', why: 'Second Tuesday in January, fixed by the Texas Constitution.' },
    { date: '~February 10, 2027', event: 'Committees may begin voting on non-emergency bills', why: 'First real point bills can start moving, not just sitting filed.' },
    { date: '~March 12, 2027', event: 'Bill filing deadline', why: 'After this, only emergency or local bills can be introduced. This is the wall.' },
    { date: 'May 14, 2027', event: "House's last day for House bills, 3rd reading", why: 'House-origin bills not through by now are effectively dead.' },
    { date: 'May 26, 2027', event: "House's last day for Senate bills, 3rd reading", why: 'Final chance for Senate bills to clear the House.' },
    { date: 'May 30, 2027', event: 'Last day for conference committee reports', why: 'Final procedural off-ramp before adjournment.' },
    { date: 'May 31, 2027', event: 'Sine Die', why: 'Session adjourns. The 140-day constitutional limit, hard stop.' },
    { date: 'June 20, 2027', event: "Governor's sign/veto deadline", why: 'For bills passed in the final 10 days of the session.' },
    { date: 'June-August 2027', event: 'Interim charges issued', why: 'Committees get assigned what to study before the next session.' },
    { date: 'September 1, 2027', event: 'Effective date for most new laws', why: 'Default effective date unless a bill says otherwise.' },
  ];

  const modal = document.querySelector('#event-modal');
  const modalTitle = document.querySelector('#event-modal-title');
  const modalBody = document.querySelector('#event-modal-body');
  const toast = document.querySelector('.toast');
  let lastFocusedElement;
  let toastTimer;

  const showToast = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
  };

  document.querySelectorAll('.avatar-button').forEach((button) => {
    button.addEventListener('click', () => showToast('Account controls are intentionally disabled in this prototype.'));
  });

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));

  const renderEvents = () => {
    const spinner = document.querySelector('#key-events-spinner');
    if (!spinner) return;
    // 12 events, one every 30 degrees around the ring. The angle is set
    // through the CSSOM rather than a style attribute: the page CSP allows
    // script-set styles but blocks inline style attributes.
    spinner.insertAdjacentHTML('beforeend', EVENTS.map((event, index) => `
      <button class="key-event-card" type="button" data-event-index="${index}" aria-label="Open details for ${escapeHtml(event.event)}" title="Open details for ${escapeHtml(event.event)}">
        <span class="key-event-card-inner">
          <span class="key-event-date">${escapeHtml(event.date)}</span>
          <span class="key-event-name">${escapeHtml(event.event)}</span>
        </span>
      </button>
    `).join(''));
    spinner.querySelectorAll('[data-event-index]').forEach((card) => {
      const index = Number(card.dataset.eventIndex);
      card.style.setProperty('--angle', `${index * 30}deg`);
      card.addEventListener('click', () => openEventModal(EVENTS[index], card));
    });
  };

  const openEventModal = (event, trigger) => {
    if (!modal || !modalTitle || !modalBody) return;
    lastFocusedElement = trigger;
    modalTitle.textContent = event.event;
    modalBody.innerHTML = `
      <article class="modal-bill-card">
        <div class="bill-topline"><span class="bill-number">Key event</span><span class="bill-date">90th Legislature</span></div>
        <div class="modal-fields">
          <section class="modal-field"><h4>When</h4><p>${escapeHtml(event.date)}</p></section>
          <section class="modal-field"><h4>Why it matters</h4><p>${escapeHtml(event.why)}</p></section>
        </div>
        <p class="modal-calendar-note">Part of the official Texas legislative calendar. Confirm exact dates with official state sources.</p>
      </article>
    `;
    if (typeof modal.showModal === 'function') {
      if (!modal.open) modal.showModal();
    } else {
      modal.setAttribute('open', '');
      modal.classList.add('is-open');
      modal.setAttribute('aria-modal', 'true');
    }
  };

  const closeEventModal = () => {
    if (!modal) return;
    if (typeof modal.close === 'function' && modal.open) {
      modal.close();
    } else {
      modal.removeAttribute('open');
      modal.classList.remove('is-open');
      modal.removeAttribute('aria-modal');
    }
    lastFocusedElement?.focus();
  };

  document.querySelector('#event-modal-close')?.addEventListener('click', closeEventModal);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeEventModal();
  });
  modal?.addEventListener('close', () => lastFocusedElement?.focus());

  renderEvents();
})();