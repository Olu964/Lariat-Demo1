(() => {
  const toast = document.querySelector('.toast');
  const modal = document.querySelector('#bill-modal');
  const modalTitle = document.querySelector('#bill-modal-title');
  const modalBody = document.querySelector('#bill-modal-body');
  let toastTimer;
  let lastFocusedElement;
  let allBills = [];
  const notesStorageKey = 'lariat-bill-notes-v1';
  const datasetUpdatedOn = document.querySelector('meta[name="lariat-data-updated"]')?.content || 'Local snapshot';
  document.querySelectorAll('[data-dataset-freshness]').forEach((element) => {
    element.textContent = `✦ Published dataset: ${datasetUpdatedOn}. Verify current status with official Texas legislative sources; not legal advice.`;
  });
  const sessionName = document.querySelector('meta[name="lariat-session-name"]')?.content || 'Next Texas regular session';
  const sessionStartDate = new Date(document.querySelector('meta[name="lariat-session-start"]')?.content || '');
  const sessionCountdown = document.querySelector('[data-stat="days-to-session"]');
  const sessionDetail = document.querySelector('[data-session-detail]');

  const showToast = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
  };

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.querySelectorAll('[data-action="scroll-topics"]').forEach((button) => {
    button.addEventListener('click', () => document.querySelector('#bill-list')?.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' }));
  });

  document.querySelectorAll('[data-action="reset-subscriptions"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (typeof window.LariatSubscriptions !== 'undefined' && typeof window.LariatSubscriptions.reset === 'function') {
        window.LariatSubscriptions.reset();
      }
    });
  });

  document.querySelectorAll('.avatar-button').forEach((button) => {
    button.addEventListener('click', () => showToast('Account controls are intentionally disabled in this prototype.'));
  });

  const safe = (value) => String(value ?? 'Not provided');
  const escapeHtml = (value) => safe(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));

  // The curated set of industries Lariat tracks. Every option stays in the
  // dropdown even when the current dataset has no bills for it — empty
  // industries show a "no bills recently passed" message.
  const ALL_INDUSTRIES = [
    'Energy & Utilities',
    'Government & Municipal Operations',
    'Emergency & Public Safety',
    'Real Estate & Land Use',
    'Insurance & Financial Services',
  ];

  const impactClass = (level) => {
    const normalized = safe(level).toLowerCase();
    if (normalized === 'high') return 'high';
    if (normalized === 'moderate') return 'moderate';
    return 'low';
  };

  const billStatus = (bill) => {
    const explicitStatus = safe(bill.status || bill.legislative_status).trim().toLowerCase();
    const actionText = [bill.changes, bill.suggested_action].map(safe).join(' ').toLowerCase();
    const summaryText = safe(bill.summary).toLowerCase();
    const deadPattern = /\b(died|dead|failed|did not pass|not passed|bill filed|without house action|replaced)\b/;
    const deadSummaryPattern = /\b(ultimately stalled|did not receive final senate approval|never advanced past introduction|received no further legislative action|did not advance beyond|did not pass this session)\b/;
    const alivePattern = /\b(was passed|signed into law|enacted|reported enrolled|adopted|operative version)\b/;

    if (/^(dead|failed|did not pass|died|replaced)$/.test(explicitStatus)) return 'dead';
    if (/^(alive|active|pending|passed|signed|enacted|adopted)$/.test(explicitStatus)) return 'alive';
    if (deadPattern.test(actionText) || deadSummaryPattern.test(summaryText)) return 'dead';
    if (alivePattern.test(summaryText)) return 'alive';
    return 'alive';
  };

  const statusBadge = (bill) => {
    const status = billStatus(bill);
    return `<span class="status-badge ${status}"><span class="badge-dot"></span>${status === 'dead' ? 'Dead' : 'Alive'}</span>`;
  };

  const centralTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  });
  const centralOffsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', timeZoneName: 'longOffset',
  });

  const centralTimeParts = (date = new Date()) => Object.fromEntries(
    centralTimeFormatter.formatToParts(date).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]),
  );

  const centralOffsetMinutes = (date = new Date()) => {
    const timeZoneName = centralOffsetFormatter.formatToParts(date).find(({ type }) => type === 'timeZoneName')?.value || 'GMT';
    const match = timeZoneName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!match) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
    return match[1] === '+' ? minutes : -minutes;
  };

  const nextCentralMidnightDelay = () => {
    const now = new Date();
    const { year, month, day } = centralTimeParts(now);
    const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
    const nextMidnightGuess = new Date(Date.UTC(nextDate.getUTCFullYear(), nextDate.getUTCMonth(), nextDate.getUTCDate()));
    const nextMidnightUtc = nextMidnightGuess.getTime() - centralOffsetMinutes(nextMidnightGuess) * 60000;
    return Math.max(1000, nextMidnightUtc - now.getTime() + 1000);
  };

  const updateSessionCountdown = () => {
    if (!sessionCountdown) return;
    if (Number.isNaN(sessionStartDate.getTime())) {
      sessionCountdown.textContent = '—';
      if (sessionDetail) sessionDetail.textContent = 'Session date unavailable';
      return;
    }
    const now = new Date();
    const { year, month, day } = centralTimeParts(now);
    const centralToday = Date.UTC(year, month - 1, day);
    const targetParts = centralTimeParts(sessionStartDate);
    const target = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day);
    const days = Math.max(0, Math.ceil((target - centralToday) / 86400000));
    sessionCountdown.textContent = days;
    if (sessionDetail) {
      const formattedDate = sessionStartDate.toLocaleDateString('en-US', {
        timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
      });
      sessionDetail.textContent = `${sessionName} begins ${formattedDate} · Central time`;
    }
  };

  const scheduleSessionCountdown = () => {
    updateSessionCountdown();
    const tick = () => {
      updateSessionCountdown();
      window.setTimeout(tick, nextCentralMidnightDelay());
    };
    window.setTimeout(tick, nextCentralMidnightDelay());
  };

  const displayIndustry = (value) => {
    const industry = safe(value).trim();
    return !industry || industry === 'N/A' ? 'General Bill' : industry;
  };
  const displaySpecificIndustry = (value, fallbackIndustry) => {
    const specificIndustry = safe(value).trim();
    return !specificIndustry || specificIndustry === 'N/A'
      ? displayIndustry(fallbackIndustry)
      : specificIndustry;
  };
  const formatLabel = (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  const formatValue = (value) => {
    if (value === null || value === undefined || value === '') return 'Not provided';
    let formatted;
    try {
      formatted = typeof value === 'object' ? JSON.stringify(value) : String(value);
    } catch (error) {
      formatted = 'Not provided';
    }
    return formatted.length > 4000 ? `${formatted.slice(0, 4000)}…` : formatted;
  };
  const formatUpdatedOn = (bill) => {
    const rawDate = bill.updated_at || bill.updatedOn || bill.last_updated || bill.generated_at;
    if (!rawDate) return datasetUpdatedOn;
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) return safe(rawDate);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const billNoteKey = (bill) => {
    const sourceId = safe(bill.id).trim();
    if (sourceId && sourceId !== 'Not provided') return `id::${sourceId}`;
    return `${safe(bill.identifier).trim() || 'bill'}::${safe(bill.title).trim() || 'untitled'}`;
  };
  const readBillNotes = () => {
    try {
      const storedNotes = JSON.parse(localStorage.getItem(notesStorageKey) || '{}');
      return storedNotes && typeof storedNotes === 'object' && !Array.isArray(storedNotes) ? storedNotes : {};
    } catch (error) {
      return {};
    }
  };
  const saveBillNote = (bill, note) => {
    try {
      const notes = readBillNotes();
      const key = billNoteKey(bill);
      if (note.trim()) notes[key] = note;
      else delete notes[key];
      localStorage.setItem(notesStorageKey, JSON.stringify(notes));
      return true;
    } catch (error) {
      return false;
    }
  };

  const openBillModal = (bill, trigger) => {
    if (!modal || !modalTitle || !modalBody) return;
    lastFocusedElement = trigger;
    const identifier = safe(bill.identifier).trim() || 'Bill';
    const title = safe(bill.title).trim() || 'Untitled bill';
    const level = safe(bill.impact_level).trim() || 'Not provided';
    const levelClass = impactClass(level);
    const updatedOn = formatUpdatedOn(bill);
    const savedNote = readBillNotes()[billNoteKey(bill)];

    modalTitle.textContent = 'Full bill summary';
    const configuredSourceUrl = typeof bill.source_url === 'string' && /^https:\/\/capitol\.texas\.gov\//i.test(bill.source_url)
      ? bill.source_url
      : 'https://capitol.texas.gov/';
    const detailFields = Object.entries(bill)
      .filter(([key]) => !['id', 'identifier', 'title', 'impact_level', 'industry', 'specific_industry', 'source_url', 'bill_text_source', 'bill_text_hash', 'summary_word_count', '__index', '__groupId'].includes(key))
      .slice(0, 30);
    modalBody.innerHTML = `
      <article class="modal-bill-card ${levelClass === 'high' ? 'high-impact' : ''}">
        <div class="bill-topline"><span class="bill-number">${escapeHtml(identifier)}</span><span class="bill-date">${escapeHtml(displaySpecificIndustry(bill.specific_industry, bill.industry))}</span></div>
        <div class="bill-heading"><h3>${escapeHtml(title)}</h3><div class="bill-badges">${statusBadge(bill)}<span class="impact-badge ${levelClass}"><span class="badge-dot"></span>${escapeHtml(level)} impact</span></div></div>
        <button class="updated-on-button" type="button" data-updated-on="${escapeHtml(updatedOn)}" aria-label="Summary updated on ${escapeHtml(updatedOn)}" title="This summary's dataset refresh date"><span aria-hidden="true">↻</span> Updated on · ${escapeHtml(updatedOn)}</button>
        <div class="modal-fields">
          ${detailFields.map(([key, value]) => `
            <section class="modal-field">
              <h4>${escapeHtml(formatLabel(key))}</h4>
              <p>${escapeHtml(formatValue(value))}</p>
            </section>
          `).join('')}
        </div>
        <a class="bill-link modal-source-link" href="${escapeHtml(configuredSourceUrl)}" target="_blank" rel="noopener noreferrer">Verify with Texas Legislature <span aria-hidden="true">↗</span></a>
        <section class="bill-notes" aria-labelledby="bill-notes-title">
          <div class="bill-notes-heading">
            <div>
              <div class="modal-kicker">Your workspace</div>
              <h4 id="bill-notes-title">Notes on this bill</h4>
            </div>
            <span class="bill-notes-saved" data-note-status aria-live="polite">${savedNote ? 'Saved locally' : ''}</span>
          </div>
          <label class="visually-hidden" for="bill-note-input">Notes on this bill</label>
          <textarea id="bill-note-input" class="bill-note-input" rows="5" maxlength="5000" placeholder="Capture questions, follow-ups, or context for your team…" aria-describedby="bill-note-help bill-note-status">${escapeHtml(savedNote || '')}</textarea>
          <div class="bill-notes-footer">
            <p id="bill-note-help" class="bill-notes-help">Saved in this browser and available when you reopen this bill.</p>
            <button class="note-save-button" type="button" data-save-note title="Save this note to your browser">Save note <span aria-hidden="true">↗</span></button>
          </div>
          <span id="bill-note-status" class="visually-hidden" data-note-announcement aria-live="polite"></span>
        </section>
      </article>
    `;

    modalBody.querySelector('[data-updated-on]')?.addEventListener('click', (event) => {
      showToast(`This local summary was last refreshed on ${event.currentTarget.dataset.updatedOn}.`);
    });
    modalBody.querySelector('[data-save-note]')?.addEventListener('click', () => {
      const noteInput = modalBody.querySelector('[data-save-note]')?.closest('.bill-notes')?.querySelector('.bill-note-input');
      const noteStatus = modalBody.querySelector('[data-note-status]');
      const noteAnnouncement = modalBody.querySelector('[data-note-announcement]');
      if (!noteInput) return;
      const saved = saveBillNote(bill, noteInput.value);
      const message = saved
        ? (noteInput.value.trim() ? 'Saved locally' : 'Note cleared')
        : 'Could not save note';
      if (noteStatus) noteStatus.textContent = message;
      if (noteAnnouncement) noteAnnouncement.textContent = saved
        ? (noteInput.value.trim() ? 'Your note was saved in this browser.' : 'Your note was cleared from this browser.')
        : 'Your note could not be saved. Browser storage may be blocked or full.';
      if (saved) showToast(message === 'Note cleared' ? 'Note cleared.' : 'Note saved in this browser.');
      else showToast('Could not save note. Check browser storage settings.');
    });

    if (typeof modal.showModal === 'function') {
      if (!modal.open) modal.showModal();
    } else {
      modal.setAttribute('open', '');
      modal.classList.add('is-open');
      modal.setAttribute('aria-modal', 'true');
    }
  };

  const closeBillModal = () => {
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

  document.querySelector('#modal-close')?.addEventListener('click', closeBillModal);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeBillModal();
  });
  modal?.addEventListener('close', () => lastFocusedElement?.focus());

  const subscribeRowMarkup = (industry) => {
    const subscribed = typeof window.LariatSubscriptions !== 'undefined' && window.LariatSubscriptions.isSubscribed(industry);
    if (subscribed) {
      return `<div class="subscribe-row subscribed"><span class="subscribe-check" aria-hidden="true">✓</span> Subscribed to ${escapeHtml(industry)} email updates<button class="subscribe-button link subscribe-unsubscribe" type="button" data-unsubscribe-industry="${escapeHtml(industry)}" title="Stop ${escapeHtml(industry)} email updates">Unsubscribe</button></div>`;
    }
    return `<div class="subscribe-row"><button class="subscribe-button" type="button" data-subscribe-industry="${escapeHtml(industry)}" title="Get email updates when ${escapeHtml(industry)} bills move"><span class="subscribe-bell" aria-hidden="true"></span>Subscribe to ${escapeHtml(industry)} email updates</button></div>`;
  };

  const renderBills = (bills, viewTitle = 'All industries', showSpecificIndustry = false) => {
    const list = document.querySelector('#bill-list');
    if (!list) return;
    if (!bills.length) {
      // A specific industry with no recent bills gets a friendly empty state;
      // the all-industries view is only empty when the source file itself is.
      list.innerHTML = showSpecificIndustry
        ? `<div class="industry-empty-state"><span class="empty-state-icon" aria-hidden="true">✦</span><h3>No recent bills in ${escapeHtml(viewTitle)}</h3><p>No bills have recently been passed concerning this industry.</p></div>`
        : '<article class="bill-card"><div class="bill-heading"><h3>No bill summaries found</h3></div><p class="bill-summary-loading">The source file did not contain any bill records.</p></article>';
      return;
    }

    const industryBills = bills;
    const industryName = showSpecificIndustry ? viewTitle : '';
    list.innerHTML = `
      <section class="industry-group" aria-labelledby="selected-industry-title">
        <div class="industry-group-heading">
          <div>
            <div class="section-kicker">${showSpecificIndustry ? 'Specific industries in this category' : 'All impacted industries'}</div>
            <h3 id="selected-industry-title" class="industry-group-title">${escapeHtml(viewTitle)}</h3>
          </div>
          <span class="industry-count">${industryBills.length} ${industryBills.length === 1 ? 'bill' : 'bills'}</span>
        </div>
        ${industryName ? subscribeRowMarkup(industryName) : ''}
        <div class="industry-bills">
          ${industryBills.map((bill) => {
            const levelClass = impactClass(bill.impact_level);
            const identifier = escapeHtml(bill.identifier || 'Unknown ID');
            const title = escapeHtml(bill.title || 'Untitled bill');
            const cardIndustry = showSpecificIndustry
              ? displaySpecificIndustry(bill.specific_industry, bill.industry)
              : displayIndustry(bill.industry);
            return `
              <button class="bill-card bill-card-button ${levelClass === 'high' ? 'high-impact' : ''}" type="button" data-bill-index="${bill.__index}" aria-label="Open full summary for ${identifier}" title="Open the full summary for ${identifier}">
                <div class="bill-topline"><span class="bill-number">${identifier}</span><span class="bill-date">${escapeHtml(cardIndustry)}</span></div>
                <div class="bill-heading"><h3>${title}</h3><div class="bill-badges">${statusBadge(bill)}<span class="impact-badge ${levelClass}"><span class="badge-dot"></span>${escapeHtml(safe(bill.impact_level))} impact</span></div></div>
                <span class="bill-card-action">Click to view full summary <span aria-hidden="true">↗</span></span>
              </button>
            `;
          }).join('')}
        </div>
      </section>
    `;

    list.querySelectorAll('[data-bill-index]').forEach((row) => {
      row.addEventListener('click', () => openBillModal(allBills[Number(row.dataset.billIndex)], row));
    });
    list.querySelectorAll('[data-subscribe-industry]').forEach((button) => {
      button.addEventListener('click', () => {
        if (typeof window.LariatSubscriptions !== 'undefined') {
          window.LariatSubscriptions.open(button.dataset.subscribeIndustry);
        }
      });
    });
    list.querySelectorAll('[data-unsubscribe-industry]').forEach((button) => {
      button.addEventListener('click', () => {
        if (typeof window.LariatSubscriptions !== 'undefined' && typeof window.LariatSubscriptions.unsubscribe === 'function') {
          window.LariatSubscriptions.unsubscribe(button.dataset.unsubscribeIndustry);
        }
      });
    });
  };

  const loadBills = async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const deepLinkIndustry = (urlParams.get('industry') || '').trim();
    const deepLinkImpact = (urlParams.get('impact') || '').trim().toLowerCase();
    try {
      const response = await fetch('texas_bill_summaries.json', { cache: 'default' });
      if (!response.ok) throw new Error(`Could not load bill data (${response.status})`);
      const bills = await response.json();
      if (!Array.isArray(bills)) throw new Error('Bill data must be a JSON array');
      allBills = bills.filter((bill) => bill && typeof bill === 'object').map((bill, index) => ({
        ...bill,
        __index: index,
      }));
      const highCount = allBills.filter((bill) => safe(bill.impact_level).toLowerCase() === 'high').length;
      document.querySelector('[data-stat="total"]').textContent = allBills.length;
      document.querySelector('[data-stat="high"]').textContent = highCount;
      updateSessionCountdown();

      const industrySelect = document.querySelector('#industry-select');
      if (!industrySelect) throw new Error('The impacted industry selector is missing');
      industrySelect.innerHTML = [
        '<option value="__all__" selected>All industries</option>',
        ...ALL_INDUSTRIES.map((industry) => `<option value="${escapeHtml(industry)}">${escapeHtml(industry)}</option>`),
      ].join('');
      industrySelect.disabled = false;
      if (deepLinkIndustry) {
        industrySelect.value = [...industrySelect.options].some((option) => option.value === deepLinkIndustry)
          ? deepLinkIndustry
          : industrySelect.value;
      }

      const list = document.querySelector('#bill-list');
      const updateIndustryView = () => {
        const selectedIndustry = industrySelect.value;
        const showAllIndustries = selectedIndustry === '__all__';
        let selectedBills = showAllIndustries
          ? allBills
          : allBills.filter((bill) => displayIndustry(bill.industry) === selectedIndustry);
        let viewTitle = showAllIndustries ? 'All industries' : selectedIndustry;
        if (deepLinkImpact && deepLinkImpact === 'high') {
          const highImpactBills = selectedBills.filter((bill) => safe(bill.impact_level).toLowerCase() === 'high');
          if (highImpactBills.length > 0) {
            selectedBills = highImpactBills;
            viewTitle = `${viewTitle} · High impact`;
          }
        }
        document.querySelector('[data-stat="chip"]').textContent = `${selectedBills.length} ${selectedBills.length === 1 ? 'bill' : 'bills'}`;
        renderBills(selectedBills, viewTitle, !showAllIndustries);
      };
      industrySelect.addEventListener('change', updateIndustryView);
      document.addEventListener('lariat:subscriptions-changed', updateIndustryView);
      updateIndustryView();
    } catch (error) {
      if (sessionCountdown) sessionCountdown.textContent = '—';
      document.querySelector('[data-stat="chip"]').textContent = 'Unavailable';
      const industrySelect = document.querySelector('#industry-select');
      if (industrySelect) {
        industrySelect.innerHTML = '<option value="">Could not load industries</option>';
        industrySelect.disabled = true;
      }
      const list = document.querySelector('#bill-list');
      if (list) list.innerHTML = `<article class="bill-card error-card"><div class="bill-heading"><h3>Could not load the real bill data</h3></div><p class="bill-summary-loading">${escapeHtml(error.message)}. Serve this folder from a local web server rather than opening the HTML file directly.</p></article>`;
    }
  };

  const canvas = document.createElement('canvas');
  canvas.className = 'ambient-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const context = canvas.getContext('2d');
  const reduceMotion = prefersReducedMotion;
  const points = Array.from({ length: 18 }, (_, index) => ({
    x: Math.random(), y: Math.random(), radius: 1 + Math.random() * 1.5,
    speed: 0.00008 + Math.random() * 0.00013, phase: index * 0.8,
  }));

  if (context && !reduceMotion) {
    let animationFrame;
    let isVisible = document.visibilityState !== 'hidden';    const resize = () => {
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
        context.beginPath(); context.arc(x, y, point.radius, 0, Math.PI * 2);
        context.fillStyle = 'rgba(39, 131, 187, .12)'; context.fill();
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
  scheduleSessionCountdown();
  loadBills();
})();
