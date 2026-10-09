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
    element.textContent = `✦ Historical snapshot: 89th Legislature special sessions (2025) · Published dataset: ${datasetUpdatedOn}. Verify current status with official Texas legislative sources; not legal advice.`;
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

  document.querySelectorAll('.avatar-button').forEach((button) => {
    button.dataset.profileWired = 'true';
    button.addEventListener('click', () => { window.location.href = 'profile.html'; });
  });

  const safe = (value) => String(value ?? 'Not provided');
  const escapeHtml = (value) => safe(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));

  // The curated set of industries Lariat tracks. Every option stays in the
  // dropdown even when the current dataset has no bills for it  -  empty
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

  // Canonical display status. This reads the stored `status` field written by
  // summarize_bills.py (derived from the Open States latest action + passage
  // dates) so the card badge and the detail modal always agree. Legacy
  // Alive/Dead labels are mapped forward, never shown for canonical records.
  const displayStatus = (bill) => {
    const explicitStatus = safe(bill.status || bill.legislative_status).trim().toLowerCase();
    if (['enacted', 'signed', 'adopted'].includes(explicitStatus)) return 'enacted';
    if (['passed'].includes(explicitStatus)) return 'passed';
    if (['dead', 'failed', 'did not pass', 'died', 'replaced'].includes(explicitStatus)) return 'dead';
    if (['pending'].includes(explicitStatus)) return 'pending';
    // Legacy records that stored the old binary badge vocabulary.
    if (['alive', 'active'].includes(explicitStatus)) return 'pending';
    return 'pending';
  };

  const statusLabel = (status) => {
    if (status === 'enacted') return 'Enacted';
    if (status === 'passed') return 'Passed';
    if (status === 'dead') return 'Dead';
    return 'Pending';
  };

  const statusBadge = (bill) => {
    const status = displayStatus(bill);
    return `<span class="status-badge ${status}"><span class="badge-dot"></span>${statusLabel(status)}</span>`;
  };

  // Short session tag for feed cards, e.g. "89th · 2nd Called (2025)".
  // SESSION_LABELS mirrors the backend map in summarize_bills.py.
  const SESSION_LABELS = {
    89: '89th Legislature, Regular Session (2025)',
    891: '89th Legislature, 1st Called Session (2025)',
    892: '89th Legislature, 2nd Called Session (2025)',
    90: '90th Legislature, Regular Session (2027)',
  };
  const SESSION_SHORT = {
    89: '89th · Regular (2025)',
    891: '89th · 1st Called (2025)',
    892: '89th · 2nd Called (2025)',
    90: '90th · Regular (2027)',
  };

  const formatSessionShort = (bill) => {
    const code = safe(bill.session).trim();
    if (SESSION_SHORT[code]) return SESSION_SHORT[code];
    return code && code !== 'Not provided' ? `Session ${code}` : '';
  };

  const formatOriginShort = (bill) => {
    const formatted = formatDateString(bill.origin_date);
    return formatted ? `Filed ${formatted}` : '';
  };

  const formatSession = (bill) => {
    const stored = safe(bill.session_label).trim();
    if (stored && stored !== 'Not provided') return stored;
    const code = safe(bill.session).trim();
    if (SESSION_LABELS[code]) return SESSION_LABELS[code];
    return code && code !== 'Not provided' ? `Texas session ${code}` : 'Texas session not recorded';
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
      sessionCountdown.textContent = '-';
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
        timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric',
      });
      sessionDetail.textContent = `${sessionName} begins ${formattedDate} · Central time · Dataset below: 89th special sessions (2025)`;
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
  const FIELD_EXPLANATIONS = {
    affects: 'Who and what this touches — from the bill\u2019s official subject tags and who the text says it applies to.',
    changes: 'What the bill does — from what the official bill text adds, changes, or requires.',
    business_impact: 'What it could mean in practice — our read of costs or rule changes in the text. Not legal advice.',
    status: 'Recorded legislative stage (Pending, Passed, Enacted, or Dead), derived from the official latest action and passage dates. The card badge always shows this same value.',
    suggested_action: 'What to review or prepare for — AI-written from requirements, deadlines, and exceptions in the official text.',
    summary: 'Plain-English version of the official Texas bill text. Full version when we have the text, shorter metadata version when we don\u2019t.',
    session: 'Which Texas legislative session this record belongs to — from the official record ID (e.g. 892 is the 89th Legislature, 2nd Called Session, 2025).',
    session_label: 'Plain-English name of the legislative session, so raw session codes are never ambiguous.',
    latest_action_description: 'Most recent official action recorded for this bill by Open States.',
    latest_action_date: 'Date of the most recent official action recorded for this bill.',
    latest_passage_date: 'Date a chamber recorded passage, when one is recorded. Absence of a date means no passage is recorded.',
    origin_date: 'The date this bill was first introduced — from the official first-action record.',
    updated_at: 'Date Lariat last refreshed this summary — not the date the Legislature acted.',
    summary_source: 'Whether this summary came from the full official bill text or just metadata (title + subjects + last action).',
    impact_scores: 'How the 7-factor impact signals scored this bill (0 = absent, 1 = possible, 2 = direct).',
    impact_rationale: 'Why the impact level was assigned — the strongest signals behind it.',
  };
  const fieldExplanation = (key) => {
    const normalized = String(key || '').toLowerCase();
    if (FIELD_EXPLANATIONS[normalized]) return FIELD_EXPLANATIONS[normalized];
    if (['updatedon', 'last_updated', 'generated_at'].includes(normalized)) return FIELD_EXPLANATIONS.updated_at;
    return '';
  };
  // Impact scores arrive as a raw 7-factor object. The generic formatter
  // would dump it as JSON (the ugly {"direct_compliance_requirement":0,…}
  // seen on newer bills), so render it as plain words instead.
  const IMPACT_FACTOR_LABELS = {
    direct_compliance_requirement: 'Direct compliance',
    financial_cost: 'Financial cost',
    operational_change: 'Operational change',
    industry_breadth: 'Industry breadth',
    enforcement_risk: 'Enforcement risk',
    effective_date_urgency: 'Effective date urgency',
    business_model_impact: 'Business model impact',
  };
  const formatImpactScores = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return formatValue(value);
    const words = ['absent', 'possible', 'direct'];
    const parts = Object.keys(IMPACT_FACTOR_LABELS)
      .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
      .map((key) => {
        const score = Number(value[key]);
        const word = words[score] || 'absent';
        return `${IMPACT_FACTOR_LABELS[key]}: ${word} (${Number.isFinite(score) ? score : 0})`;
      });
    if (!parts.length) return formatValue(value);
    return parts.join('\n');
  };
  const formatDateString = (raw) => {
    const match = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
    if (!match) return null;
    const [, year, month, day] = match.map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  };
  const formatValue = (value) => {
    if (value === null || value === undefined || value === '') return 'Not provided';
    if (typeof value === 'string') {
      const formattedDate = formatDateString(value);
      if (formattedDate) return formattedDate;
    }
    let formatted;
    try {
      formatted = typeof value === 'object' ? JSON.stringify(value) : String(value);
    } catch (error) {
      formatted = 'Not provided';
    }
    if (formatted.length > 4000) formatted = `${formatted.slice(0, 4000)}…`;
    // Ensure the first letter of the first word is capitalized.
    return formatted.replace(/^[a-z]/, (character) => character.toUpperCase());
  };
  const formatUpdatedOn = (bill) => {
    const rawDate = bill.updated_at || bill.updatedOn || bill.last_updated || bill.generated_at;
    if (!rawDate) return datasetUpdatedOn;
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) return safe(rawDate);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  // Bill history timeline. Prefers the stored `bill_history` array written by
  // summarize_bills.py (present on current backfilled records and all future
  // summaries), and otherwise derives the same timeline shape from the
  // origin / passage / latest-action fields every record already carries.
  const historyDateOnly = (raw) => {
    const match = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
  };
  const validHistoryEvents = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && typeof item === 'object' && String(item.title || '').trim())
      .map((item) => ({
        date: historyDateOnly(item.date),
        title: String(item.title || '').trim().slice(0, 160),
        description: String(item.description || '').trim().slice(0, 600),
      }));
  };
  const buildBillHistory = (bill) => {
    const stored = validHistoryEvents(bill.bill_history);
    if (stored.length) return stored.slice(0, 15);
    const identifier = safe(bill.identifier).trim() || 'This bill';
    const events = [];
    const origin = historyDateOnly(bill.origin_date);
    if (origin) {
      events.push({
        date: origin,
        title: 'First filed — bill comes to fruition',
        description: `${identifier} was first introduced on ${formatDateString(origin) || origin}. This is when the bill came to fruition as an official Texas legislative record.`,
      });
    }
    const passage = historyDateOnly(bill.latest_passage_date);
    if (passage && passage !== origin) {
      events.push({
        date: passage,
        title: 'Chamber passage recorded',
        description: `A chamber recorded passage of ${identifier} on ${formatDateString(passage) || passage}. No enactment is implied beyond the recorded passage.`,
      });
    }
    const latestDate = historyDateOnly(bill.latest_action_date);
    const latestDesc = String(bill.latest_action_description || '').trim().replace(/\.+$/, '');
    if (latestDesc && latestDate && latestDate !== origin && latestDate !== passage) {
      const title = latestDesc.replace(/^[a-z]/, (character) => character.toUpperCase()).slice(0, 160);
      events.push({
        date: latestDate,
        title,
        description: `Latest official action on ${identifier}: ${title} on ${formatDateString(latestDate) || latestDate}.`,
      });
    } else if (latestDesc && !latestDate) {
      const title = latestDesc.replace(/^[a-z]/, (character) => character.toUpperCase()).slice(0, 160);
      events.push({ date: '', title, description: `Latest recorded action on ${identifier}: ${title}.` });
    }
    const refreshed = historyDateOnly(bill.updated_at);
    if (refreshed && !events.some((event) => event.date === refreshed)) {
      events.push({
        date: refreshed,
        title: 'Lariat summary refreshed',
        description: 'Lariat refreshed this summary record. Legislative status reflects the official latest action, not this refresh date.',
      });
    }
    return events.slice(0, 15);
  };
  const billHistoryMarkup = (bill) => {
    const events = buildBillHistory(bill);
    if (!events.length) return '';
    const popoverId = `bill-history-${Number.isInteger(bill.__index) ? bill.__index : String(safe(bill.identifier)).replace(/[^A-Za-z0-9]+/g, '-')}`;
    return `
      <section class="bill-history-field" aria-label="Bill history">
        <h4 class="view-history-trigger" tabindex="0" aria-describedby="${escapeHtml(popoverId)}">View History</h4>
        <div class="bill-timeline-popover" id="${escapeHtml(popoverId)}" role="tooltip">
          <p class="bill-timeline-kicker">Bill history · oldest to newest</p>
          <ol class="bill-timeline">
            ${events.map((event) => `
              <li class="bill-timeline-event">
                <span class="bill-timeline-dot" aria-hidden="true"></span>
                <div class="bill-timeline-text">
                  ${event.date ? `<p class="bill-timeline-date">${escapeHtml(formatDateString(event.date) || event.date)}</p>` : ''}
                  <p class="bill-timeline-title">${escapeHtml(event.title)}</p>
                  ${event.description ? `<p class="bill-timeline-desc">${escapeHtml(event.description)}</p>` : ''}
                </div>
              </li>`).join('')}
          </ol>
        </div>
      </section>`;
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

  // "Your legislator's vote" badges. Reads the snapshot saved by
  // legislator.js after a successful Find Your Legislator lookup — no new
  // network calls. Matches are exact identifier + session only; anything
  // missing or unrecorded is omitted, never inferred.
  const MY_LEGISLATORS_STORAGE_KEY = 'lariat-my-legislators-v1';

  const normalizeVoteIdentifier = (value) => String(value ?? '')
    .trim().toUpperCase().replace(/\s+/g, ' ');
  const normalizeVoteSession = (value) => String(value ?? '').trim();

  const readMyLegislators = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(MY_LEGISLATORS_STORAGE_KEY) || 'null');
      const people = Array.isArray(parsed) ? parsed : parsed?.legislators;
      if (!Array.isArray(people)) return [];
      return people.filter((person) => person && typeof person === 'object');
    } catch (error) {
      return [];
    }
  };

  const isRecordedVote = (record) => {
    const vote = String(record?.vote ?? '').trim();
    return record?.voteStatus === 'recorded'
      && vote !== ''
      && vote.toLowerCase() !== 'not recorded';
  };

  const voteMatchesBill = (record, billIdentifier, billSession) => {
    if (!isRecordedVote(record)) return false;
    if (normalizeVoteIdentifier(record.identifier) !== billIdentifier) return false;
    const recordSession = normalizeVoteSession(record.session);
    // Records saved before session was tracked carry no session; match those
    // on identifier only. Whenever both sides have a session, require equality.
    if (!recordSession || !billSession) return true;
    return recordSession === billSession;
  };

  const myVotesForBill = (bill) => {
    const billIdentifier = normalizeVoteIdentifier(bill?.identifier);
    if (!billIdentifier) return [];
    const billSession = normalizeVoteSession(bill?.session);
    const matches = [];
    for (const person of readMyLegislators()) {
      const chamber = String(person.chamber || '').toLowerCase();
      const role = chamber === 'senate' ? 'senator' : chamber === 'house' ? 'rep' : '';
      if (!role) continue;
      // One badge per chamber: first recorded match wins.
      if (matches.some((match) => match.role === role)) continue;
      const records = Array.isArray(person.votingHistory) ? person.votingHistory : [];
      const match = records.find((record) => voteMatchesBill(record, billIdentifier, billSession));
      if (match) {
        matches.push({
          role,
          vote: String(match.vote).trim(),
          name: String(person.name || '').trim(),
          photoUrl: String(person.photoUrl || ''),
        });
      }
    }
    return matches;
  };

  const myVoteBadges = (bill) => myVotesForBill(bill).map(({ role, vote }) => (
    `<span class="vote-badge"><span class="badge-dot"></span>Your ${escapeHtml(role)} voted ${escapeHtml(vote)}</span>`
  )).join('');

  // Verdict wording for the large popup hero. Yes-like votes read as support
  // for the bill, No-like votes as opposition; anything else (Present,
  // Absent, …) falls back to the verbatim vote so nothing is inferred.
  const voteVerdict = (vote) => {
    const normalized = String(vote || '').toLowerCase().replace(/·.*$/, '').trim();
    if (['yes', 'yea', 'aye', 'for'].includes(normalized)) return 'For the passing of this Bill';
    if (['no', 'nay', 'against'].includes(normalized)) return 'Against the passing of this Bill';
    return '';
  };

  const roleTitle = (role) => (role === 'senator' ? 'senator' : role === 'rep' ? 'representative' : 'legislator');

  // Large signifier pinned to the very top of the bill detail popup: the
  // selected legislator's actual name, and the for/against verdict.
  // Returns '' when there is nothing recorded — never rendered, never guessed.
  const myVoteHero = (bill) => {
    const matches = myVotesForBill(bill);
    if (!matches.length) return '';
    return `
      <section class="my-vote-hero" aria-label="How your legislators voted on this bill">
        ${matches.map((match) => {
          const verdict = voteVerdict(match.vote);
          const verdictText = verdict
            ? `Voted ${verdict}`
            : `Voted ${match.vote} on this Bill`;
          const name = String(match.name || '').trim();
          const kickerText = name
            ? `${name} · your ${roleTitle(match.role)}`
            : `Your ${roleTitle(match.role)}`;
          return `
            <div class="my-vote-row">
              <div class="my-vote-text">
                <p class="my-vote-kicker">${escapeHtml(kickerText)}</p>
                <p class="my-vote-verdict">${escapeHtml(verdictText)}</p>
              </div>
            </div>`;
        }).join('')}
      </section>
    `;
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
      .filter(([key]) => !['id', 'identifier', 'title', 'impact_level', 'industry', 'specific_industry', 'source_url', 'bill_text_source', 'bill_text_hash', 'summary_word_count', 'bill_history', 'impact_framework', '__index', '__groupId'].includes(key))
      .slice(0, 30);
    modalBody.innerHTML = `
      <article class="modal-bill-card ${levelClass === 'high' ? 'high-impact' : ''}">
        ${myVoteHero(bill)}
        <div class="bill-topline"><span class="bill-number">${escapeHtml(identifier)}</span><span class="bill-date">${escapeHtml(displaySpecificIndustry(bill.specific_industry, bill.industry))}</span></div>
        <div class="bill-heading"><h3>${escapeHtml(title)}</h3><div class="bill-badges">${statusBadge(bill)}<span class="impact-badge ${levelClass}"><span class="badge-dot"></span>${escapeHtml(level)} impact</span></div></div>
        <button class="updated-on-button" type="button" data-updated-on="${escapeHtml(updatedOn)}" aria-label="Summary updated on ${escapeHtml(updatedOn)}" title="This summary's dataset refresh date"><span aria-hidden="true">↻</span> Updated on · ${escapeHtml(updatedOn)}</button>
        ${billHistoryMarkup(bill)}
        <div class="modal-fields">
          ${detailFields.map(([key, value]) => {
            const tip = fieldExplanation(key);
            const display = key === 'impact_scores' ? formatImpactScores(value) : formatValue(value);
            if (!tip) return `
            <section class="modal-field">
              <h4>${escapeHtml(formatLabel(key))}</h4>
              <p>${escapeHtml(display)}</p>
            </section>`;
            return `
            <section class="modal-field">
              <h4 class="field-label" tabindex="0">${escapeHtml(formatLabel(key))}<span class="field-info" aria-hidden="true">i</span><span class="field-tip" role="tooltip">${escapeHtml(tip)}</span></h4>
              <p>${escapeHtml(display)}</p>
            </section>`;
          }).join('')}
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
    // Touch / keyboard fallback: hover shows the timeline via CSS, while a tap
    // or Enter press toggles it for devices without hover.
    modalBody.querySelector('.view-history-trigger')?.addEventListener('click', (event) => {
      event.currentTarget.closest('.bill-history-field')?.classList.toggle('is-open');
    });
    modalBody.querySelector('.view-history-trigger')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.currentTarget.closest('.bill-history-field')?.classList.toggle('is-open');
      }
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
    list.innerHTML = `
      <section class="industry-group" aria-labelledby="selected-industry-title">
        <div class="industry-group-heading">
          <div>
            <div class="section-kicker">${showSpecificIndustry ? 'Specific industries in this category' : 'All impacted industries'}</div>
            <h3 id="selected-industry-title" class="industry-group-title">${escapeHtml(viewTitle)}</h3>
          </div>
          <span class="industry-count">${industryBills.length} ${industryBills.length === 1 ? 'bill' : 'bills'}</span>
        </div>
        <div class="industry-bills">
          ${industryBills.map((bill) => {
            const levelClass = impactClass(bill.impact_level);
            const identifier = escapeHtml(bill.identifier || 'Unknown ID');
            const title = escapeHtml(bill.title || 'Untitled bill');
            const cardIndustry = showSpecificIndustry
              ? displaySpecificIndustry(bill.specific_industry, bill.industry)
              : displayIndustry(bill.industry);
            const cardSession = formatSessionShort(bill);
            const cardOrigin = formatOriginShort(bill);
            const cardMeta = [cardSession, cardOrigin].filter(Boolean).join(' · ');
            const rawIdentifier = String(bill.identifier || 'Unknown ID');
            const isSaved = window.LariatProfile
              ? window.LariatProfile.get().bookmarkedBills.includes(rawIdentifier)
              : false;
            return `
              <button class="bill-card bill-card-button ${levelClass === 'high' ? 'high-impact' : ''}" type="button" data-bill-index="${bill.__index}" aria-label="Open full summary for ${identifier}" title="Open the full summary for ${identifier}">
                <div class="bill-topline"><span class="bill-number">${identifier}</span><span class="bill-date">${escapeHtml(cardIndustry)}</span></div>
                <div class="bill-heading"><h3>${title}</h3><div class="bill-badges">${statusBadge(bill)}<span class="impact-badge ${levelClass}"><span class="badge-dot"></span>${escapeHtml(safe(bill.impact_level))} impact</span>${myVoteBadges(bill)}</div></div>
                ${cardMeta ? `<div class="bill-meta"><span>${escapeHtml(cardMeta)}</span></div>` : ''}
                <span class="bill-card-footer"><span class="bill-card-action">Click to view full summary <span aria-hidden="true">↗</span></span><span class="bill-save-button" role="button" tabindex="0" data-save-bill="${escapeHtml(rawIdentifier)}" aria-pressed="${isSaved}" title="${isSaved ? `${identifier} is in Your Saves — activate to remove` : `Save ${identifier} to Your Saves`}">${isSaved ? 'Saved to Your Saves <span aria-hidden="true">✓</span>' : 'Save to Your Saves'}</span></span>
              </button>
            `;
          }).join('')}
        </div>
      </section>
    `;

    list.querySelectorAll('[data-bill-index]').forEach((row) => {
      row.addEventListener('click', () => openBillModal(allBills[Number(row.dataset.billIndex)], row));
    });
    // Save-to-Your-Saves controls live inside the card button as spans (a real
    // <button> cannot nest), so every activation stops propagation and never
    // opens the bill modal.
    const refreshSaveButtons = () => {
      const saved = new Set(window.LariatProfile ? window.LariatProfile.get().bookmarkedBills : []);
      document.querySelectorAll('[data-save-bill]').forEach((el) => {
        const isSaved = saved.has(el.dataset.saveBill);
        el.setAttribute('aria-pressed', String(isSaved));
        el.innerHTML = isSaved
          ? 'Saved to Your Saves <span aria-hidden="true">✓</span>'
          : 'Save to Your Saves';
        el.setAttribute('title', isSaved
          ? `${el.dataset.saveBill} is in Your Saves — activate to remove`
          : `Save ${el.dataset.saveBill} to Your Saves`);
      });
    };
    list.querySelectorAll('[data-save-bill]').forEach((el) => {
      const activate = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!window.LariatProfile || typeof window.LariatProfile.toggleBookmark !== 'function') {
          showToast('Profiles are unavailable in this browser.');
          return;
        }
        const id = el.dataset.saveBill;
        const alreadySaved = window.LariatProfile.get().bookmarkedBills.includes(id);
        if (!alreadySaved && typeof window.LariatProfile.requireVerifiedEmail === 'function' && !window.LariatProfile.requireVerifiedEmail()) {
          return;
        }
        const after = window.LariatProfile.toggleBookmark(id);
        const isSaved = after.includes(id);
        showToast(isSaved ? `Saved ${id} to Your Saves.` : `Removed ${id} from Your Saves.`);
        refreshSaveButtons();
        if (window.LariatSubscriptions && typeof window.LariatSubscriptions.syncSaves === 'function') {
          window.LariatSubscriptions.syncSaves();
        }
      };
      el.addEventListener('click', activate);
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          activate(event);
        }
      });
    });
    if (!window.__lariatSaveSyncWired) {
      window.__lariatSaveSyncWired = true;
      document.addEventListener('lariat:profile-changed', () => {
        const saved = new Set(window.LariatProfile ? window.LariatProfile.get().bookmarkedBills : []);
        document.querySelectorAll('[data-save-bill]').forEach((el) => {
          const isSaved = saved.has(el.dataset.saveBill);
          el.setAttribute('aria-pressed', String(isSaved));
          el.innerHTML = isSaved
            ? 'Saved to Your Saves <span aria-hidden="true">✓</span>'
            : 'Save to Your Saves';
        });
        // The email may have just been finalized — mirror saved bills to the
        // notification digest backend as soon as it qualifies.
        if (window.LariatSubscriptions && typeof window.LariatSubscriptions.syncSaves === 'function') {
          window.LariatSubscriptions.syncSaves();
        }
      });
    }
    refreshSaveButtons();
    // Mirror saves on load too (no-op until the profile email is finalized).
    if (window.LariatSubscriptions && typeof window.LariatSubscriptions.syncSaves === 'function') {
      window.LariatSubscriptions.syncSaves();
    }
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
      if (sessionCountdown) sessionCountdown.textContent = '-';
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
