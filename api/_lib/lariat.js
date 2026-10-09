'use strict';

/*
 * Shared library for the Lariat serverless email backend (Vercel Functions).
 *
 * Mirrors the subscription + profile-email logic in server/server.js (the
 * local-development backend), adapted for stateless execution:
 *   - subscriptions.json  ->  Upstash Redis (REST, no TCP needed)
 *   - pending-code pruning timers  ->  Redis TTLs
 *   - in-memory rate limits / cooldowns / lockouts  ->  Redis counters
 *
 * Zero dependencies: Node built-ins (crypto, fetch) only, like server.js.
 * Secrets come from Vercel project environment variables, never from code.
 */

const crypto = require('crypto');

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------- */

const DATA_KEY = (() => {
  const hex = (process.env.SUBSCRIPTION_DATA_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
})();
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL || '';
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

const MAX_EMAIL_LENGTH = 254;
const MAX_INDUSTRY_LENGTH = 200;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^[0-9]{6}$/;
const CODE_EXPIRY_MINUTES = Math.min(24 * 60, Math.max(1, Number(process.env.SUBSCRIPTION_CODE_EXPIRY_MINUTES) || 10));
const CODE_EXPIRY_SECONDS = CODE_EXPIRY_MINUTES * 60;
const VERIFY_MAX_ATTEMPTS = 5;
const PROFILE_EMAIL_PURPOSE = '__profile_email__';
const UNSUBSCRIBE_TOKEN_DAYS = Math.min(365, Math.max(1, Number(process.env.SUBSCRIPTION_UNSUBSCRIBE_TOKEN_DAYS) || 90));

// Notification digest configuration. The dispatch endpoint is admin-only and
// disabled entirely when the shared secret is not configured.
const NOTIFICATIONS_SECRET = (process.env.NOTIFICATIONS_SECRET || '').trim();
const NOTIFICATIONS_FEED_URL = (process.env.NOTIFICATIONS_FEED_URL || '').trim()
  || 'https://raw.githubusercontent.com/Olu964/Lariat-Demo1/main/texas_bill_summaries.json';
const MAX_SAVED_BILLS = 200;
const BILL_ID_PATTERN = /^[A-Za-z]{2,4}\s?\d{1,4}$/;

// Canonical industry list — mirrors ALL_INDUSTRIES in profile.js and
// INDUSTRY_LIST in server/server.js. Subscribe requests must name one exactly.
const INDUSTRY_LIST = Object.freeze([
  'Energy & Utilities',
  'Government & Municipal Operations',
  'Emergency & Public Safety',
  'Real Estate & Land Use',
  'Insurance & Financial Services',
]);

// HMAC secret for signed unsubscribe links. Random per instance when unset
// (links die with the cold start); set SUBSCRIPTION_SIGNING_SECRET in Vercel
// so links survive redeployments.
const SIGNING_SECRET = process.env.SUBSCRIPTION_SIGNING_SECRET || crypto.randomBytes(32).toString('hex');

// Core config needed by every email endpoint (encryption + storage).
// Serverless instances cannot safely fall back to plaintext storage, so a
// missing data key or missing Upstash credentials fail closed.
function requireCore() {
  if (!DATA_KEY) {
    const error = new Error('Email backend misconfigured (data key).');
    error.status = 500;
    throw error;
  }
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    const error = new Error('Email backend misconfigured (storage).');
    error.status = 500;
    throw error;
  }
}

function requireEmail() {
  requireCore();
  if (!BREVO_API_KEY || !EMAIL_PATTERN.test(BREVO_FROM_EMAIL)) {
    const error = new Error('Email delivery is not configured.');
    error.status = 500;
    throw error;
  }
}

/* ---------------------------------------------------------------------------
 * Upstash Redis REST client
 * ------------------------------------------------------------------------- */

async function upipe(commands) {
  const response = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(8000),
  });
  let data = null;
  try {
    data = await response.json();
  } catch (error) { /* fall through to error below */ }
  if (!response.ok || !data || data.error) {
    const error = new Error('Storage temporarily unavailable.');
    error.status = 503;
    throw error;
  }
  const results = Array.isArray(data) ? data : [data];
  return results.map((entry) => {
    if (entry && typeof entry === 'object' && 'error' in entry && entry.error) {
      const error = new Error('Storage temporarily unavailable.');
      error.status = 503;
      throw error;
    }
    return entry ? entry.result : null;
  });
}

async function ucmd(...args) {
  const [result] = await upipe([[ ...args ]]);
  return result;
}

const ipHash = (ip) => crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex');
const subKey = (emailHmac, industry) => `lariat:sub:${emailHmac}:${industry}`;
const pendKey = (key) => `lariat:pend:${key}`;
const rlKey = (name, ip) => `lariat:rl:${name}:${ipHash(ip)}`;
const cdKey = (key) => `lariat:cd:${key}`;

/* ---------------------------------------------------------------------------
 * Email crypto (same shapes as server.js)
 * ------------------------------------------------------------------------- */

const EMAIL_HMAC_KEY = DATA_KEY
  ? crypto.createHash('sha256').update(DATA_KEY).update(':email-lookup-v1').digest()
  : null;

function emailLookupId(email) {
  const lowered = String(email || '').toLowerCase();
  if (!EMAIL_HMAC_KEY) return lowered;
  return `hmac:${crypto.createHmac('sha256', EMAIL_HMAC_KEY).update(lowered).digest('hex')}`;
}

function encryptEmail(email) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DATA_KEY, iv);
  const data = Buffer.concat([cipher.update(String(email), 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64url'),
    data: data.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

function makeEmailFields(email) {
  const clean = String(email);
  return { emailEnc: encryptEmail(clean), emailHmac: emailLookupId(clean) };
}

function decryptEmail(enc) {
  if (!enc || enc.v !== 1 || !DATA_KEY) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', DATA_KEY, Buffer.from(enc.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    return null;
  }
}

// Plaintext address for a stored record: the decrypted `emailEnc` field, or a
// legacy plaintext `email` field when present. Null when unreadable.
function storedEmail(record) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.email === 'string' && EMAIL_PATTERN.test(record.email)) return record.email;
  return decryptEmail(record.emailEnc);
}

function recordMatchesHmac(record, emailHmac) {
  return !!record && record.emailHmac === emailHmac;
}

function hashCode(code, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(code), String(salt), 32, (error, derived) => {
      if (error) return reject(error);
      return resolve(`scrypt$${derived.toString('hex')}`);
    });
  });
}

function codeMatches(code, pending) {
  const stored = pending.codeHash;
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(code), String(pending.salt), 32, (error, derived) => {
      if (error) return reject(error);
      const expected = Buffer.from(stored.slice('scrypt$'.length), 'hex');
      return resolve(expected.length === derived.length && crypto.timingSafeEqual(expected, derived));
    });
  });
}

function generateCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/* ---------------------------------------------------------------------------
 * Signed unsubscribe tokens (HMAC-SHA256, tamper-proof, expiring) — the
 * token carries email + industry + a per-subscription tokenId; a link only
 * works while the stored record still carries the same tokenId.
 * ------------------------------------------------------------------------- */

function signToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SIGNING_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(parts[0]).digest('base64url');
    const received = Buffer.from(parts[1]);
    const expectedBuffer = Buffer.from(expected);
    if (received.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(received, expectedBuffer)) return null;
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof payload.email !== 'string' || payload.email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(payload.email)) return null;
    if (typeof payload.industry !== 'string' || !INDUSTRY_LIST.includes(payload.industry)) return null;
    if (typeof payload.tokenId !== 'string' || !/^[0-9a-f]{32}$/i.test(payload.tokenId)) return null;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || Date.now() >= payload.exp) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function makeUnsubscribeToken(email, industry) {
  const tokenId = crypto.randomBytes(16).toString('hex');
  return {
    token: signToken({ email, industry, tokenId, exp: Date.now() + UNSUBSCRIBE_TOKEN_DAYS * 86_400_000 }),
    tokenId,
  };
}

/* ---------------------------------------------------------------------------
 * Storage operations
 * ------------------------------------------------------------------------- */

const pendingKey = (email, industry) => `${emailLookupId(email)}::${industry}`;

async function findPending(email, industry) {
  const key = pendKey(pendingKey(email, industry));
  const record = await ucmd('HGETALL', key);
  if (!record || typeof record !== 'object' || Array.isArray(record) || !record.codeHash) return null;
  return { ...record, attempts: Number(record.attempts) || 0, expiresAt: Number(record.expiresAt) || 0 };
}

async function savePending(email, industry, code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = pendKey(pendingKey(email, industry));
  const fields = makeEmailFields(email);
  await upipe([
    ['DEL', key],
    ['HSET', key,
      'emailEnc', JSON.stringify(fields.emailEnc),
      'emailHmac', fields.emailHmac,
      'industry', industry,
      'salt', salt,
      'codeHash', await hashCode(code, salt),
      'expiresAt', String(Date.now() + CODE_EXPIRY_SECONDS * 1000),
      'attempts', '0',
      'createdAt', new Date().toISOString()],
    ['EXPIRE', key, String(CODE_EXPIRY_SECONDS)],
  ]);
}

async function deletePending(email, industry) {
  await ucmd('DEL', pendKey(pendingKey(email, industry)));
}

async function bumpPendingAttempts(email, industry) {
  await ucmd('HINCRBY', pendKey(pendingKey(email, industry)), 'attempts', '1');
}

async function saveSubscription(record) {
  await ucmd('SET', subKey(record.emailHmac, record.industry), JSON.stringify(record));
}

// One subscription for an email + industry pair (null when absent).
async function findSubscription(email, industry) {
  const raw = await ucmd('GET', subKey(emailLookupId(email), industry));
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

// Removes one subscription (idempotent — deleting a missing key is a no-op).
async function deleteSubscription(email, industry) {
  await ucmd('DEL', subKey(emailLookupId(email), industry));
}

// All subscriptions recorded under one address (for the profile-email move).
async function findSubscriptionsByHmac(emailHmac) {
  const pattern = `lariat:sub:${emailHmac}:*`;
  const found = [];
  let cursor = '0';
  for (let rounds = 0; rounds < 20; rounds += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [next, keys] = await ucmd('SCAN', cursor, 'MATCH', pattern, 'COUNT', '100');
    cursor = String(next);
    const list = Array.isArray(keys) ? keys : [];
    if (list.length) {
      // eslint-disable-next-line no-await-in-loop
      const [values] = await upipe([['MGET', ...list]]);
      for (const raw of Array.isArray(values) ? values : []) {
        try {
          const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : null;
          if (parsed && typeof parsed === 'object') found.push(parsed);
        } catch (error) { /* skip malformed */ }
      }
    }
    if (cursor === '0') break;
  }
  return found;
}

// Fixed-window per-IP rate limit. Returns true when the caller is over limit.
async function rateLimited(name, ip, windowSeconds, max) {
  const key = rlKey(name, ip);
  const [count, ttl] = await upipe([['INCR', key], ['TTL', key]]);
  if (Number(ttl) === -1) await ucmd('EXPIRE', key, String(windowSeconds));
  return Number(count) > max;
}

/* ---------------------------------------------------------------------------
 * Notification storage — saved-bill records, per-user notification ledgers,
 * and the global feed first-seen snapshot. All stateless (JSON values in
 * Upstash), matching the subscriptions design.
 * ------------------------------------------------------------------------- */

const savesKey = (emailHmac) => `lariat:saves:${emailHmac}`;
const notifKey = (emailHmac) => `lariat:notif:${emailHmac}`;
const FEED_SNAPSHOT_KEY = 'lariat:notif:feed';

// One scanned page of `lariat:sub:*` (or another prefix) records.
async function scanRecords(pattern, maxPages) {
  const found = [];
  let cursor = '0';
  for (let rounds = 0; rounds < maxPages; rounds += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [next, keys] = await ucmd('SCAN', cursor, 'MATCH', pattern, 'COUNT', '100');
    cursor = String(next);
    const list = Array.isArray(keys) ? keys : [];
    if (list.length) {
      // eslint-disable-next-line no-await-in-loop
      const [values] = await upipe([['MGET', ...list]]);
      for (const raw of Array.isArray(values) ? values : []) {
        try {
          const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : null;
          if (parsed && typeof parsed === 'object') found.push(parsed);
        } catch (error) { /* skip malformed */ }
      }
    }
    if (cursor === '0') break;
  }
  return found;
}

// Every subscription across every address (dispatch iterates all users).
async function listSubscriptions() {
  return scanRecords('lariat:sub:*', 100);
}

// Saved-bill record for an address (null when absent).
async function findSavesRecord(email) {
  const raw = await ucmd('GET', savesKey(emailLookupId(email)));
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

// Saved-bill record by HMAC index (for the profile-email move).
async function findSavesByHmac(emailHmac) {
  const raw = await ucmd('GET', savesKey(emailHmac));
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

async function saveSavesRecord(record) {
  await ucmd('SET', savesKey(record.emailHmac), JSON.stringify(record));
}

async function deleteSavesByHmac(emailHmac) {
  await ucmd('DEL', savesKey(emailHmac));
}

// Every saved-bill record (dispatch).
async function listSavesRecords() {
  return scanRecords('lariat:saves:*', 100);
}

// Per-user notification ledger: which industry bills were already announced
// and the last-notified fields of each saved bill. Null when the user has no
// ledger yet (callers treat that as an empty shape).
async function findNotifLedger(emailHmac) {
  const raw = await ucmd('GET', notifKey(emailHmac));
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      industrySeen: parsed.industrySeen && typeof parsed.industrySeen === 'object' ? parsed.industrySeen : {},
      savesVersions: parsed.savesVersions && typeof parsed.savesVersions === 'object' ? parsed.savesVersions : {},
    };
  } catch (error) {
    return null;
  }
}

async function saveNotifLedger(emailHmac, ledger) {
  await ucmd('SET', notifKey(emailHmac), JSON.stringify({
    industrySeen: ledger.industrySeen || {},
    savesVersions: ledger.savesVersions || {},
    updatedAt: new Date().toISOString(),
  }));
}

async function deleteNotifLedger(emailHmac) {
  await ucmd('DEL', notifKey(emailHmac));
}

// Global map of identifier -> first dispatch run that saw it. First run
// baselines every current bill so nobody is emailed about existing feed
// content.
async function getFeedSnapshot() {
  const raw = await ucmd('GET', FEED_SNAPSHOT_KEY);
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

async function saveFeedSnapshot(map) {
  await ucmd('SET', FEED_SNAPSHOT_KEY, JSON.stringify(map));
}

// Normalized bill identifier ("HB 295" style — same shape profile.js
// toggleBookmark accepts). Returns '' when the value is not a bill ID.
function normalizeBillId(value) {
  const clean = String(value || '').replace(/\s+/g, '').toUpperCase();
  if (!BILL_ID_PATTERN.test(clean)) return '';
  // Re-insert the canonical single space between letters and digits.
  return clean.replace(/^([A-Za-z]{2,4})(\d{1,4})$/, '$1 $2');
}

// Stable content version for update detection: only meaningful legislative
// fields. The AI summary changes iff the official text hash changes
// (summarize_bills.py skips re-summarizing otherwise), so the text hash
// covers summary churn.
function billVersion(bill) {
  const stable = [
    bill.status || '',
    bill.latest_action_description || '',
    bill.latest_action_date || '',
    bill.bill_text_hash || '',
  ].join('\n');
  return crypto.createHash('sha256').update(stable).digest('hex');
}

// Dispatch auth: the workflow sends `Authorization: Bearer $NOTIFICATIONS_SECRET`.
// Compares in constant time; false for any other shape.
function dispatchAuthorized(req) {
  if (!NOTIFICATIONS_SECRET) return false;
  const header = req.headers && req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (!match) return false;
  const received = Buffer.from(match[1].trim());
  const expected = Buffer.from(NOTIFICATIONS_SECRET);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

// Per-address send cooldown. Returns true when a send is too soon; otherwise
// records this send and returns false.
async function cooldownActive(email, industry) {
  const key = cdKey(pendingKey(email, industry));
  const set = await ucmd('SET', key, '1', 'EX', '60', 'NX');
  return set === null;
}

// Industries come from the deployed bill snapshot (bundled at deploy time),
// exactly like api/legislators/lookup.js does.
/* ---------------------------------------------------------------------------
 * Email (Brevo REST, same templates as server.js)
 * ------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function safeEmailSubject(value) {
  return String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 200);
}

function buildProfileFinalizeEmail({ code, expiryMinutes }) {
  return {
    subject: safeEmailSubject('Your Lariat email confirmation code'),
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #1c3a52;">
        <h1 style="font-size: 22px; margin: 0 0 14px;">Confirm your Lariat email</h1>
        <p style="font-size: 14px; line-height: 1.6;">You asked to use this address for your Lariat profile.</p>
        <p style="font-size: 14px; line-height: 1.6;">Your confirmation code is:</p>
        <p style="font-size: 30px; font-weight: bold; letter-spacing: 4px; margin: 12px 0;">${code}</p>
        <p style="font-size: 13px; color: #5a7285; line-height: 1.6;">
          This code expires in ${expiryMinutes} minutes and can only be used once.</p>
        <p style="font-size: 13px; color: #5a7285; line-height: 1.6;">
          If you did not request this, you can safely ignore this email.</p>
      </div>
    `,
  };
}

function buildProfileMovedEmail({ moved, oldEmails }) {
  const rows = moved.map((entry) => `
        <li style="font-size: 14px; line-height: 1.8;"><strong>${escapeHtml(entry.industry)}</strong>
          (was ${escapeHtml(entry.oldEmail)})</li>`).join('');
  return {
    subject: safeEmailSubject('Your Lariat subscription email was updated'),
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #1c3a52;">
        <h1 style="font-size: 22px; margin: 0 0 14px;">Your subscriptions moved</h1>
        <p style="font-size: 14px; line-height: 1.6;">You confirmed a new profile email, so these industry
          subscriptions (${oldEmails.map(escapeHtml).join(', ')}) now send to this address:</p>
        <ul style="margin: 12px 0; padding-left: 20px;">${rows}</ul>
        <p style="font-size: 13px; color: #5a7285; line-height: 1.6;">
          You can change the address for these updates anytime from your Lariat profile page.</p>
      </div>
    `,
  };
}

function buildProfileMovedNoticeEmail({ newEmail, moved }) {
  const rows = moved.map((entry) => `
        <li style="font-size: 14px; line-height: 1.8;"><strong>${escapeHtml(entry.industry)}</strong></li>`).join('');
  return {
    subject: safeEmailSubject('Your Lariat subscriptions were moved'),
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #1c3a52;">
        <h1 style="font-size: 22px; margin: 0 0 14px;">Heads up: subscription email changed</h1>
        <p style="font-size: 14px; line-height: 1.6;">Your Lariat industry subscriptions below now send to
          <strong>${escapeHtml(newEmail)}</strong> instead of this address.</p>
        <ul style="margin: 12px 0; padding-left: 20px;">${rows}</ul>
        <p style="font-size: 13px; color: #5a7285; line-height: 1.6;">
          If you did not make this change, reply to this email or contact Lariat right away.</p>
      </div>
    `,
  };
}

async function deliverEmail(email, { subject, html }) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      sender: { name: 'Lariat', email: BREVO_FROM_EMAIL },
      to: [{ email }],
      subject,
      htmlContent: html,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.message ? `${body.message}${body.code ? ` (${body.code})` : ''}` : `Brevo returned HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function sendProfileFinalizeEmail(email, { code, expiryMinutes }) {
  const { subject, html } = buildProfileFinalizeEmail({ code, expiryMinutes });
  return deliverEmail(email, { subject, html });
}

async function sendProfileMovedEmail(email, { moved, oldEmails }) {
  const { subject, html } = buildProfileMovedEmail({ moved, oldEmails });
  return deliverEmail(email, { subject, html });
}

async function sendProfileMovedNoticeEmail(email, { newEmail, moved }) {
  const { subject, html } = buildProfileMovedNoticeEmail({ newEmail, moved });
  return deliverEmail(email, { subject, html });
}

// Sent once per successful industry subscribe from the Your Saves page.
function buildSubscriptionConfirmationEmail({ industry, unsubscribeUrl }) {
  return {
    subject: safeEmailSubject(`You're subscribed to ${industry} updates on Lariat`),
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #1c3a52;">
        <h1 style="font-size: 22px; margin: 0 0 14px;">You're subscribed</h1>
        <p style="font-size: 14px; line-height: 1.6;">This address is now subscribed to
          <strong>${escapeHtml(industry)}</strong> updates on Lariat.</p>
        <p style="font-size: 14px; line-height: 1.6;">You'll get emails as Texas bills in this
          industry move through the legislature — saved to your Lariat profile feed.</p>
        <p style="font-size: 13px; color: #5a7285; line-height: 1.6;">
          Don't want these anymore? <a href="${escapeHtml(unsubscribeUrl)}" style="color: #1c6ea4;">Unsubscribe from ${escapeHtml(industry)}</a>
          (valid ${UNSUBSCRIBE_TOKEN_DAYS} days), or use the toggle on your Your Saves page.</p>
        <p style="font-size: 13px; color: #5a7285; line-height: 1.6;">
          If you did not subscribe to this industry, you can safely ignore this email.</p>
      </div>
    `,
  };
}

async function sendSubscriptionConfirmationEmail(email, { industry, unsubscribeUrl }) {
  const { subject, html } = buildSubscriptionConfirmationEmail({ industry, unsubscribeUrl });
  return deliverEmail(email, { subject, html });
}

// Sent once after the on-site Unsubscribe button actually removes a record.
// Best-effort: the unsubscribe is never rolled back when this fails, and the
// GET email-link path deliberately sends nothing so link scanners cannot
// trigger mail.
function buildUnsubscribeNoticeEmail({ industry, resubscribeUrl }) {
  return {
    subject: safeEmailSubject(`You've unsubscribed from ${industry} updates on Lariat`),
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #1c3a52;">
        <h1 style="font-size: 22px; margin: 0 0 14px;">You're unsubscribed</h1>
        <p style="font-size: 14px; line-height: 1.6;">This address is no longer subscribed to
          <strong>${escapeHtml(industry)}</strong> updates on Lariat.</p>
        <p style="font-size: 14px; line-height: 1.6;">You won't receive industry emails for
          ${escapeHtml(industry)} anymore.</p>
        <p style="font-size: 13px; color: #5a7285; line-height: 1.6;">
          Changed your mind? Resubscribe anytime from your
          <a href="${escapeHtml(resubscribeUrl)}" style="color: #1c6ea4;">Your Saves page</a>.</p>
        <p style="font-size: 13px; color: #5a7285; line-height: 1.6;">
          If you did not unsubscribe, resubscribe from Your Saves or safely ignore this email.</p>
      </div>
    `,
  };
}

async function sendUnsubscribeNoticeEmail(email, { industry, resubscribeUrl }) {
  const { subject, html } = buildUnsubscribeNoticeEmail({ industry, resubscribeUrl });
  return deliverEmail(email, { subject, html });
}

/* ---------------------------------------------------------------------------
 * Notification digest (one email per user per dispatch run)
 * ------------------------------------------------------------------------- */

function oneLine(value, max) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

// newBills: [{ bill, industry, unsubscribeUrl }] grouped in the template by
//   industry (bills the user's industry subscriptions matched, first time).
// savedUpdates: [{ bill, changes: [string, ...] }] for synced saved bills whose
//   version hash moved since the last notified version.
function buildNotificationDigestEmail({ siteUrl, newBills, savedUpdates }) {
  const feedUrl = `${siteUrl}/feed.html`;
  const yourSavesUrl = `${siteUrl}/your-bills.html`;
  const profileUrl = `${siteUrl}/profile.html`;

  const industrySections = [];
  const byIndustry = new Map();
  for (const entry of newBills) {
    if (!byIndustry.has(entry.industry)) byIndustry.set(entry.industry, []);
    byIndustry.get(entry.industry).push(entry);
  }
  for (const [industry, entries] of byIndustry) {
    const billsHtml = entries.map(({ bill }) => `
          <li style="font-size: 14px; line-height: 1.7; margin: 0 0 14px;">
            <strong>${escapeHtml(bill.identifier)} — ${escapeHtml(oneLine(bill.title, 120))}</strong><br>
            <span style="font-size: 13px; color: #5a7285;">${escapeHtml(oneLine(bill.summary, 220))}</span><br>
            <a href="${escapeHtml(feedUrl)}" style="color: #1c6ea4;">View in your feed</a>
            · <a href="${escapeHtml(bill.source_url || feedUrl)}" style="color: #1c6ea4;">Official bill page</a>
          </li>`).join('');
    const unsubscribeUrl = entries.find((entry) => entry.unsubscribeUrl)?.unsubscribeUrl || '';
    const footer = unsubscribeUrl
      ? `<p style="font-size: 12px; color: #5a7285; line-height: 1.6;">No longer interested?
          <a href="${escapeHtml(unsubscribeUrl)}" style="color: #1c6ea4;">Unsubscribe from ${escapeHtml(industry)} updates</a>.</p>`
      : '';
    industrySections.push(`
        <h2 style="font-size: 16px; margin: 22px 0 8px;">New in ${escapeHtml(industry)}</h2>
        <ul style="margin: 0; padding-left: 18px;">${billsHtml}</ul>
        ${footer}`);
  }

  const savedHtml = (savedUpdates || []).map(({ bill, changes }) => `
          <li style="font-size: 14px; line-height: 1.7; margin: 0 0 14px;">
            <strong>${escapeHtml(bill.identifier)} — ${escapeHtml(oneLine(bill.title, 120))}</strong><br>
            ${changes.map((change) => `<span style="font-size: 13px; color: #5a7285;">${escapeHtml(change)}</span><br>`).join('')}
            <a href="${escapeHtml(feedUrl)}" style="color: #1c6ea4;">View in your feed</a>
            · <a href="${escapeHtml(bill.source_url || feedUrl)}" style="color: #1c6ea4;">Official bill page</a>
          </li>`).join('');
  const savedSection = savedHtml
    ? `
        <h2 style="font-size: 16px; margin: 22px 0 8px;">Updates to your saved bills</h2>
        <ul style="margin: 0; padding-left: 18px;">${savedHtml}</ul>
        <p style="font-size: 12px; color: #5a7285; line-height: 1.6;">Remove a bill from
          <a href="${escapeHtml(yourSavesUrl)}" style="color: #1c6ea4;">Your Saves</a> to stop its update alerts.</p>`
    : '';

  const newCount = newBills.length;
  const updateCount = (savedUpdates || []).length;
  const subject = newCount && updateCount
    ? `Lariat bill alerts: ${newCount} new · ${updateCount} update${updateCount === 1 ? '' : 's'}`
    : newCount
      ? `${newCount} new bill${newCount === 1 ? '' : 's'} in your subscribed industr${newCount === 1 ? 'y' : 'ies'}`
      : `Update${updateCount === 1 ? '' : 's'} to your saved bills on Lariat`;

  return {
    subject: safeEmailSubject(subject),
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #1c3a52;">
        <h1 style="font-size: 22px; margin: 0 0 14px;">Your Lariat bill alerts</h1>
        <p style="font-size: 14px; line-height: 1.6;">Here's what moved since your last alert.</p>
        ${industrySections.join('')}
        ${savedSection}
        <p style="font-size: 12px; color: #5a7285; line-height: 1.7; margin-top: 24px;">
          Manage <a href="${escapeHtml(yourSavesUrl)}" style="color: #1c6ea4;">subscriptions and saved bills</a>
          or update your <a href="${escapeHtml(profileUrl)}" style="color: #1c6ea4;">profile email</a>.</p>
      </div>
    `,
  };
}

async function sendNotificationDigest(email, options) {
  const { subject, html } = buildNotificationDigestEmail(options);
  return deliverEmail(email, { subject, html });
}

/* ---------------------------------------------------------------------------
 * HTTP helpers (same shapes as the existing api/ functions)
 * ------------------------------------------------------------------------- */

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendErr(res, status, message, code, extra) {
  sendJson(res, status, { ok: false, error: String(message), code, ...(extra || {}) });
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    req.on('data', (chunk) => {
      if (finished) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buf.length;
      if (size > maxBytes) {
        finished = true;
        const error = new Error('Request body too large.');
        error.status = 413;
        reject(error);
        req.resume();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    });
  });
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = typeof req.body === 'string' && req.body ? req.body : await readRawBody(req, 100_000);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const invalid = new Error('Invalid request body.');
    invalid.status = 400;
    throw invalid;
  }
}

function clientIp(req) {
  const forwarded = req.headers && typeof req.headers['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : '';
  if (forwarded) return forwarded;
  if (req.headers && typeof req.headers['x-real-ip'] === 'string' && req.headers['x-real-ip']) {
    return req.headers['x-real-ip'];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function baseUrl(req) {
  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
  const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';
  return `${proto}://${String(host).split(',')[0].trim()}`;
}

module.exports = {
  MAX_EMAIL_LENGTH,
  MAX_INDUSTRY_LENGTH,
  EMAIL_PATTERN,
  CODE_PATTERN,
  CODE_EXPIRY_MINUTES,
  VERIFY_MAX_ATTEMPTS,
  PROFILE_EMAIL_PURPOSE,
  INDUSTRY_LIST,
  UNSUBSCRIBE_TOKEN_DAYS,
  requireCore,
  requireEmail,
  upipe,
  ucmd,
  subKey,
  pendKey,
  emailLookupId,
  makeEmailFields,
  hashCode,
  codeMatches,
  generateCode,
  signToken,
  verifyToken,
  makeUnsubscribeToken,
  pendingKey,
  findPending,
  savePending,
  deletePending,
  bumpPendingAttempts,
  saveSubscription,
  findSubscription,
  deleteSubscription,
  findSubscriptionsByHmac,
  listSubscriptions,
  findSavesRecord,
  findSavesByHmac,
  saveSavesRecord,
  deleteSavesByHmac,
  listSavesRecords,
  findNotifLedger,
  saveNotifLedger,
  deleteNotifLedger,
  getFeedSnapshot,
  saveFeedSnapshot,
  normalizeBillId,
  billVersion,
  dispatchAuthorized,
  MAX_SAVED_BILLS,
  NOTIFICATIONS_FEED_URL,
  storedEmail,
  rateLimited,
  cooldownActive,
  escapeHtml,
  sendProfileFinalizeEmail,
  sendProfileMovedEmail,
  sendProfileMovedNoticeEmail,
  sendSubscriptionConfirmationEmail,
  sendUnsubscribeNoticeEmail,
  sendNotificationDigest,
  sendJson,
  sendErr,
  readJsonBody,
  clientIp,
  baseUrl,
};
