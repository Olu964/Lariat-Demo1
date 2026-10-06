(() => {
  const form = document.querySelector('#legislator-form');
  const input = document.querySelector('#address-input');
  const status = document.querySelector('#lookup-status');
  const results = document.querySelector('#legislator-results');
  const list = document.querySelector('[data-legislator-list]');
  const addressLabel = document.querySelector('[data-lookup-address]');
  const modal = document.querySelector('#legislator-modal');
  const modalBody = document.querySelector('#legislator-modal-body');
  const modalTitle = document.querySelector('#legislator-modal-title');
  const apiBase = typeof window.LARIAT_API_BASE === 'string'
    ? window.LARIAT_API_BASE.trim().replace(/\/+$/, '')
    : '';
  let legislators = [];
  let lastFocusedElement = null;

  // Shared with the bill feed (real-script.js). A legislator only becomes
  // "yours" when the visitor explicitly clicks "Make them your legislator"
  // on that person's card — a lookup alone saves nothing. One entry per
  // chamber; picking replaces that chamber's entry, never duplicates.
  // A new successful lookup clears prior picks, since the delegation for a
  // different address may be different people.
  const MY_LEGISLATORS_STORAGE_KEY = 'lariat-my-legislators-v1';

  const truncateStoredString = (value, max = 200) => {
    const text = typeof value === 'string' ? value : String(value ?? '');
    return text.length > max ? text.slice(0, max) : text;
  };

  const sanitizeStoredPerson = (person) => ({
    personId: truncateStoredString(person?.personId || '', 120),
    name: truncateStoredString(person?.name || '', 120),
    chamber: truncateStoredString(person?.chamber || '', 20),
    party: truncateStoredString(person?.party || '', 80),
    district: truncateStoredString(person?.district ?? '', 20),
    photoUrl: truncateStoredString(person?.photoUrl || '', 500),
    votingHistoryStatus: truncateStoredString(person?.votingHistoryStatus || '', 20),
    votingHistory: (Array.isArray(person?.votingHistory) ? person.votingHistory : []).slice(0, 25).map((record) => ({
      billId: truncateStoredString(record?.billId || record?.id || '', 120),
      identifier: truncateStoredString(record?.identifier || '', 40),
      session: truncateStoredString(record?.session ?? '', 40),
      vote: truncateStoredString(record?.vote || '', 40),
      voteStatus: truncateStoredString(record?.voteStatus || '', 20),
    })),
  });

  const readMyLegislatorsSnapshot = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(MY_LEGISLATORS_STORAGE_KEY) || 'null');
      const people = Array.isArray(parsed) ? parsed : parsed?.legislators;
      return Array.isArray(people) ? people : [];
    } catch (error) {
      return [];
    }
  };

  const saveMyLegislator = (person) => {
    try {
      const chamber = String(person?.chamber || '').toLowerCase();
      const next = readMyLegislatorsSnapshot().filter(
        (entry) => String(entry?.chamber || '').toLowerCase() !== chamber,
      );
      next.push({ ...sanitizeStoredPerson(person) });
      localStorage.setItem(MY_LEGISLATORS_STORAGE_KEY, JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        legislators: next.slice(0, 2),
      }));
      return true;
    } catch (error) {
      return false;
    }
  };

  const clearMyLegislators = () => {
    try {
      localStorage.removeItem(MY_LEGISLATORS_STORAGE_KEY);
    } catch (error) {
      // Storage blocked: nothing saved, so nothing to clear.
    }
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));

  // Error bodies can come from our backend, the static host, or an
  // intermediate proxy — and any of them may use a non-string `error`
  // shape. Only validated strings ever reach the UI, so a raw object can
  // never leak through as "[object Object]".
  const lookupFailureMessage = (response, payload) => {
    const body = payload && typeof payload === 'object' ? payload : null;
    if (body?.code === 'outside_texas') return 'That address is outside Texas. Enter a Texas address or ZIP code to find your state legislators.';
    if (body?.code === 'not_geocoded') return 'We couldn’t locate that address. Check the spelling and try again.';
    if (body?.code === 'no_match') return "We couldn't find a Texas legislator for that address. Double check it's a valid Texas address and try again.";
    if (body && typeof body.error === 'string' && body.error.trim()) return body.error;
    // No JSON body (or an unexpected shape) means something other than the
    // Lariat backend answered — on the static-only host the lookup API
    // doesn't exist, so say so plainly instead of showing platform internals.
    if (!body) return 'Legislator lookup is not available on this site right now. Please try again later.';
    return 'We could not complete that lookup. Please try again.';
  };

  const setStatus = (message, isError = false) => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', isError);
    status.classList.toggle('is-loading', !isError && Boolean(message));
  };

  const formatDate = (value) => {
    if (!value) return 'Date not listed';
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? escapeHtml(value) : new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    }).format(date);
  };

  // Used only for official bill-source links in the voting-history dialog.
  // Legislator contact links are intentionally not rendered.
  const linkMarkup = (url, label) => {
    if (!url) return '';
    return `<a class="legislator-source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} <span aria-hidden="true">↗</span></a>`;
  };

  const renderLegislator = (legislator, index) => {
    const photo = legislator.photoUrl
      ? `<img class="legislator-photo" src="${escapeHtml(legislator.photoUrl)}" alt="" loading="lazy">`
      : '<span class="legislator-photo legislator-photo-placeholder" aria-hidden="true">TX</span>';
    return `
      <article class="bill-card legislator-card">
        <button class="legislator-card-trigger" type="button" data-legislator-index="${index}" aria-label="View profile and voting history for ${escapeHtml(legislator.name)}">
          <span class="legislator-card-topline"><span class="bill-number">${escapeHtml(legislator.chamber)}</span><span class="legislator-district">District ${escapeHtml(legislator.district || 'not listed')}</span></span>
          <span class="legislator-identity">
            ${photo}
            <span><span class="legislator-name">${escapeHtml(legislator.name)}</span><span class="legislator-party">${escapeHtml(legislator.party || 'Party not listed')}</span></span>
          </span>
          <span class="legislator-card-action">Click to view full profile <span aria-hidden="true">↗</span></span>
        </button>
        <div class="legislator-card-picker">
          <button class="make-my-legislator-button" type="button" data-make-my-legislator="${index}" aria-pressed="false" aria-label="Make ${escapeHtml(legislator.name)} your legislator">Make them your legislator</button>
        </div>
      </article>
    `;
  };

  const asArray = (value) => (Array.isArray(value) ? value : []);

  const renderDistrictParty = (legislator) => {
    const district = legislator.district ? `District ${legislator.district}` : 'District not listed';
    const role = legislator.roleTitle ? `<span class="legislator-modal-role">${escapeHtml(legislator.roleTitle)}</span>` : '';
    return `
      <div class="legislator-modal-profile">
        <div class="legislator-modal-kicker">${escapeHtml(legislator.chamber || 'Legislator')} · ${escapeHtml(district)}</div>
        ${role}
        <dl class="legislator-facts">
          <div><dt>District</dt><dd>${escapeHtml(legislator.district || 'Not listed')}</dd></div>
          <div><dt>Party</dt><dd>${escapeHtml(legislator.party || 'Not listed')}</dd></div>
          <div><dt>Chamber</dt><dd>${escapeHtml(legislator.chamber || 'Not listed')}</dd></div>
        </dl>
      </div>`;
  };

  const renderCommittees = (legislator) => {
    const committees = asArray(legislator.committees);
    if (legislator.committeesStatus !== 'available' || !committees.length) {
      return `<section class="legislator-modal-section"><h3>Committees</h3><p class="legislator-missing">Committee assignments are not available from the current legislative data source. No assignment has been inferred.</p></section>`;
    }
    const sourceNote = legislator.committeesSource === 'official'
      ? `<p class="legislator-source-note">Committee assignments from the official Texas Legislature Online.</p>` : '';
    return `<section class="legislator-modal-section"><div class="legislator-modal-section-heading"><h3>Committees</h3><span>${committees.length} assignment${committees.length === 1 ? '' : 's'}</span></div><div class="vote-history-list">${committees.map((c) => `
      <article class="vote-history-row"><div><strong>${escapeHtml(c.name || 'Committee')}</strong><h4>${escapeHtml(c.role || 'Member')}${c.chamber ? ` · ${escapeHtml(c.chamber)}` : ''}</h4>${c.classification ? `<p>${escapeHtml(c.classification)}</p>` : ''}</div></article>`).join('')}</div>${sourceNote}</section>`;
  };

  const renderVotingHistory = (legislator) => {
    const records = Array.isArray(legislator.votingHistory) ? legislator.votingHistory : [];
    if (legislator.votingHistoryStatus !== 'available') {
      return `<section class="legislator-modal-section"><h3>Recent votes</h3><p class="legislator-missing">Voting history is not available from the current legislative data source. No vote has been inferred or filled in.</p></section>`;
    }
    if (!records.length) {
      return `<section class="legislator-modal-section"><h3>Recent votes</h3><p class="legislator-missing">No individual votes were recorded for the recent major bills checked.</p></section>`;
    }
    return `<section class="legislator-modal-section"><div class="legislator-modal-section-heading"><h3>Recent votes</h3><span>${records.length} bill${records.length === 1 ? '' : 's'}</span></div><div class="vote-history-list">${records.map((record) => {
      const voteClass = String(record.vote || '').toLowerCase().replace(/[^a-z]+/g, '-');
      const source = record.sourceUrl ? linkMarkup(record.sourceUrl, 'Verify source') : '';
      return `<article class="vote-history-row"><div><strong>${escapeHtml(record.identifier || 'Bill')}</strong><h4>${escapeHtml(record.title || 'Untitled bill')}</h4><p>${escapeHtml(formatDate(record.date))}${record.result ? ` · Result: ${escapeHtml(record.result)}` : ''}</p></div><div class="vote-history-result"><span class="vote-pill ${escapeHtml(voteClass)}">${escapeHtml(record.vote || 'Recorded')}</span>${source}</div></article>`;
    }).join('')}</div><p class="legislator-source-note">History is limited to major bills in the current Lariat snapshot and only shows a vote when Open States returned an individual voter record.</p></section>`;
  };

  const renderSponsoredBills = (legislator) => {
    const bills = asArray(legislator.sponsoredBills);
    if (legislator.sponsoredBillsStatus !== 'available' || !bills.length) {
      return `<section class="legislator-modal-section"><h3>Sponsored bills</h3><p class="legislator-missing">Sponsored bills are not available from the current legislative data source. No sponsorship has been inferred.</p></section>`;
    }
    return `<section class="legislator-modal-section"><div class="legislator-modal-section-heading"><h3>Sponsored bills</h3><span>${bills.length} bill${bills.length === 1 ? '' : 's'}</span></div><div class="vote-history-list">${bills.map((bill) => {
      const source = bill.sourceUrl ? linkMarkup(bill.sourceUrl, bill.source === 'official' ? 'Official record' : 'Open States record') : '';
      const meta = [bill.session ? `Session ${bill.session}` : '', bill.sponsorshipRole || (bill.primary === true ? 'Primary sponsor' : bill.primary === false ? 'Co-sponsor' : ''), bill.latestAction || ''].filter(Boolean).join(' · ');
      return `<article class="vote-history-row"><div><strong>${escapeHtml(bill.identifier || 'Bill')}</strong><h4>${escapeHtml(bill.title || 'Untitled bill')}</h4>${meta ? `<p>${escapeHtml(meta)}</p>` : ''}</div><div class="vote-history-result">${source}</div></article>`;
    }).join('')}</div><p class="legislator-source-note">${legislator.sponsoredBillsSource === 'official' ? 'Bills authored by this legislator according to the official Texas Legislature Online (89th Legislature regular session).' : 'Most recently updated Texas bills listing this legislator as a sponsor in Open States.'}</p></section>`;
  };

  const renderLeadership = (legislator) => {
    const roles = asArray(legislator.leadershipRoles);
    if (!roles.length) {
      const committeesKnown = legislator.committeesStatus === 'available';
      return `<section class="legislator-modal-section"><h3>Leadership roles</h3><p class="legislator-missing">${committeesKnown ? 'No leadership role is listed for this legislator — most members don’t hold a chamber or committee chair position.' : 'No chamber or committee leadership role is listed for this legislator in the current data.'}</p></section>`;
    }
    return `<section class="legislator-modal-section"><div class="legislator-modal-section-heading"><h3>Leadership roles</h3><span>${roles.length} role${roles.length === 1 ? '' : 's'}</span></div><div class="vote-history-list">${roles.map((role) => `
      <article class="vote-history-row"><div><strong>${escapeHtml(role.detail || 'Leadership')}</strong><h4>${escapeHtml(role.title || 'Role')}</h4></div></article>`).join('')}</div></section>`;
  };

  const renderVotingPattern = (legislator) => {
    const pattern = legislator.votingPattern && typeof legislator.votingPattern === 'object' ? legislator.votingPattern : null;
    if (!pattern || !Number.isFinite(Number(pattern.recorded)) || Number(pattern.recorded) === 0) {
      const checked = Number(pattern?.totalChecked || asArray(legislator.votingHistory).length);
      return `<section class="legislator-modal-section"><h3>Voting patterns</h3><p class="legislator-missing">${checked ? `No individual Yes/No votes were recorded across the ${checked} major bill${checked === 1 ? '' : 's'} checked, so no pattern can be shown.` : 'Not enough recorded votes to describe a pattern. No pattern has been inferred.'}</p></section>`;
    }
    const yesPct = pattern.yesPct ?? 0;
    const noPct = pattern.noPct ?? 0;
    return `<section class="legislator-modal-section"><h3>Voting patterns</h3>
      <p class="legislator-pattern-trend">${escapeHtml(pattern.trend || 'Voting trend')}</p>
      <div class="legislator-pattern-grid">
        <div><strong>${escapeHtml(String(pattern.yes ?? 0))}</strong><span>Yes${yesPct !== null ? ` · ${escapeHtml(String(yesPct))}%` : ''}</span></div>
        <div><strong>${escapeHtml(String(pattern.no ?? 0))}</strong><span>No${noPct !== null ? ` · ${escapeHtml(String(noPct))}%` : ''}</span></div>
        <div><strong>${escapeHtml(String(pattern.recorded ?? 0))}</strong><span>Recorded of ${escapeHtml(String(pattern.totalChecked ?? 0))} checked</span></div>
      </div>
      <div class="legislator-pattern-bar" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, Number(yesPct) || 0))}%"></span></div>
      <p class="legislator-source-note">Computed only from the recorded Yes/No votes above. “Not recorded” bills are excluded, never counted as Yes or No.</p>
    </section>`;
  };

  const openModal = (legislator, trigger) => {
    if (!modal || !modalBody || !legislator) return;
    lastFocusedElement = trigger || document.activeElement;
    if (modalTitle) modalTitle.textContent = `${legislator.name} · ${legislator.chamber}`;
    modalBody.innerHTML = `
      ${renderDistrictParty(legislator)}
      ${renderCommittees(legislator)}
      ${renderVotingHistory(legislator)}
      ${renderSponsoredBills(legislator)}
      ${renderLeadership(legislator)}
      ${renderVotingPattern(legislator)}
      <p class="legislator-source-note">Legislator, committee, sponsorship, and vote records are provided by Open States. Verify important details with the official Texas Legislature before relying on them.</p>
    `;
    modal.classList.add('is-open');
    if (typeof modal.showModal === 'function') {
      if (!modal.open) modal.showModal();
    } else {
      modal.setAttribute('open', '');
    }
    modal.querySelector('.modal-close')?.focus();
  };

  const closeModal = () => {
    if (!modal) return;
    modal.classList.remove('is-open');
    if (typeof modal.close === 'function' && modal.open) modal.close();
    else modal.removeAttribute('open');
    lastFocusedElement?.focus?.();
    lastFocusedElement = null;
  };

  const markAsMyLegislator = (button, legislator) => {
    if (!button) return;
    button.disabled = true;
    button.setAttribute('aria-pressed', 'true');
    button.classList.add('is-selected');
    button.innerHTML = '<span aria-hidden="true">✓</span> Your legislator';
    const role = String(legislator?.chamber || '').toLowerCase() === 'senate' ? 'senator'
      : String(legislator?.chamber || '').toLowerCase() === 'house' ? 'representative' : 'legislator';
    setStatus(`${legislator?.name || 'That legislator'} is now your ${role}. Their votes will appear on the bill feed.`);
  };

  const handleListClick = (event) => {
    const maker = event.target.closest?.('[data-make-my-legislator]');
    if (maker) {
      event.preventDefault();
      const index = Number(maker.dataset.makeMyLegislator);
      if (!Number.isInteger(index) || !legislators[index]) return;
      const saved = saveMyLegislator(legislators[index]);
      if (saved) markAsMyLegislator(maker, legislators[index]);
      else setStatus('Could not save that choice. Check browser storage settings and try again.', true);
      return;
    }
    const trigger = event.target.closest?.('[data-legislator-index]');
    if (!trigger) return;
    const index = Number(trigger.dataset.legislatorIndex);
    if (!Number.isInteger(index) || !legislators[index]) return;
    event.preventDefault();
    openModal(legislators[index], trigger);
  };
  list?.addEventListener('click', handleListClick);
  document.querySelector('[data-legislator-modal-close]')?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });
  modal?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeModal();
  });
  modal?.addEventListener('close', () => {
    modal.classList.remove('is-open');
    lastFocusedElement?.focus?.();
    lastFocusedElement = null;
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const address = input?.value.trim() || '';
    if (!address) {
      setStatus('Enter a Texas address or ZIP code.', true);
      input?.focus();
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    if (results) results.hidden = true;
    setStatus('Looking up your Texas delegation…');
    try {
      let response;
      try {
        response = await fetch(`${apiBase}/api/legislators/lookup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ address }),
        });
      } catch (error) {
        throw new Error('Could not reach the lookup service. Check your connection and try again.');
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error(lookupFailureMessage(response, payload));
      }
      legislators = Array.isArray(payload.legislators) ? payload.legislators : [];
      if (legislators.length !== 2) throw new Error("We couldn't find a Texas legislator for that address. Double check it's a valid Texas address and try again.");
      // A new lookup may return different people, so prior "my legislator"
      // picks are cleared — nothing becomes yours without an explicit click.
      clearMyLegislators();
      if (list) list.innerHTML = legislators.map(renderLegislator).join('');
      if (addressLabel) addressLabel.textContent = payload.address || address;
      if (results) {
        results.hidden = false;
        results.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      }
      setStatus(payload.cached ? 'Showing a recent lookup for this address.' : 'Lookup complete.');
    } catch (error) {
      const message = error instanceof Error
        && typeof error.message === 'string'
        && error.message
        && error.message !== '[object Object]'
        ? error.message
        : 'We could not complete that lookup. Please try again.';
      setStatus(message, true);
    } finally {
      if (button) button.disabled = false;
    }
  });
})();
