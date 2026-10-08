/* Lariat device-local profiles — free Stage 0, no backend.
 * Stores one profile per browser in localStorage:
 *   lariat-profile-v1 = { displayName, email, emailVerifiedAt, industries[], bookmarkedBills[], legislatorAddress, updatedAt }
 * The email is only ever written together with a server confirmation
 * (Finalize Email on profile.html); unverified address changes are dropped.
 * No prompt(). No login. Cross-device sync comes later (Stage 1).
 */
(() => {
  'use strict';

  const PROFILE_KEY = 'lariat-profile-v1';
  const LEGACY_NAME_KEY = 'lariat-user-name';
  const LEGACY_SKIPPED = '__skipped__';
  const MAX_NAME_LENGTH = 80;
  const MAX_ADDRESS_LENGTH = 240;
  const MAX_EMAIL_LENGTH = 254;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const ALL_INDUSTRIES = [
    'Energy & Utilities',
    'Government & Municipal Operations',
    'Emergency & Public Safety',
    'Real Estate & Land Use',
    'Insurance & Financial Services',
  ];

  function defaultProfile() {
    return {
      displayName: '',
      email: '',
      emailVerifiedAt: '',
      industries: [],
      bookmarkedBills: [],
      legislatorAddress: '',
      updatedAt: new Date().toISOString(),
    };
  }

  function sanitizeName(value) {
    return String(value || '').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  }

  function sanitizeEmail(value) {
    const clean = String(value || '').trim().slice(0, MAX_EMAIL_LENGTH);
    return EMAIL_PATTERN.test(clean) ? clean : '';
  }

  // emailVerifiedAt is an ISO timestamp proving the address passed the emailed
  // code (Finalize Email). It is accepted only alongside a matching email and
  // is wiped whenever the email itself changes.
  function sanitizeVerifiedAt(value, email) {
    if (typeof value !== 'string' || !value || !email) return '';
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return '';
    return new Date(time).toISOString();
  }

  function sanitizeAddress(value) {
    return String(value || '').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ADDRESS_LENGTH);
  }

  function sanitizeIndustries(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((v) => typeof v === 'string' && ALL_INDUSTRIES.includes(v.trim()))
      .map((v) => v.trim())
      .filter((v, i, arr) => arr.indexOf(v) === i);
  }

  function sanitizeBookmarks(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((v) => typeof v === 'string')
      .map((v) => v.trim().slice(0, 40))
      .filter((v) => /^[A-Za-z]{2,4}\s?\d{1,4}$/.test(v))
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, 200);
  }

  function readProfile() {
    let parsed = null;
    try {
      parsed = JSON.parse(localStorage.getItem(PROFILE_KEY));
    } catch (error) {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object') {
      const email = sanitizeEmail(parsed.email);
      return {
        displayName: sanitizeName(parsed.displayName),
        email,
        emailVerifiedAt: sanitizeVerifiedAt(parsed.emailVerifiedAt, email),
        industries: sanitizeIndustries(parsed.industries),
        bookmarkedBills: sanitizeBookmarks(parsed.bookmarkedBills),
        legislatorAddress: sanitizeAddress(parsed.legislatorAddress),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      };
    }
    // One-time migration from the old prompt-based name (user-name.js).
    try {
      const legacy = localStorage.getItem(LEGACY_NAME_KEY);
      if (legacy && legacy !== LEGACY_SKIPPED && legacy.trim()) {
        const migrated = defaultProfile();
        migrated.displayName = sanitizeName(legacy);
        migrated.updatedAt = new Date().toISOString();
        try { localStorage.setItem(PROFILE_KEY, JSON.stringify(migrated)); } catch (e) { /* ignore */ }
        return migrated;
      }
    } catch (error) { /* storage blocked */ }
    return defaultProfile();
  }

  function writeProfile(patch) {
    const current = readProfile();
    const nextEmail = patch && 'email' in patch ? sanitizeEmail(patch.email) : current.email;
    const emailChanged = nextEmail !== current.email;
    const next = {
      displayName: patch && 'displayName' in patch ? sanitizeName(patch.displayName) : current.displayName,
      email: nextEmail,
      // A new address must be re-confirmed via Finalize Email: the verified
      // stamp survives only when the address is unchanged, or when the
      // finalize flow writes both together. Writing emailVerifiedAt alone
      // (without a matching email) can never set it.
      emailVerifiedAt: (patch && 'email' in patch && patch && 'emailVerifiedAt' in patch)
        ? sanitizeVerifiedAt(patch.emailVerifiedAt, nextEmail)
        : (emailChanged ? '' : current.emailVerifiedAt),
      industries: patch && 'industries' in patch ? sanitizeIndustries(patch.industries) : current.industries,
      bookmarkedBills: patch && 'bookmarkedBills' in patch ? sanitizeBookmarks(patch.bookmarkedBills) : current.bookmarkedBills,
      legislatorAddress: patch && 'legislatorAddress' in patch ? sanitizeAddress(patch.legislatorAddress) : current.legislatorAddress,
      updatedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
    } catch (error) { /* storage blocked; profile applies to this visit only */ }
    renderHeader(next);
    document.dispatchEvent(new CustomEvent('lariat:profile-changed', { detail: { profile: next } }));
    return next;
  }

  function initialsFor(name) {
    const clean = sanitizeName(name);
    if (!clean) return 'TX';
    const parts = clean.split(/\s+/);
    const first = (parts[0] || '').charAt(0).toUpperCase();
    const last = parts.length > 1
      ? (parts[parts.length - 1] || '').charAt(0).toUpperCase()
      : (parts[0] || '').charAt(1).toUpperCase();
    return (first + last).trim() || 'TX';
  }

  function firstNameFor(name) {
    const clean = sanitizeName(name);
    if (!clean) return '';
    return clean.split(/\s+/)[0].slice(0, 12);
  }

  function renderHeader(profile) {
    const p = profile || readProfile();
    const label = p.displayName || 'there';
    document.querySelectorAll('[data-user-name]').forEach((el) => { el.textContent = label; });
    const firstName = firstNameFor(p.displayName);
    document.querySelectorAll('.header-actions').forEach((actions) => {
      const cta = actions.querySelector('.profile-cta');
      const btn = actions.querySelector('.avatar-button');
      if (!cta && !btn) return;
      const hasProfile = Boolean(firstName);
      if (cta) cta.hidden = hasProfile;
      if (btn) {
        btn.hidden = !hasProfile;
        if (hasProfile) {
          btn.textContent = firstName;
          btn.classList.add('has-name');
          btn.setAttribute('aria-label', `Open profile for ${p.displayName}`);
          btn.setAttribute('title', `Profile — ${p.displayName}`);
        }
      }
    });
    // Fallback for stray avatar buttons outside .header-actions.
    document.querySelectorAll('.avatar-button').forEach((btn) => {
      if (btn.closest('.header-actions')) return;
      if (firstName) {
        btn.hidden = false;
        btn.textContent = firstName;
        btn.classList.add('has-name');
      }
    });
  }

  function toggleBookmark(billId) {
    const clean = String(billId || '').trim().slice(0, 40);
    if (!/^[A-Za-z]{2,4}\s?\d{1,4}$/.test(clean)) return readProfile().bookmarkedBills;
    const current = readProfile();
    const has = current.bookmarkedBills.includes(clean);
    const next = has
      ? current.bookmarkedBills.filter((b) => b !== clean)
      : [...current.bookmarkedBills, clean].slice(0, 200);
    writeProfile({ bookmarkedBills: next });
    return next;
  }

  function clearProfile() {
    try { localStorage.removeItem(PROFILE_KEY); } catch (error) { /* ignore */ }
    const fresh = defaultProfile();
    renderHeader(fresh);
    document.dispatchEvent(new CustomEvent('lariat:profile-changed', { detail: { profile: fresh } }));
    return fresh;
  }

  // Avatar buttons anywhere on the site go to the profile page.
  // Page-specific scripts (script.js, real-script.js, key-events.js) were
  // edited to do the same; this is the fallback for any page that only
  // loads profile.js.
  document.addEventListener('click', (event) => {
    const btn = event.target && event.target.closest ? event.target.closest('.avatar-button') : null;
    if (!btn) return;
    if (btn.dataset.profileWired === 'true') return; // page script handles it
    event.preventDefault();
    window.location.href = 'profile.html';
  });

  renderHeader(readProfile());

  window.LariatProfile = {
    get: readProfile,
    set: writeProfile,
    clear: clearProfile,
    toggleBookmark,
    initialsFor,
    ALL_INDUSTRIES: Object.freeze([...ALL_INDUSTRIES]),
  };
})();
