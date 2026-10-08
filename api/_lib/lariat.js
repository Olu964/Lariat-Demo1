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
  pendingKey,
  findPending,
  savePending,
  deletePending,
  bumpPendingAttempts,
  saveSubscription,
  findSubscriptionsByHmac,
  rateLimited,
  cooldownActive,
  escapeHtml,
  sendProfileFinalizeEmail,
  sendProfileMovedEmail,
  sendProfileMovedNoticeEmail,
  sendJson,
  sendErr,
  readJsonBody,
  clientIp,
  baseUrl,
};
