#!/usr/bin/env node
'use strict';

/*
 * Lariat local backend
 * ====================
 * A zero-dependency Node.js server (Node 18+; no `npm install` required).
 *
 * It does two things:
 *
 *   1. Serves the active Lariat frontend from the repository root so the whole
 *      site runs from one command:  node server/server.js  →  http://127.0.0.1:3000
 *
 *   2. Provides the profile-email API that the frontend calls:
 *
 *        POST /api/profile/email/request   { email }
 *        POST /api/profile/email/verify    { email, code, oldEmails[] }
 *        GET  /api/health
 *
 * Email is sent through Brevo (https://www.brevo.com) when BREVO_API_KEY is
 * set. Brevo verifies a sender address by email (no domain required), so any
 * recipient can be reached on the free plan (300 emails/day). Without a key
 * the server runs in "console mode": verification codes and unsubscribe links
 * are printed to the terminal instead of emailed, so the entire flow can be
 * tested for free before any account is created.
 *
 * Safety properties (see EMAIL_SUBSCRIPTION_SETUP.md):
 *   - Binds to 127.0.0.1 only, so it is unreachable from the internet.
 *   - Verification codes are stored as salted scrypt hashes, never plaintext.
 *   - Codes expire (default 10 minutes) and allow a limited number of attempts.
 *   - Email requests are rate-limited per IP and per address.
 *   - The API never reveals whether an address is already subscribed.
 *   - Subscriptions are persisted to server/data/subscriptions.json, outside
 *     the public web folder.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { URL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = ROOT;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'subscriptions.json');
const BILL_DATA_FILE = process.env.LARIAT_DATA_FILE
  || path.join(PUBLIC_DIR, 'texas_bill_summaries.json');

/* ---------------------------------------------------------------------------
 * Environment (.env parser  -  tiny, no dependency)
 * ------------------------------------------------------------------------- */

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    // Do not override real environment variables; .env is the fallback.
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ALLOW_NETWORK_BIND = process.env.ALLOW_NETWORK_BIND === 'true';

function normalizeHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL || '';
const OPEN_STATES_API_KEY = process.env.OPEN_STATES_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.SUMMARIZER_MODEL || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_HOSTS || '127.0.0.1,localhost,::1')
  .split(',').map(normalizeHostname).filter(Boolean));
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '')
  .split(',').map((value) => {
    try { return new URL(value.trim()).origin; } catch (error) { return ''; }
  }).filter(Boolean));
const CODE_EXPIRY_MINUTES = Math.min(24 * 60, Math.max(1, Number(process.env.SUBSCRIPTION_CODE_EXPIRY_MINUTES) || 10));
const CODE_EXPIRY_MS = CODE_EXPIRY_MINUTES * 60 * 1000;
const REQUEST_COOLDOWN_MS = 60 * 1000;          // min time between codes for one address
const VERIFY_MAX_ATTEMPTS = 5;                   // wrong-code tries before the code is voided
const PROFILE_EMAIL_PURPOSE = '__profile_email__'; // sentinel "industry" for profile-finalize codes
const IP_RATE_LIMIT = { windowMs: 60 * 60 * 1000, max: 10 }; // /request calls per IP per hour

/* Email encryption at rest (AES-256-GCM, Node built-in, no dependency).
 * SUBSCRIPTION_DATA_KEY is 64 hex characters (32 bytes). When set, every
 * email persisted in subscriptions.json is stored encrypted; lookups use a
 * separate HMAC index so records can be found without decrypting the file.
 * When unset (local development), emails are stored in plaintext and the
 * server says so on startup; production refuses to start without a key. */
const DATA_KEY = (() => {
  const hex = (process.env.SUBSCRIPTION_DATA_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
})();
const EMAIL_HMAC_KEY = DATA_KEY
  ? crypto.createHash('sha256').update(DATA_KEY).update(':email-lookup-v1').digest()
  : null;

function emailLookupId(email) {
  const lowered = String(email || '').toLowerCase();
  if (!EMAIL_HMAC_KEY) return lowered;
  return `hmac:${crypto.createHmac('sha256', EMAIL_HMAC_KEY).update(lowered).digest('hex')}`;
}

function encryptEmail(email) {
  if (!DATA_KEY) return null;
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

// Plaintext address for a stored record: legacy `email` field, or the
// decrypted `emailEnc` field. Null when the record is encrypted and no data
// key is configured (or the ciphertext was tampered with).
function storedEmail(record) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.email === 'string') return record.email;
  return decryptEmail(record.emailEnc);
}

// True when `record` belongs to `email`. Prefers the HMAC index (works
// without decrypting); falls back to a plaintext comparison for legacy
// records when no data key is configured.
function recordMatchesEmail(record, email) {
  if (!record || typeof record !== 'object') return false;
  const lowered = String(email || '').toLowerCase();
  if (typeof record.emailHmac === 'string') return record.emailHmac === emailLookupId(email);
  const stored = storedEmail(record);
  return typeof stored === 'string' && stored.toLowerCase() === lowered;
}

// Storage-ready email fields for a new record: encrypted + indexed when a
// data key is configured, plaintext legacy shape otherwise.
function makeEmailFields(email) {
  const clean = String(email);
  if (!DATA_KEY) return { email: clean };
  return { emailEnc: encryptEmail(clean), emailHmac: emailLookupId(clean) };
}

function isValidEmailEnc(value) {
  return !!value && typeof value === 'object' && value.v === 1
    && typeof value.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(value.iv)
    && typeof value.data === 'string' && /^[A-Za-z0-9_-]{1,400}$/.test(value.data)
    && typeof value.tag === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value.tag);
}

function isValidEmailHmac(value) {
  return typeof value === 'string'
    && (/^hmac:[0-9a-f]{64}$/.test(value) || (value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value)));
}

const MAX_EMAIL_LENGTH = 254;
const MAX_INDUSTRY_LENGTH = 200;
const MAX_REQUEST_URL_LENGTH = 8 * 1024;
const IS_PRODUCTION = NODE_ENV === 'production';

/* Security headers applied to every response. */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
};

// In production the site is served only over HTTPS behind the reverse proxy;
// advertise HSTS so browsers refuse plain-HTTP connections to the public host.
if (IS_PRODUCTION) {
  SECURITY_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
}

/* The API is only meant to be called from pages served from the same machine
 * (the backend on :3000, or a local dev server on any port), so CORS replies
 * are restricted to loopback origins. Every other origin gets no CORS headers:
 * the browser then refuses cross-origin reads and (for JSON POSTs, which need
 * a preflight) refuses the request entirely  -  so malicious websites cannot
 * drive this local server through a visitor's browser. */
function trustedOrigin(origin) {
  if (!origin) return '';
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const hostname = normalizeHostname(url.hostname);
    const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
    return (((!IS_PRODUCTION && isLoopback) || ALLOWED_ORIGINS.has(url.origin))) ? origin : '';
  } catch (error) {
    return '';
  }
}

function hostnameFromHostHeader(hostHeader) {
  const host = String(hostHeader || '').trim();
  if (!host) return '';
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    return normalizeHostname(parsed.hostname);
  } catch (error) {
    return '';
  }
}

/* Host-header check: blocks DNS rebinding, where a malicious site points one
 * of its own domains at 127.0.0.1 and asks the browser to connect there with
 * the attacker's domain in the Host header. Only explicitly configured hosts
 * are accepted, including when the server is bound to a non-loopback address.
 */
function isTrustedHost(hostHeader) {
  const hostname = hostnameFromHostHeader(hostHeader);
  return Boolean(hostname && ALLOWED_HOSTS.has(hostname));
}

/* Production runs behind a TLS-terminating proxy, so requests arrive on
 * loopback as plain HTTP and the proxy reports the real scheme in the
 * X-Forwarded-Proto header. Enforce HTTPS-only: only an explicit forwarded
 * HTTPS request is accepted; plain HTTP and missing/malformed proxy scheme
 * headers redirect to the configured HTTPS origin. The query string is
 * preserved so unsubscribe links keep working; nothing here is logged. */
function enforceHttps(req, res, url) {
  if (!IS_PRODUCTION) return false;
  const scheme = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (scheme === 'https') return false;
  // Build the redirect from the configured public origin rather than the
  // request Host header. This prevents an alternate allowlisted host from
  // influencing passwordless unsubscribe links or cacheable redirects.
  const target = new URL(PUBLIC_BASE_URL);
  target.pathname = url.pathname;
  target.search = url.search;
  target.hash = '';
  res.writeHead(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, {
    Location: target.href,
    ...SECURITY_HEADERS,
  });
  res.end();
  return true;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^[0-9]{6}$/;

function validateConfiguration() {
  if (!BREVO_API_KEY && BREVO_FROM_EMAIL) {
    throw new Error('BREVO_FROM_EMAIL requires BREVO_API_KEY, or remove the sender address.');
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const isLoopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(normalizeHostname(HOST));
  if (!isLoopbackHost) {
    if (!ALLOW_NETWORK_BIND) {
      throw new Error('HOST must bind to loopback by default. Set ALLOW_NETWORK_BIND=true only for an intentional protected network deployment.');
    }
  }
  if (IS_PRODUCTION) {
    if (!isLoopbackHost) {
      throw new Error('Production HOST must bind to loopback behind a trusted TLS reverse proxy.');
    }
    if (!DATA_KEY) {
      throw new Error('Production requires SUBSCRIPTION_DATA_KEY (64 hex characters) so stored emails are encrypted at rest.');
    }
    if (!BREVO_API_KEY || !EMAIL_PATTERN.test(BREVO_FROM_EMAIL)) {
      throw new Error('Production requires BREVO_API_KEY and a valid verified BREVO_FROM_EMAIL.');
    }
    if (!PUBLIC_BASE_URL) {
      throw new Error('Production requires PUBLIC_BASE_URL, including the https:// scheme.');
    }
    let publicUrl;
    try { publicUrl = new URL(PUBLIC_BASE_URL); } catch (error) { publicUrl = null; }
    if (!publicUrl || publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password
      || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
      throw new Error('Production PUBLIC_BASE_URL must be a clean https:// origin without credentials, path, or query parameters.');
    }
    if (!ALLOWED_HOSTS.has(normalizeHostname(publicUrl.hostname))) {
      throw new Error('Production PUBLIC_BASE_URL hostname must be included in ALLOWED_HOSTS.');
    }
  }
}
validateConfiguration();

/* ---------------------------------------------------------------------------
 * Data store (server/data/subscriptions.json)
 * ------------------------------------------------------------------------- */

function defaultData() {
  return { subscriptions: [], pendingCodes: [] };
}

function loadData() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return defaultData();
    throw new Error(`Could not read subscription data safely: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Could not read subscription data safely: expected a JSON object');
  }
  return {
    // Ignore malformed records rather than allowing corrupted local data to
    // turn a normal subscription request into a server error. Stored values
    // are still bounded because this file contains user-controlled email data.
    // Records are accepted in two shapes: legacy plaintext (`email`) and
    // encrypted (`emailEnc` + `emailHmac`). Legacy records are upgraded to
    // the encrypted shape on load when a data key is configured.
    subscriptions: Array.isArray(parsed.subscriptions)
      ? parsed.subscriptions.filter((subscription) => subscription
        && typeof subscription.industry === 'string'
        && subscription.industry.length <= MAX_INDUSTRY_LENGTH
        && ((typeof subscription.email === 'string'
          && subscription.email.length <= MAX_EMAIL_LENGTH
          && EMAIL_PATTERN.test(subscription.email))
          || (isValidEmailEnc(subscription.emailEnc) && isValidEmailHmac(subscription.emailHmac))))
        .map((subscription) => ({
          ...(typeof subscription.email === 'string' ? { email: subscription.email } : {}),
          ...(isValidEmailEnc(subscription.emailEnc)
            ? {
              emailEnc: {
                v: 1, iv: subscription.emailEnc.iv, data: subscription.emailEnc.data, tag: subscription.emailEnc.tag,
              },
            }
            : {}),
          ...(isValidEmailHmac(subscription.emailHmac) ? { emailHmac: subscription.emailHmac } : {}),
          industry: subscription.industry,
          ...(typeof subscription.verifiedAt === 'string' ? { verifiedAt: subscription.verifiedAt } : {}),
          ...(typeof subscription.source === 'string' ? { source: subscription.source } : {}),
        }))
      : [],
    // Discard records from the pre-scrypt format rather than retaining
    // weakly protected six-digit verification hashes. Validate every field
    // used by the verification path before it enters the in-memory store.
    pendingCodes: Array.isArray(parsed.pendingCodes)
      ? parsed.pendingCodes.filter((pending) => pending
        && typeof pending.key === 'string' && pending.key.length <= MAX_EMAIL_LENGTH + MAX_INDUSTRY_LENGTH + 2
        && ((typeof pending.email === 'string' && pending.email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(pending.email))
          || (isValidEmailEnc(pending.emailEnc) && isValidEmailHmac(pending.emailHmac)))
        && typeof pending.industry === 'string' && pending.industry.length <= MAX_INDUSTRY_LENGTH
        && typeof pending.salt === 'string' && /^[0-9a-f]{32}$/i.test(pending.salt)
        && typeof pending.codeHash === 'string' && /^scrypt\$[0-9a-f]{64}$/i.test(pending.codeHash)
        && Number.isFinite(Number(pending.expiresAt))
        && Number.isInteger(Number(pending.attempts)) && Number(pending.attempts) >= 0 && Number(pending.attempts) <= VERIFY_MAX_ATTEMPTS)
        .map((pending) => ({
          key: pending.key,
          ...(typeof pending.email === 'string' ? { email: pending.email } : {}),
          ...(isValidEmailEnc(pending.emailEnc)
            ? {
              emailEnc: {
                v: 1, iv: pending.emailEnc.iv, data: pending.emailEnc.data, tag: pending.emailEnc.tag,
              },
            }
            : {}),
          ...(isValidEmailHmac(pending.emailHmac) ? { emailHmac: pending.emailHmac } : {}),
          industry: pending.industry,
          salt: pending.salt,
          codeHash: pending.codeHash,
          expiresAt: pending.expiresAt,
          attempts: pending.attempts,
          ...(typeof pending.createdAt === 'string' ? { createdAt: pending.createdAt } : {}),
        }))
      : [],
  };
}

function saveData(store) {
  // The file holds subscriber emails and token-generation identifiers: keep
  // it and its directory readable only by the user running the server.
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DATA_DIR, 0o700);
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.chmodSync(tmpFile, 0o600);
  fs.renameSync(tmpFile, DATA_FILE);
}

const store = loadData();

// One-time upgrade: records written before email encryption existed are
// encrypted in place the first time a data key is configured, then saved.
if (DATA_KEY) {
  let upgraded = false;
  for (const record of [...store.subscriptions, ...store.pendingCodes]) {
    if (typeof record.email === 'string' && EMAIL_PATTERN.test(record.email)) {
      const fields = makeEmailFields(record.email);
      delete record.email;
      Object.assign(record, fields);
      upgraded = true;
    }
  }
  if (upgraded) saveData(store);
}

function pruneExpiredPendingCodes() {
  const now = Date.now();
  const remaining = store.pendingCodes.filter((pending) => pending && Number(pending.expiresAt) > now);
  if (remaining.length !== store.pendingCodes.length) {
    store.pendingCodes = remaining;
    saveData(store);
  }
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/* Verification codes are hashed with asynchronous scrypt (memory-hard, built
 * into Node  -  no dependency) so a leaked data file cannot be brute-forced
 * offline and code requests do not block the event loop. */
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

function baseUrl() {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return `http://${HOST}:${PORT}`;
}

const pendingKey = (email, industry) => `${emailLookupId(email)}::${industry}`;

function findPending(email, industry) {
  const key = pendingKey(email, industry);
  return store.pendingCodes.find((pending) => pending.key === key) || null;
}

/* ---------------------------------------------------------------------------
 * Email (Brevo REST API  -  uses global fetch, so no SDK needed)
 * ------------------------------------------------------------------------- */

function safeEmailSubject(value) {
  return String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 200);
}

/**
 * Sends an email through Brevo. When BREVO_API_KEY is missing, falls back to
 * console mode: prints the subject and the important line (code / link) to the
 * terminal so the flow can be tested before any account is created.
 */
async function deliverEmail(email, { subject, html, consoleText }) {
  if (!BREVO_API_KEY) {
    console.log(`\n[console mode] ${subject}\n  to: ${email}\n  ${consoleText}\n`);
    return { consoleMode: true };
  }
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

async function sendProfileFinalizeEmail(email, { code, expiryMinutes }) {
  const { subject, html } = buildProfileFinalizeEmail({ code, expiryMinutes });
  return deliverEmail(email, { subject, html, consoleText: `profile finalize code: ${code} (valid ${expiryMinutes} min)` });
}

async function sendProfileMovedEmail(email, { moved, oldEmails }) {
  const { subject, html } = buildProfileMovedEmail({ moved, oldEmails });
  return deliverEmail(email, {
    subject,
    html,
    consoleText: `profile email moved ${moved.length} subscription(s); unsubscribe: ${moved.map((entry) => entry.unsubscribeUrl).join(' ')}`,
  });
}

async function sendProfileMovedNoticeEmail(email, { newEmail, moved }) {
  const { subject, html } = buildProfileMovedNoticeEmail({ newEmail, moved });
  return deliverEmail(email, { subject, html, consoleText: `subscriptions moved to ${newEmail}` });
}

/* ---------------------------------------------------------------------------
 * HTTP plumbing
 * ------------------------------------------------------------------------- */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* Compresses text bodies with gzip when the client asks for it, so pages and
 * assets download faster. Used for every response below. */
function sendBody(res, status, headers, body) {
  const req = res.req || {};
  const acceptsGzip = /(?:^|,)\s*gzip(?:\s*;|\s*,|\s*$)/i.test(String((req.headers && req.headers['accept-encoding']) || ''));
  if (acceptsGzip && body.length > 512) {
    const compressed = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = headers.Vary ? `${headers.Vary}, Accept-Encoding` : 'Accept-Encoding';
    headers['Content-Length'] = compressed.length;
    res.writeHead(status, headers);
    return res.end(compressed);
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

/* Adds CORS headers only for loopback origins or exact configured production
 * origins. Every other origin gets none, so the browser refuses cross-origin
 * reads and, for JSON requests, the preflight as well. */
function corsHeadersFor(req) {
  const origin = trustedOrigin(req && req.headers && req.headers.origin);
  if (!origin) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
}

const sendJson = (res, status, payload) => {
  sendBody(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...corsHeadersFor(res.req),
  }, Buffer.from(JSON.stringify(payload)));
};

const sendText = (res, status, contentType, body, extraHeaders = {}) => {
  sendBody(res, status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...corsHeadersFor(res.req),
    ...extraHeaders,
  }, Buffer.from(body));
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

/* Small branded HTML page for email-link flows (e.g. unsubscribe). */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    req.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > 100_000) {
        finished = true;
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('Request body must be a JSON object'), { status: 400 }));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(Object.assign(new Error('Request body must be valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  // The server only binds to 127.0.0.1, so this is a formality; keep it simple.
  return req.socket.remoteAddress || 'unknown';
}

/* Sliding-window per-key rate limiter. Entries are pruned on a timer so the
 * maps cannot grow without bound on a long-running server. */
function makeRateLimiter(windowMs, max) {
  const hits = new Map();
  const limiter = (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.startedAt > windowMs) {
      hits.set(key, { startedAt: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  };
  limiter.prune = (now = Date.now()) => {
    for (const [key, entry] of hits) {
      if (now - entry.startedAt > windowMs) hits.delete(key);
    }
  };
  return limiter;
}

const requestRateLimiter = makeRateLimiter(IP_RATE_LIMIT.windowMs, IP_RATE_LIMIT.max);  // /request calls per IP per hour
const verifyRateLimiter = makeRateLimiter(60 * 60 * 1000, 25);                           // /verify calls per IP per hour
const legislatorRateLimiter = makeRateLimiter(60 * 60 * 1000, 30);                         // legislator lookups per IP per hour
const chatRateLimiter = makeRateLimiter(60 * 60 * 1000, 40);                                // chatbot questions per IP per hour
// Bump this whenever chatbot behavior changes; surfaced via /api/health so a
// stale local server is trivially detectable.
const CHATBOT_ENGINE_VERSION = 13;

const requestCooldowns = new Map(); // email::industry -> last request time
function cooldownActive(email, industry) {
  const key = pendingKey(email, industry);
  const last = requestCooldowns.get(key);
  const now = Date.now();
  if (!last || now - last >= REQUEST_COOLDOWN_MS) {
    requestCooldowns.set(key, now);
    return false;
  }
  return true;
}

// Periodic cleanup of rate-limiter and cooldown maps (keeps memory bounded).
setInterval(() => {
  requestRateLimiter.prune();
  verifyRateLimiter.prune();
  legislatorRateLimiter.prune();
  chatRateLimiter.prune();
  const now = Date.now();
  for (const [key, last] of requestCooldowns) {
    if (now - last >= REQUEST_COOLDOWN_MS * 2) requestCooldowns.delete(key);
  }
}, 60 * 60 * 1000).unref();

/* ---------------------------------------------------------------------------
 * Legislator lookup
 * ------------------------------------------------------------------------- */

const CENSUS_GEOCODER_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const CENSUS_ZCTA_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/11/query';
const CENSUS_GEOGRAPHIES_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';
const OPEN_STATES_GEO_URL = 'https://v3.openstates.org/people.geo';
const OPEN_STATES_BILL_URL = 'https://v3.openstates.org/bills';
const OPEN_STATES_COMMITTEES_URL = 'https://v3.openstates.org/committees';
const COMMITTEES_CACHE_TTL_MS = 60 * 60 * 1000;
const LEGISLATOR_CACHE_FILE = path.join(DATA_DIR, 'legislator-lookups.json');
const LEGISLATOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ADDRESS_LENGTH = 240;
const ZIP_PATTERN = /^\d{5}(?:-\d{4})?$/;
const TEXAS_STATE_BOUNDS = { minLat: 25.8, maxLat: 36.6, minLng: -106.7, maxLng: -93.4 };
const legislatorInFlight = new Map();

function cachedLegislatorsAreUsable(legislators) {
  return Array.isArray(legislators)
    && legislators.length === 2
    && ['Senate', 'House'].every((chamber) => legislators.some((person) => person?.chamber === chamber))
    && legislators.every((person) => person && typeof person.name === 'string'
      && person.chamber && typeof person.district === 'string'
      && person.district !== 'Texas'
      && typeof person.votingHistoryStatus === 'string'
      && Array.isArray(person.votingHistory)
      && typeof person.committeesStatus === 'string'
      && Array.isArray(person.committees)
      && typeof person.sponsoredBillsStatus === 'string'
      && Array.isArray(person.sponsoredBills)
      && Array.isArray(person.leadershipRoles)
      && person.votingPattern && typeof person.votingPattern === 'object'
      && !Object.prototype.hasOwnProperty.call(person, 'email')
      && !Object.prototype.hasOwnProperty.call(person, 'links')
      && !Object.prototype.hasOwnProperty.call(person, 'offices'));
}

function loadLegislatorCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEGISLATOR_CACHE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => /^.{1,240}$/.test(key)
      && value && typeof value === 'object' && Number.isFinite(Number(value.cachedAt))
      && cachedLegislatorsAreUsable(value.legislators)));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read legislator cache:', error.message);
    return {};
  }
}

const legislatorCache = loadLegislatorCache();

function saveLegislatorCache() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmpFile = `${LEGISLATOR_CACHE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(legislatorCache, null, 2) + '\n', 'utf8');
  fs.chmodSync(tmpFile, 0o600);
  fs.renameSync(tmpFile, LEGISLATOR_CACHE_FILE);
}

function lookupError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function sanitizedLookupInput(value) {
  return String(value || '').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cacheKeyForAddress(address) {
  return sanitizedLookupInput(address).toLowerCase();
}

function isZipAddress(address) {
  return ZIP_PATTERN.test(address);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw lookupError(502, 'upstream_error', `Lookup service returned HTTP ${response.status}`);
  if (!body || typeof body !== 'object') throw lookupError(502, 'upstream_error', 'Lookup service returned an invalid response');
  return body;
}

async function geocodeFullAddress(address) {
  const url = new URL(CENSUS_GEOCODER_URL);
  url.searchParams.set('address', address);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('format', 'json');
  const body = await fetchJson(url);
  const match = body.result?.addressMatches?.[0];
  const longitude = Number(match?.coordinates?.x);
  const latitude = Number(match?.coordinates?.y);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw lookupError(404, 'not_geocoded', 'We could not geocode that address.');
  }
  return { latitude, longitude, matchedAddress: typeof match.matchedAddress === 'string' ? match.matchedAddress : address };
}

async function geocodeZip(zip) {
  // The Census Geocoder requires a structure number for address searches. For
  // ZIP-only fallback, use the Census Bureau TIGERweb ZCTA centroid, then
  // verify the resulting point with Census geographic lookup below.
  const url = new URL(CENSUS_ZCTA_URL);
  url.searchParams.set('where', `ZCTA5='${zip.slice(0, 5)}'`);
  url.searchParams.set('outFields', 'CENTLAT,CENTLON');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('f', 'json');
  const body = await fetchJson(url);
  const attributes = body.features?.[0]?.attributes;
  const latitude = Number(attributes?.CENTLAT);
  const longitude = Number(attributes?.CENTLON);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw lookupError(404, 'not_geocoded', 'We could not geocode that ZIP code.');
  }
  return { latitude, longitude, matchedAddress: `ZIP ${zip.slice(0, 5)}` };
}

async function isTexasCoordinate(latitude, longitude) {
  if (latitude < TEXAS_STATE_BOUNDS.minLat || latitude > TEXAS_STATE_BOUNDS.maxLat
    || longitude < TEXAS_STATE_BOUNDS.minLng || longitude > TEXAS_STATE_BOUNDS.maxLng) return false;
  const url = new URL(CENSUS_GEOGRAPHIES_URL);
  url.searchParams.set('x', String(longitude));
  url.searchParams.set('y', String(latitude));
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('vintage', 'Current_Current');
  url.searchParams.set('layers', 'States');
  url.searchParams.set('format', 'json');
  const body = await fetchJson(url);
  return body.result?.geographies?.States?.some((state) => state.STUSAB === 'TX' || state.NAME === 'Texas') === true;
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (error) { return ''; }
}

function normalizeLegislator(person) {
  const role = person && typeof person.current_role === 'object' ? person.current_role : {};
  const orgClassification = firstString(role.org_classification, role.classification).toLowerCase();
  const title = firstString(role.title).toLowerCase();
  const chamber = orgClassification === 'upper' || title.includes('senat') ? 'Senate'
    : orgClassification === 'lower' || title.includes('represent') ? 'House' : '';
  if (!chamber) return null;

  // people.geo can include federal officeholders at a coordinate. Require an
  // explicit Texas state-legislature jurisdiction or state legislative-district
  // division so a U.S. senator cannot be presented as a Texas state senator.
  const jurisdiction = person.jurisdiction;
  const jurisdictionId = firstString(
    typeof jurisdiction === 'string' ? jurisdiction : jurisdiction?.id,
    typeof jurisdiction === 'object' ? jurisdiction?.name : '',
  ).toLowerCase();
  const divisionId = firstString(role.division_id, person.division_id).toLowerCase();
  const isTexasStateJurisdiction = jurisdictionId.includes('texas')
    || jurisdictionId.includes('state:tx');
  const isStateLegislativeDivision = divisionId.includes('/sldl:') || divisionId.includes('/sldu:');
  if (!isTexasStateJurisdiction && !isStateLegislativeDivision) return null;

  return {
    personId: firstString(person.id),
    name: firstString(person.name) || 'Name unavailable',
    chamber,
    party: firstString(person.party) || 'Party not listed',
    district: role.district === null || role.district === undefined ? '' : String(role.district),
    photoUrl: safeHttpUrl(person.image) || null,
    roleTitle: firstString(role.title),
  };
}

// --- Profile enrichment: committees, sponsored bills, leadership, patterns ---

let texasCommitteesCache = { at: 0, list: null };

async function fetchTexasCommittees() {
  const now = Date.now();
  if (texasCommitteesCache.list && now - texasCommitteesCache.at < COMMITTEES_CACHE_TTL_MS) {
    return texasCommitteesCache.list;
  }
  if (!OPEN_STATES_API_KEY) return [];
  const all = [];
  try {
    for (let page = 1; page <= 3; page += 1) {
      const url = new URL(OPEN_STATES_COMMITTEES_URL);
      url.searchParams.set('jurisdiction', 'Texas');
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      url.searchParams.set('include', 'memberships');
      const body = await fetchJson(url, { headers: { 'X-API-KEY': OPEN_STATES_API_KEY, Accept: 'application/json' } });
      const results = Array.isArray(body?.results) ? body.results : [];
      if (!results.length) break;
      all.push(...results);
      const pagination = body?.pagination || {};
      if (Number(pagination.page) >= Number(pagination.max_page || page)) break;
      if (results.length < 100) break;
    }
  } catch (error) {
    return texasCommitteesCache.list || [];
  }
  texasCommitteesCache = { at: now, list: all };
  return all;
}

function uuidOfPersonId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = raw.split('/');
  return parts[parts.length - 1].trim();
}

function normPersonName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function lastNameOf(fullName) {
  const tokens = normPersonName(fullName).split(' ').filter(Boolean)
    .filter((t) => !['jr', 'sr', 'ii', 'iii', 'iv', 'v'].includes(t));
  return tokens.length ? tokens[tokens.length - 1] : '';
}

function personNamesMatch(a, b) {
  const na = normPersonName(a);
  const nb = normPersonName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  if (ta.length > 1 && ta.slice().sort().join(' ') === tb.slice().sort().join(' ')) return true;
  if ((ta.length === 1 && tb.includes(ta[0]) && ta[0].length >= 3)
    || (tb.length === 1 && ta.includes(tb[0]) && tb[0].length >= 3)) return true;
  const la = lastNameOf(na);
  const lb = lastNameOf(nb);
  if (la && la === lb && la.length >= 3) return true;
  if (la && tb.includes(la) && la.length >= 3) return true;
  if (lb && ta.includes(lb) && lb.length >= 3) return true;
  return false;
}

function personIdsMatch(wantedId, candidateId) {
  const w = String(wantedId || '').trim();
  const c = String(candidateId || '').trim();
  if (!w || !c) return false;
  if (w === c) return true;
  return uuidOfPersonId(w) !== '' && uuidOfPersonId(w) === uuidOfPersonId(c);
}

function committeeMembershipPerson(membership) {
  if (!membership || typeof membership !== 'object') return { id: '', name: '' };
  const nested = membership.person && typeof membership.person === 'object' ? membership.person : null;
  const nestedId = typeof membership.person === 'string' ? membership.person : nested?.id;
  return {
    id: firstString(membership.person_id, membership.personId, membership.personIdHint, nestedId),
    name: firstString(membership.person_name, membership.name, membership.personName, nested?.name),
  };
}

function committeesForPerson(allCommittees, person) {
  const wantedId = String(person?.personId || '');
  const wantedName = String(person?.name || '');
  const wantedLast = lastNameOf(wantedName);
  const matched = [];
  for (const committee of allCommittees || []) {
    const memberships = Array.isArray(committee?.memberships) ? committee.memberships : [];
    const mine = memberships.find((m) => {
      const who = committeeMembershipPerson(m);
      if (wantedId && who.id && personIdsMatch(wantedId, who.id)) return true;
      if (personNamesMatch(wantedName, who.name)) return true;
      if (wantedLast && wantedLast.length >= 3) {
        const haystack = Object.values(m || {}).filter((v) => typeof v === 'string').join(' ').toLowerCase();
        if (haystack.includes(wantedLast) && normPersonName(haystack).includes(normPersonName(wantedName).split(' ')[0] || '___unlikely___')) return true;
      }
      return false;
    });
    if (!mine) continue;
    matched.push({
      id: firstString(committee?.id).slice(0, 120),
      name: firstString(committee?.name) || 'Committee',
      chamber: firstString(committee?.chamber).slice(0, 20),
      classification: firstString(committee?.classification).slice(0, 40),
      role: firstString(mine?.role) || 'Member',
    });
    if (matched.length >= 15) break;
  }
  matched.sort((a, b) => {
    const rank = (role) => (/chair/i.test(role || '') && !/vice/i.test(role || '') ? 0 : /vice/i.test(role || '') ? 1 : 2);
    return rank(a.role) - rank(b.role) || String(a.name).localeCompare(String(b.name));
  });
  return matched;
}

async function fetchSponsoredBills(person) {
  if (!OPEN_STATES_API_KEY || (!person?.personId && !person?.name)) {
    return { status: 'unavailable', records: [] };
  }
  const seenQueries = new Set();
  const queries = [];
  for (const q of [person.personId, uuidOfPersonId(person.personId), person.name, lastNameOf(person.name)]) {
    if (typeof q === 'string' && q.trim() && !seenQueries.has(q.trim())) {
      seenQueries.add(q.trim());
      queries.push(q.trim());
    }
  }
  for (const sponsorQuery of queries) {
    try {
      const url = new URL(OPEN_STATES_BILL_URL);
      url.searchParams.set('jurisdiction', 'Texas');
      url.searchParams.set('sponsor', sponsorQuery);
      url.searchParams.set('per_page', '10');
      url.searchParams.set('sort', 'updated_desc');
      url.searchParams.set('include', 'sponsorships');
      const body = await fetchJson(url, { headers: { 'X-API-KEY': OPEN_STATES_API_KEY, Accept: 'application/json' } });
      const results = Array.isArray(body?.results) ? body.results : [];
      if (!results.length) continue;
      const records = results.slice(0, 8).map((bill) => {
        const sponsorships = Array.isArray(bill?.sponsorships) ? bill.sponsorships : [];
        const mine = sponsorships.find((s) => {
          const sid = firstString(s?.person?.id, s?.person_id, typeof s?.person === 'string' ? s.person : '');
          const sname = firstString(s?.person?.name, s?.name);
          if (person.personId && sid && personIdsMatch(person.personId, sid)) return true;
          return personNamesMatch(person.name, sname);
        });
        const primary = mine ? mine.primary !== false : undefined;
        return {
          id: firstString(bill?.id).slice(0, 120),
          identifier: firstString(bill?.identifier).slice(0, 40),
          title: firstString(bill?.title).slice(0, 200) || 'Untitled bill',
          session: firstString(bill?.session).slice(0, 20),
          classification: (Array.isArray(bill?.classification) ? bill.classification.join(', ') : firstString(bill?.classification)).slice(0, 60),
          sponsorshipRole: firstString(mine?.classification, mine?.primary === true ? 'primary' : '').slice(0, 40),
          primary: primary === undefined ? null : Boolean(primary),
          latestAction: firstString(bill?.latest_action_description).slice(0, 200),
          latestActionDate: firstString(bill?.latest_action_date).slice(0, 20),
          sourceUrl: safeHttpUrl(bill?.openstates_url) || safeHttpUrl(bill?.sources?.[0]?.url),
        };
      }).filter((r) => r.identifier);
      if (records.length) return { status: 'available', records };
    } catch (error) { /* try next query */ }
  }
  return { status: 'unavailable', records: [] };
}

// --- Official Texas Legislature fallback (capitol.texas.gov, no API key) ---
// Open States committee coverage for Texas is experimental and often empty.
// The official Texas Legislature Online (TLO) publishes per-member committee
// assignments and authored-bill reports as plain HTML with stable URL shapes,
// so we scrape those (allowlisted host only) when Open States comes up empty.

const TLO_BASE = 'https://capitol.texas.gov';
const TLO_TIMEOUT_MS = 10_000;
const TLO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TLO_LEGS = ['89', '90'];
const TLO_REPORT_SESS = '89R';
const tloRosterCache = { at: 0, byChamber: null };
const tloMemberCache = new Map(); // code -> { at, committees, sponsored }

async function fetchTloText(pathAndQuery) {
  const url = new URL(pathAndQuery, TLO_BASE);
  if (url.host !== 'capitol.texas.gov' || url.protocol !== 'https:') {
    throw new Error('TLO host not allowed');
  }
  const response = await fetch(url, {
    headers: { 'User-Agent': 'LariatLegislatorLookup/1.0 (+https://lariatdemo.com)', Accept: 'text/html' },
    signal: AbortSignal.timeout(TLO_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`TLO HTTP ${response.status}`);
  const text = await response.text();
  if (!text || text.length < 500) throw new Error('TLO empty response');
  return text;
}

function decodeTloEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x10FFFF ? String.fromCodePoint(n) : '';
    })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseTloRoster(html) {
  const entries = [];
  const re = /<option\s+value="(A\d+)"[^>]*>([^<]+)<\/option>/gi;
  let m;
  while ((m = re.exec(html)) && entries.length < 500) {
    const code = m[1].trim();
    const rawLabel = decodeTloEntities(m[2]);
    const label = rawLabel.replace(/\s*\([A-Z]-A\d+\)\s*$/, '').trim();
    if (code && label && !/select a name/i.test(label)) entries.push({ code, label });
  }
  return entries;
}

async function fetchTloRoster() {
  const now = Date.now();
  if (tloRosterCache.byChamber && now - tloRosterCache.at < TLO_CACHE_TTL_MS) {
    return tloRosterCache.byChamber;
  }
  const [houseHtml, senateHtml] = await Promise.all([
    fetchTloText('/Committees/ByMember.aspx?chamber=H'),
    fetchTloText('/Committees/ByMember.aspx?chamber=S'),
  ]);
  const byChamber = { H: parseTloRoster(houseHtml), S: parseTloRoster(senateHtml) };
  tloRosterCache.at = now;
  tloRosterCache.byChamber = byChamber;
  return byChamber;
}

function resolveTloCode(candidates, person) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length || !person?.name) return '';
  const exact = list.find((c) => personNamesMatch(person.name, c.label));
  if (exact && !list.some((o) => o !== exact && personNamesMatch(person.name, o.label)
    && normPersonName(o.label) !== normPersonName(exact.label))) return exact.code;
  const surname = lastNameOf(person.name);
  if (surname && surname.length >= 3) {
    const hits = list.filter((c) => normPersonName(c.label).split(' ').includes(surname));
    if (hits.length === 1) return hits[0].code;
  }
  const sortedWant = normPersonName(person.name).split(' ').filter(Boolean).sort().join(' ');
  const fullHits = list.filter((c) => normPersonName(c.label).split(' ').filter(Boolean).sort().join(' ') === sortedWant);
  if (fullHits.length === 1) return fullHits[0].code;
  return exact && fullHits.length !== 0 ? exact.code : '';
}

function parseTloCommittees(html, chamber) {
  const section = (() => {
    const m = /<div id="committeeAssignments">([\s\S]*?)<div id="legislativeInformation">/.exec(html);
    return m ? m[1] : html;
  })();
  const block = (() => {
    const parts = section.split(/Conference Committees/i);
    return parts[0] || '';
  })();
  const out = [];
  const re = /<a[^>]*>([^<]+)<\/a>\s*(\(([^)]*)\))?/gi;
  let m;
  while ((m = re.exec(block)) && out.length < 15) {
    const name = decodeTloEntities(m[1]).slice(0, 100);
    if (!name || /conference committee on/i.test(name)) continue;
    const roleRaw = decodeTloEntities(m[3] || '').slice(0, 40);
    out.push({
      id: '',
      name: name || 'Committee',
      chamber: String(chamber || '').slice(0, 20),
      classification: '',
      role: roleRaw || 'Member',
      source: 'official',
    });
  }
  const seen = new Set();
  return out.filter((c) => {
    const key = c.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseTloAuthoredReport(html) {
  const rows = String(html || '').split(/<div class="row">/).slice(1);
  const out = [];
  for (const row of rows) {
    if (out.length >= 8) break;
    const link = /BillLookup\/History\.aspx\?LegSess=([^&"']+)(?:&amp;|&)Bill=([^"'<]+)["'][^>]*>([^<]+)<\/a/i.exec(row);
    if (!link) continue;
    const legSess = decodeTloEntities(link[1]).slice(0, 12);
    const billParam = decodeTloEntities(link[2]).replace(/\s+/g, ' ').trim().slice(0, 20);
    const identifier = decodeTloEntities(link[3]).replace(/\s+/g, ' ').trim().slice(0, 20)
      || billParam.replace(/^([A-Za-z]+)\s*0*(\d+)$/, (_, letters, num) => `${letters.toUpperCase()} ${Number(num)}`).slice(0, 20)
      || billParam;
    if (!identifier) continue;
    const action = /<b>Last Action:<\/b><\/div>\s*<div[^>]*>([^<]*)/i.exec(row);
    const caption = /<b>Caption<\/b>:\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/i.exec(row);
    out.push({
      id: '',
      identifier,
      title: truncateCaption(decodeTloEntities((caption ? caption[1].replace(/<[^>]*>/g, ' ') : ''))) || 'Untitled bill',
      session: legSess,
      classification: '',
      sponsorshipRole: 'Author',
      primary: true,
      latestAction: decodeTloEntities(action ? action[1] : '').slice(0, 200),
      latestActionDate: '',
      sourceUrl: `${TLO_BASE}/BillLookup/History.aspx?LegSess=${encodeURIComponent(legSess)}&Bill=${encodeURIComponent(billParam)}`,
      source: 'official',
    });
  }
  return out;
}

function truncateCaption(value, max = 110) {
  let text = String(value || '').replace(/^\s*relating to\s+/i, '').trim();
  const cut = text.search(/;\s|\s+including\s+/i);
  if (cut > 24 && cut < max) text = text.slice(0, cut).trim();
  text = text.replace(/[\s,;:.]+$/, '');
  if (text.length <= max) return text.charAt(0).toUpperCase() + text.slice(1);
  const sliced = text.slice(0, max);
  const lastSpace = sliced.lastIndexOf(' ');
  const trimmed = (lastSpace > max * 0.6 ? sliced.slice(0, lastSpace) : sliced).replace(/[\s,;:.]+$/, '');
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1) + '…';
}

const tloTitleCache = new Map(); // normalized identifier -> { at, title }

async function enrichTloBillTitles(bills) {
  if (!OPEN_STATES_API_KEY || !Array.isArray(bills) || !bills.length) return bills;
  await Promise.all(bills.map(async (bill) => {
    if (bill?.source !== 'official') return;
    const key = String(bill.identifier || '').replace(/\s+/g, '').toUpperCase();
    if (!key) return;
    const cached = tloTitleCache.get(key);
    if (cached && Date.now() - Number(cached.at) < TLO_CACHE_TTL_MS) {
      if (cached.title) bill.title = cached.title;
      return;
    }
    try {
      const url = new URL(OPEN_STATES_BILL_URL);
      url.searchParams.set('jurisdiction', 'Texas');
      url.searchParams.set('identifier', bill.identifier);
      url.searchParams.set('per_page', '5');
      const body = await fetchJson(url, { headers: { 'X-API-KEY': OPEN_STATES_API_KEY, Accept: 'application/json' } });
      const results = Array.isArray(body?.results) ? body.results : [];
      const norm = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
      const match = results.find((b) => norm(b?.identifier) === key) || null;
      const shortTitle = firstString(match?.title);
      if (shortTitle && shortTitle.length < 100 && !/^relating to\s/i.test(shortTitle)) {
        bill.title = shortTitle.slice(0, 200);
        if (tloTitleCache.size > 500) tloTitleCache.clear();
        tloTitleCache.set(key, { at: Date.now(), title: bill.title });
        return;
      }
    } catch (error) { /* keep caption fallback */ }
    if (tloTitleCache.size > 500) tloTitleCache.clear();
    tloTitleCache.set(key, { at: Date.now(), title: '' });
  }));
  return bills;
}

async function fetchTloProfile(person) {
  const chamberLetter = String(person?.chamber || '').toLowerCase() === 'senate' ? 'S'
    : String(person?.chamber || '').toLowerCase() === 'house' ? 'H' : '';
  if (!chamberLetter) return null;
  const roster = await fetchTloRoster();
  const code = resolveTloCode(roster[chamberLetter], person);
  if (!code) return null;
  const cached = tloMemberCache.get(code);
  if (cached && Date.now() - Number(cached.at) < TLO_CACHE_TTL_MS) return cached;
  if (tloMemberCache.size > 500) tloMemberCache.clear();
  let memberHtml = '';
  for (const leg of TLO_LEGS) {
    try {
      memberHtml = await fetchTloText(`/Members/MemberInfo.aspx?Chamber=${chamberLetter}&Code=${encodeURIComponent(code)}&Leg=${leg}`);
      if (memberHtml.includes('Committee Assignments')) break;
    } catch (error) { /* try next Leg */ }
  }
  if (!memberHtml.includes('Committee Assignments')) return null;
  const committees = parseTloCommittees(memberHtml, person.chamber);
  let sponsored = [];
  try {
    const reportHtml = await fetchTloText(`/reports/report.aspx?LegSess=${TLO_REPORT_SESS}&ID=author&Code=${encodeURIComponent(code)}`);
    sponsored = parseTloAuthoredReport(reportHtml);
  } catch (error) { sponsored = []; }
  const result = { code, committees, sponsored, at: Date.now() };
  tloMemberCache.set(code, result);
  return result;
}

function buildLeadershipRoles(person, committees) {
  const roles = [];
  const title = String(person?.roleTitle || '');
  const lower = title.toLowerCase();
  const isGeneric = /^(senator|representative|state senator|state representative)\s*$/i.test(title.trim())
    || !title.trim();
  if (title.trim() && !isGeneric
    && /(speaker|president|pro tempore|majority|minority|leader|whip|chair|vice-chair|vice chair|speaker pro)/i.test(title)) {
    roles.push({ title, detail: `${person?.chamber || ''} leadership`.trim() });
  }
  for (const committee of committees || []) {
    if (/chair|vice/i.test(committee.role || '')) {
      roles.push({ title: `${committee.role} — ${committee.name}`, detail: 'Committee leadership' });
    }
    if (roles.length >= 8) break;
  }
  return roles.slice(0, 8).map((r) => ({
    title: String(r.title || '').slice(0, 140),
    detail: String(r.detail || '').slice(0, 80),
  }));
}

function buildVotingPattern(votingHistory, checkedCount) {
  const records = Array.isArray(votingHistory) ? votingHistory : [];
  const recorded = records.filter((r) => r?.voteStatus === 'recorded');
  const yes = recorded.filter((r) => String(r.vote || '').toLowerCase() === 'yes').length;
  const no = recorded.filter((r) => String(r.vote || '').toLowerCase() === 'no').length;
  const other = Math.max(0, recorded.length - yes - no);
  const notRecorded = records.filter((r) => r?.voteStatus !== 'recorded').length;
  const yesPct = recorded.length ? Math.round((yes / recorded.length) * 100) : null;
  const noPct = recorded.length ? Math.round((no / recorded.length) * 100) : null;
  let trend = 'No clear trend yet';
  if (recorded.length >= 2) {
    if (yesPct >= 75) trend = 'Votes Yes most of the time';
    else if (noPct >= 75) trend = 'Votes No most of the time';
    else if (yesPct >= 55) trend = 'Leans Yes';
    else if (noPct >= 55) trend = 'Leans No';
    else trend = 'Mixed Yes/No record';
  } else if (recorded.length === 1) {
    trend = yes === 1 ? 'Single recorded Yes vote' : no === 1 ? 'Single recorded No vote' : 'Single recorded vote';
  }
  return {
    totalChecked: Number.isFinite(Number(checkedCount)) ? Number(checkedCount) : records.length,
    recorded: recorded.length,
    yes, no, other, notRecorded, yesPct, noPct, trend,
  };
}

async function enrichLegislator(legislator, allCommittees) {
  const [history, sponsored] = await Promise.all([
    fetchVotingHistory(legislator),
    fetchSponsoredBills(legislator),
  ]);
  legislator.votingHistoryStatus = history.status;
  legislator.votingHistoryChecked = history.checkedBillCount;
  legislator.votingHistory = history.records;
  const committees = committeesForPerson(allCommittees, legislator);
  let committeesSource = committees.length ? 'openstates' : '';
  let sponsoredRecords = sponsored.records;
  let sponsoredStatus = sponsored.status;
  let sponsoredSource = sponsoredRecords.length ? 'openstates' : '';
  if (!committees.length || !sponsoredRecords.length) {
    try {
      const tlo = await fetchTloProfile(legislator);
      if (tlo) {
        if (!committees.length && tlo.committees.length) {
          committees.push(...tlo.committees.slice(0, 15));
          committeesSource = 'official';
        }
        if (!sponsoredRecords.length && tlo.sponsored.length) {
          sponsoredRecords = tlo.sponsored.slice(0, 8);
          sponsoredStatus = 'available';
          sponsoredSource = 'official';
        }
      }
      if (sponsoredSource === 'official' && sponsoredRecords.length) {
        await enrichTloBillTitles(sponsoredRecords);
      }
      console.log(`[legislator] TLO fallback for ${legislator.name}: ${tlo ? `${tlo.committees.length} committees, ${tlo.sponsored.length} sponsored (code ${tlo.code})` : 'no TLO profile resolved'}`);
    } catch (error) {
      console.log(`[legislator] TLO fallback failed for ${legislator.name}: ${error.message}`);
    }
  }
  committees.sort((a, b) => {
    const rank = (role) => (/chair/i.test(role || '') && !/vice/i.test(role || '') ? 0 : /vice/i.test(role || '') ? 1 : 2);
    return rank(a.role) - rank(b.role) || String(a.name).localeCompare(String(b.name));
  });
  legislator.committees = committees.slice(0, 15);
  legislator.committeesStatus = committees.length ? 'available' : 'unavailable';
  legislator.committeesSource = committeesSource;
  legislator.sponsoredBills = sponsoredRecords.slice(0, 8);
  legislator.sponsoredBillsStatus = sponsoredStatus;
  legislator.sponsoredBillsSource = sponsoredSource;
  legislator.leadershipRoles = buildLeadershipRoles(legislator, committees);
  legislator.votingPattern = buildVotingPattern(history.records, history.checkedBillCount);
  return legislator;
}

function majorBillsForVoteHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BILL_DATA_FILE, 'utf8'));
    const bills = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.bills) ? parsed.bills : [];
    return bills
      .filter((bill) => bill && typeof bill.id === 'string' && typeof bill.identifier === 'string'
        && ['moderate', 'high'].includes(String(bill.impact_level || '').toLowerCase()))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, 12)
      .map((bill) => ({
        id: bill.id,
        identifier: bill.identifier,
        session: typeof bill.session === 'string' || typeof bill.session === 'number'
          ? String(bill.session)
          : '',
        title: firstString(bill.title) || 'Untitled bill',
        updatedAt: firstString(bill.updated_at),
        sourceUrl: safeHttpUrl(bill.source_url),
      }));
  } catch (error) {
    return [];
  }
}

function voteOption(voter) {
  const option = firstString(voter?.option, voter?.vote, voter?.value, voter?.position).toLowerCase();
  if (option === 'yes' || option === 'yea' || option === 'aye' || option === 'for') return 'Yes';
  if (option === 'no' || option === 'nay' || option === 'against') return 'No';
  if (option.includes('present')) return 'Present';
  if (option.includes('absent')) return 'Absent';
  if (option.includes('excused')) return 'Excused';
  return firstString(voter?.option, voter?.vote, voter?.value, voter?.position) || 'Recorded';
}

function voterMatchesPerson(voter, person) {
  const ids = [voter?.id, voter?.person_id, voter?.person?.id, voter?.voter?.id,
    typeof voter?.voter === 'string' ? voter.voter : '',
    typeof voter?.person === 'string' ? voter.person : '']
    .filter((value) => typeof value === 'string' && value);
  if (person?.personId && ids.some((id) => personIdsMatch(person.personId, id))) return true;
  const names = [voter?.name, voter?.person?.name, voter?.voter?.name, voter?.voter_name,
    typeof voter?.voter === 'string' ? voter.voter : '', typeof voter?.person === 'string' ? voter.person : '']
    .filter((value) => typeof value === 'string' && value.trim());
  return names.some((n) => personNamesMatch(person?.name, n));
}

function extractVoters(vote) {
  if (Array.isArray(vote?.voters)) return vote.voters;
  if (Array.isArray(vote?.votes)) return vote.votes;
  return [];
}

async function fetchVotingHistory(person) {
  const bills = majorBillsForVoteHistory();
  if (!bills.length || !OPEN_STATES_API_KEY || !person.personId) {
    return { status: 'unavailable', checkedBillCount: bills.length, records: [] };
  }

  let successfulResponses = 0;
  const records = await Promise.all(bills.map(async (bill) => {
    try {
      // Open States' detail route expects the `ocd-bill/` path segment to
      // remain a path segment, not be encoded as `%2F`.
      if (!/^ocd-bill\/[A-Za-z0-9-]+$/.test(bill.id)) return null;
      const url = new URL(`${OPEN_STATES_BILL_URL}/${bill.id}`);
      url.searchParams.set('include', 'votes');
      const body = await fetchJson(url, { headers: { 'X-API-KEY': OPEN_STATES_API_KEY, Accept: 'application/json' } });
      successfulResponses += 1;
      const votes = Array.isArray(body.votes) ? body.votes : [];
      const matchingVote = votes.find((vote) => extractVoters(vote).some((voter) => voterMatchesPerson(voter, person)));
      const matchingVoter = matchingVote && extractVoters(matchingVote).find((voter) => voterMatchesPerson(voter, person));
      return {
        billId: bill.id,
        identifier: bill.identifier,
        session: bill.session || '',
        title: bill.title,
        date: firstString(matchingVote?.start_date, matchingVote?.end_date, bill.updatedAt),
        vote: matchingVoter ? voteOption(matchingVoter) : 'Not recorded',
        voteStatus: matchingVoter ? 'recorded' : 'not_recorded',
        result: firstString(matchingVote?.result),
        sourceUrl: bill.sourceUrl,
      };
    } catch (error) {
      return null;
    }
  }));

  const cleanRecords = records.filter(Boolean);
  const recordedFirst = [...cleanRecords].sort((a, b) => (
    (b.voteStatus === 'recorded' ? 1 : 0) - (a.voteStatus === 'recorded' ? 1 : 0)
  ));
  return {
    status: successfulResponses ? 'available' : 'unavailable',
    checkedBillCount: bills.length,
    records: recordedFirst.slice(0, 6),
  };
}

async function fetchLegislators(latitude, longitude) {
  if (!OPEN_STATES_API_KEY) throw lookupError(503, 'not_configured', 'Legislator lookup is not configured yet.');
  const url = new URL(OPEN_STATES_GEO_URL);
  url.searchParams.set('lat', String(latitude));
  url.searchParams.set('lng', String(longitude));
  const body = await fetchJson(url, { headers: { 'X-API-KEY': OPEN_STATES_API_KEY, Accept: 'application/json' } });
  const people = Array.isArray(body.results) ? body.results : Array.isArray(body.people) ? body.people : [];
  const normalized = people.map(normalizeLegislator).filter(Boolean);
  const byChamber = ['Senate', 'House'].map((chamber) => normalized.find((person) => person.chamber === chamber)).filter(Boolean);
  if (byChamber.length !== 2) throw lookupError(404, 'no_match', 'No Texas legislators matched that location.');

  return byChamber;
}

async function findLegislators(address) {
  const key = cacheKeyForAddress(address);
  const cached = legislatorCache[key];
  if (cached && Date.now() - Number(cached.cachedAt) < LEGISLATOR_CACHE_TTL_MS
    && cachedLegislatorsAreUsable(cached.legislators)) {
    return { legislators: cached.legislators, cached: true };
  }
  if (legislatorInFlight.has(key)) return legislatorInFlight.get(key);
  const lookup = (async () => {
    const coordinates = isZipAddress(address) ? await geocodeZip(address) : await geocodeFullAddress(address);
    if (!(await isTexasCoordinate(coordinates.latitude, coordinates.longitude))) {
      throw lookupError(422, 'outside_texas', 'That location is outside Texas. Enter a Texas address or ZIP code.');
    }
    const legislators = await fetchLegislators(coordinates.latitude, coordinates.longitude);
    const allCommittees = await fetchTexasCommittees();
    await Promise.all(legislators.map((legislator) => enrichLegislator(legislator, allCommittees)));
    legislatorCache[key] = { cachedAt: Date.now(), legislators };
    saveLegislatorCache();
    return { legislators, cached: false };
  })();
  legislatorInFlight.set(key, lookup);
  try { return await lookup; } finally { legislatorInFlight.delete(key); }
}

/* Strips leaked agentic artifacts small models sometimes emit: <|...|>
 * control tokens, tool_call_start...end blocks, and google(query='...')
 * style pseudo tool calls (no such tools exist here — nothing was searched).
 * Applied to every AI answer before it leaves the server.
 */
function sanitizeAiText(text) {
  let cleaned = String(text || '');
  // Remove marker tokens individually (NOT the whole span between them —
  // models sometimes leave real answer prose inside, which must survive).
  cleaned = cleaned.replace(/<\|[^|]*\|>/g, ' ');
  cleaned = cleaned.replace(/\b[a-zA-Z_]+\(\s*query\s*=\s*('[^']*'|"[^"]*")\s*\)/g, ' ');
  cleaned = cleaned.replace(/\[\s*(,\s*)*\]/g, ' '); // empty brackets left behind
  // Strip "Based on ..."-style preambles ("Based on the provided context,
  // here is the specific information about SB 1:", etc.).
  cleaned = cleaned.replace(/^\s*based on\b[^.!?\n]{0,140}?:\s*/i, '');
  cleaned = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

/* Every well-formed Kevin answer ends with sentence-terminal punctuation.
 * Anything else — a colon, a dangling "in", a cut-off list item like
 * "Youth camp licensees" — stopped mid-thought and must be continued. */
function looksTruncated(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  return !/[.!?]['"”’)\]]?\s*$/.test(trimmed);
}

// Safety net: peel any trailing disclaimer the model emits anyway ("Not
// legal advice", optionally paired with "verify with official sources").
// The notice lives under the chat window, so answers stay clean.
function stripDisclaimer(text) {
  let out = String(text || '').trim();
  for (let i = 0; i < 2; i += 1) {
    out = out
      .replace(/\s*not legal advice\s*[.;]?\s*(verify with official sources\s*[.;]?)?\s*$/i, '')
      .replace(/\s*verify with official sources\s*[.;]?\s*$/i, '')
      .trim();
  }
  return out;
}

// Safety net: free-tier models often ignore the no-labels instruction, so
// strip any Who:/How:/Why:/What: section headers the AI emits and keep the
// content as plain prose paragraphs.
function enforceProse(text) {
  const out = String(text || '').replace(/^\s*(Who|What|How|Why|Bottom line)\s*:\s*/gim, '');
  return out.replace(/(^|\n\n)\s*([a-z])/g, (m, p, c) => `${p}${c.toUpperCase()}`).trim();
}

/* ---------------------------------------------------------------------------
 * Chatbot: POST /api/chat/ask  { question }
 * Answers Texas-bill questions from local snapshot first, then Open States
 * (server-side X-API-KEY, never exposed), then OpenRouter if configured.
 * Without AI keys it still answers extractively from local data.
 * ------------------------------------------------------------------------- */

function sanitizedChatQuestion(value) {
  return String(value || '').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function loadBillSnapshot() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BILL_DATA_FILE, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.bills)) return parsed.bills;
  } catch (error) { /* fall through */ }
  return [];
}

const SITE_KNOWLEDGE_FILE = path.join(ROOT, 'site_knowledge.json');

// Site knowledge (Lariat pages: feed, privacy, pricing, calendar, legislator).
function loadSiteKnowledge() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SITE_KNOWLEDGE_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.topics)) return parsed;
  } catch (error) { /* fall through */ }
  return { topics: [] };
}

// Whole site knowledge, compacted (keywords stripped — the model matches by meaning).
function siteContext(kb) {
  const site = (kb && kb.site) || {};
  const pages = site.pages ? `Pages: home, feed, legislator, calendar, pricing, privacy, accessibility.` : '';
  const topics = ((kb && kb.topics) || []).map((t) => `- [${t.id}] ${t.answer}`).join('\n');
  return `${site.tagline || ''} Status: ${site.status || ''} Feedback email: ${site.feedback_email || ''}\n${pages}\n${topics}`;
}

// Full-feed context: ~40 bills in compact form (~2.5k tokens). This replaces
// the 3-bill keyword bottleneck for AI answers — the model itself picks what
// is relevant, compares, and justifies connections instead of depending on
// synonym lists to pre-select correctly.
function feedContext(bills) {
  const firstWords = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ');
  return (bills || []).map((b) => {
    const affects = String(b.affects || b.specific_industry || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'n/a';
    return `- ${b.identifier}: ${b.title}. Affects: ${affects}. ${firstWords(b.summary || b.changes, 30)}`;
  }).join('\n');
}

const normBillId = (letters, num) => `${String(letters || '').toUpperCase()} ${parseInt(String(num || ''), 10)}`;

// Citations follow the answer, not retrieval: whatever bills Kevin actually
// discussed become the linked sources.
function citationsFromAnswer(answer, bills, clean) {
  const byId = new Map();
  for (const b of (bills || [])) {
    const m = /^\s*([A-Za-z]+)\s*0*(\d+)\s*$/.exec(String(b.identifier || ''));
    if (m) byId.set(normBillId(m[1], m[2]), b);
  }
  const seen = new Set();
  const out = [];
  const re = /\b((?:HJR|HCR|SB|HB|SR|HR|SJR))\s*-?\s*(\d{1,4})\b/gi;
  let m;
  while ((m = re.exec(String(answer || ''))) && out.length < 3) {
    const key = normBillId(m[1], m[2]);
    if (seen.has(key) || !byId.has(key)) continue;
    seen.add(key);
    out.push(byId.get(key));
  }
  return out.map((b) => clean(b)).filter((c) => c.identifier);
}

async function fetchOpenStatesBills(question) {
  if (!OPEN_STATES_API_KEY) return [];
  try {
    const url = new URL(OPEN_STATES_BILL_URL);
    url.searchParams.set('jurisdiction', 'Texas');
    url.searchParams.set('q', question.slice(0, 120));
    url.searchParams.set('per_page', '3');
    url.searchParams.set('sort', 'updated_desc');
    const response = await fetch(url, {
      headers: { 'X-API-KEY': OPEN_STATES_API_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const body = await response.json().catch(() => null);
    const results = Array.isArray(body?.results) ? body.results : Array.isArray(body?.bills) ? body.bills : [];
    return results.slice(0, 3).map((b) => ({
      identifier: b.identifier || b.name || 'TX bill',
      title: b.title || '',
      summary: Array.isArray(b.abstracts) && b.abstracts[0]?.abstract ? b.abstracts[0].abstract : '',
      status: b.latest_action_description || '',
      sourceUrl: (b.sources && b.sources[0]?.url) || b.openstates_url || '',
    }));
  } catch (error) {
    return [];
  }
}

async function rewriteWithGemini(question, extra = {}) {
  if (!GEMINI_API_KEY) return null;
  try {
    const histLine = (Array.isArray(extra.history) && extra.history.length)
      ? `Conversation so far: ${extra.history.map((h) => `User: ${h.q} || Kevin: ${h.a}`).join(' ||| ').slice(0, 900)}\n`
      : '';
    const system = 'Your name is Kevin. You are Kevin, a conversational Texas Legislature helper on the Lariat site — never claim any other name or model identity. Talk like a helpful person, not a form. Below you have Lariat site info, the full Texas bill feed, and possibly OpenStates records (marked, outside the feed). Decide yourself whether the user asks about the site or about bills. Pick relevant bills yourself, compare when useful, and explain in everyday words how a bill connects to the asker (use would/could for inference). If asked for an opinion or what is most important, give a direct judgment call and justify it. If the question is ambiguous, ask ONE clarifying question instead of guessing. Use the conversation history for follow-ups ("it", "that one", "what about renters?"). Answer THIS question fresh; never repeat a previous answer unless the user asked for the same thing. Ground everything in the sources; name the bill identifiers you discuss. If nothing fits, say so starting with the words "No bill in the current bill feed" and suggest how to browse. Never use Who:, How:, Why:, What:, or Bottom line: labels. Copy the Affects field exactly when stating who a bill affects; never invent affected groups. If unsure, say so and point to the bill feed. Start directly with the answer, no preamble. Never output tool calls, search queries, <|...|> tokens, or your thinking process — only the final answer. Write in plain text only: no markdown, no ** asterisks, no bullets, dashes, numbers, or # headings. Use short paragraphs separated by blank lines. Do not add any disclaimer, sign-off, or Not legal advice line — the site already shows that notice under the chat. Max 150 words (a clarifying question may be shorter).';
    for (const model of [GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-3.5-flash-lite']) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ parts: [{ text: `${histLine}User asks: ${question}\n\n${extra.bigCtx || '(no sources available)'}` }] }],
            generationConfig: { maxOutputTokens: 700, temperature: 0.3 },
          }),
        });
        if (!response.ok) continue;
        const body = await response.json().catch(() => null);
        const parts = body?.candidates?.[0]?.content?.parts;
        const raw = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
        const text = sanitizeAiText(raw);
        if (text) return text.slice(0, 1200);
      } catch (error) { /* try next model */ }
    }
  } catch (error) { /* fall through */ }
  return null;
}

/* Joins a continuation chunk onto a cut-off draft. Mid-word cuts rejoin
 * seamlessly ("connectivi" + "ty" → "connectivity"); clean breaks get a space. */
function joinContinuation(draft, chunk) {
  const left = String(draft || '').trimEnd();
  const right = String(chunk || '').trimStart();
  if (!left) return right;
  if (!right) return left;
  const glue = (/[A-Za-z0-9]$/.test(left) && /^[a-z0-9]/.test(right)) ? '' : ' ';
  return `${left}${glue}${right}`;
}

async function openRouterChat(model, messages) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': baseUrl(), 'X-Title': 'Kevin helpbot' },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      model,
      // Free-tier (:free) models cost $0 regardless of token count.
      // 8192 = the highest value all rotation models accept (bottleneck
      // is liquid/lfm-2.5-2.6b:free at 8192 output tokens — it returns
      // empty below that). Higher would 400 on liquid and knock it
      // out of rotation.
      max_tokens: 8192,
      temperature: 0.3,
      messages,
    }),
  });
  if (!response.ok) {
    const error = new Error(`OpenRouter HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json().catch(() => null);
  const raw = typeof body?.choices?.[0]?.message?.content === 'string' ? body.choices[0].message.content : '';
  return sanitizeAiText(raw);
}

const KEVIN_SYSTEM = 'You are Kevin, a conversational Texas Legislature helper on the Lariat site — never claim any other name or model identity. Talk like a helpful person, not a form. Below you have Lariat site info, the full Texas bill feed, and possibly OpenStates records (marked, outside the feed). Decide yourself whether the user asks about the site or about bills. Pick relevant bills yourself, compare when useful, and explain in everyday words how a bill connects to the asker (use would/could for inference). If asked for an opinion or what is most important, give a direct judgment call and justify it. If the question is ambiguous, ask ONE clarifying question instead of guessing. Use the conversation history for follow-ups ("it", "that one", "what about renters?"). Answer THIS question fresh; never repeat a previous answer unless the user asked for the same thing. Ground everything in the sources; name the bill identifiers you discuss. If nothing fits, say so starting with the words "No bill in the current bill feed" and suggest how to browse. Never use Who:, How:, Why:, What:, or Bottom line: labels. Copy the Affects field exactly when stating who a bill affects; never invent affected groups. If unsure, say so and point to the bill feed. Start directly with the answer, no preamble. Never output tool calls, search queries, <|...|> tokens, or your thinking process — only the final answer. Write in plain text only: no markdown, no ** asterisks, no bullets, dashes, numbers, or # headings. Use short paragraphs separated by blank lines. Do not add any disclaimer, sign-off, or Not legal advice line — the site already shows that notice under the chat. Max 150 words (a clarifying question may be shorter).';
const CONTINUE_PROMPT = 'Continue exactly where you left off. Do not repeat anything already written, do not restart, no preamble.';

async function rewriteWithOpenRouter(question, extra = {}) {
  if (!OPENROUTER_API_KEY) return await rewriteWithGemini(question, extra);
  // `partial`/`carry` live outside try so the fallback below can read them
  // even when every model fails (otherwise: ReferenceError on 429 streaks).
  let partial = '';
  let carry = ''; // truncated thread passed model-to-model until finished
  try {
    const histLine = (Array.isArray(extra.history) && extra.history.length)
      ? `Conversation so far: ${extra.history.map((h) => `User: ${h.q} || Kevin: ${h.a}`).join(' ||| ').slice(0, 900)}\n`
      : '';
    const firstUser = `${histLine}User asks: ${question}\n\n${extra.bigCtx || '(no sources available)'}`;
    // Free-tier lanes are often congested (HTTP 429): rotate over proven
    // models and fail over immediately — qwen3.8-27b:free is retired from
    // free (404) and gemma-4:free is chronically 429 upstream, so both
    // are out (verified Oct 2026).
    const models = [OPENROUTER_MODEL, 'nvidia/nemotron-3-super-120b-a12b:free', 'dots-studio/dots-3-note-preview:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'liquid/lfm-2.5-2.6b:free'].filter(Boolean);
    for (const model of models) {
      // Fresh answer when no thread exists; otherwise THIS model continues
      // the same cut-off response (up to 2 continuation rounds each).
      let draft = carry;
      for (let round = 0; round < 3; round += 1) {
        const fresh = !draft;
        const messages = fresh
          ? [{ role: 'system', content: KEVIN_SYSTEM }, { role: 'user', content: firstUser }]
          : [
            { role: 'system', content: KEVIN_SYSTEM },
            { role: 'user', content: firstUser },
            { role: 'assistant', content: draft },
            { role: 'user', content: CONTINUE_PROMPT },
          ];
        let chunk = '';
        try {
          chunk = await openRouterChat(model, messages);
        } catch (error) {
          break; // other errors: next model
        }
        if (!chunk) break; // model failed: try the next model
        draft = fresh ? chunk : joinContinuation(draft, chunk);
        if (!looksTruncated(chunk) || draft.length > 2400) {
          if (!looksTruncated(draft)) return draft.slice(0, 2400);
          break; // complete chunk but odd joint: stop, keep draft as partial
        }
      }
      carry = draft && looksTruncated(draft) ? draft : '';
      if (draft && !partial) partial = draft;
      if (partial && !looksTruncated(partial)) return partial.slice(0, 2400);
    }
  } catch (error) { /* fall through to Gemini, then extractive */ }
  if (partial) return partial.slice(0, 2400); // better a partial AI answer than none
  return await rewriteWithGemini(question, extra);
}

async function handleChatAsk(req, res, body) {
  if (chatRateLimiter(clientIp(req))) return sendJsonError(res, 429, 'Too many questions. Please wait a bit and try again.', 'rate_limited');
  const question = sanitizedChatQuestion(body.question);
  if (!question || question.length < 3) return sendJsonError(res, 400, 'Please ask a question about a Texas bill (at least 3 characters).', 'invalid_question');

  const bills = loadBillSnapshot();
  const cleanField = (v, n = 300) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const toCitation = (b) => ({
    identifier: String(b.identifier || ''),
    title: String(b.title || 'Untitled bill'),
    summary: String(b.summary || b.changes || '').slice(0, 600),
    status: String(b.status || b.latest_action_description || ''),
    industry: String(b.industry || ''),
    affects: cleanField(b.affects),
    changes: cleanField(b.changes),
    businessImpact: cleanField(b.business_impact),
    sourceUrl: typeof b.source_url === 'string' && /^https?:\/\//i.test(b.source_url) ? b.source_url : '',
  });
  const history = Array.isArray(body.history) ? body.history.slice(-2).map((h) => ({
    q: String(h.q || h.question || '').slice(0, 200),
    a: String(h.a || h.answer || '').slice(0, 300),
  })).filter((h) => h.q) : [];

  // OpenStates supplements the feed only when the question names a bill the
  // snapshot does not contain (otherwise the feed already covers it).
  let osResults = [];
  if (OPEN_STATES_API_KEY) {
    const ids = new Set(bills.map((b) => String(b.identifier || '').replace(/\s+/g, '').toLowerCase()));
    const re = /\b([hs][bjr]{0,2})\s*-?\s*(\d{1,4})\b/gi;
    let m;
    let allKnown = true;
    while ((m = re.exec(question))) {
      if (!ids.has(`${m[1]}${m[2]}`.replace(/\s+/g, '').toLowerCase())) { allKnown = false; break; }
    }
    if (!allKnown) {
      const live = await fetchOpenStatesBills(question);
      osResults = live.map((b) => ({ ...b, sourceUrl: typeof b.sourceUrl === 'string' && /^https?:\/\//i.test(b.sourceUrl) ? b.sourceUrl : '' }));
    }
  }
  const osCtx = osResults.length
    ? `\n\nOPEN STATES RECORDS (outside the Lariat feed):\n${osResults.map((c) => `- ${c.identifier}: ${c.title}. ${String(c.summary).slice(0, 300)}`).join('\n')}`
    : '';
  // The model sees the whole live snapshot, so bills added by the GitHub
  // workflow are automatically in context — no per-bill registration.
  const bigCtx = `LARIAT SITE INFO:\n${siteContext(loadSiteKnowledge())}\n\nTEXAS BILL FEED (${bills.length} bills, plain-English summaries of official text):\n${feedContext(bills)}${osCtx}`;

  const aiAnswer = await rewriteWithOpenRouter(question, { history, bigCtx });
  if (!aiAnswer) {
    return sendJson(res, 200, {
      ok: true,
      answer: 'My answer engine is unreachable right now, so I cannot reason over the feed. Please browse the bill feed directly or try again in a bit.',
      citations: [],
      topic: 'busy',
      aiEnhanced: false,
      openStatesUsed: Boolean(OPEN_STATES_API_KEY),
    });
  }
  const answer = enforceProse(stripDisclaimer(aiAnswer));
  const cited = citationsFromAnswer(answer, [...bills, ...osResults], toCitation);
  return sendJson(res, 200, {
    ok: true,
    answer,
    citations: cited.slice(0, 3),
    topic: 'chat',
    aiEnhanced: true,
    openStatesUsed: Boolean(OPEN_STATES_API_KEY),
  });
}

async function handleLegislatorLookup(req, res, body) {
  if (legislatorRateLimiter(clientIp(req))) return sendJsonError(res, 429, 'Too many lookup requests. Please try again later.', 'rate_limited');
  const address = typeof body.address === 'string' ? sanitizedLookupInput(body.address) : '';
  if (!address) return sendJsonError(res, 400, 'Enter a Texas address or ZIP code.', 'invalid_address');
  if (address.length > MAX_ADDRESS_LENGTH) return sendJsonError(res, 400, 'That address is too long.', 'invalid_address');
  if (!isZipAddress(address) && !/[A-Za-z0-9]/.test(address)) return sendJsonError(res, 400, 'Enter a valid address or ZIP code.', 'invalid_address');
  try {
    const result = await findLegislators(address);
    return sendJson(res, 200, { ok: true, address, legislators: result.legislators, cached: result.cached });
  } catch (error) {
    const status = Number(error.status) || 502;
    const code = error.code || 'lookup_failed';
    const message = status >= 500 ? 'We could not complete that lookup right now. Please try again later.' : error.message;
    return sendJsonError(res, status, message, code);
  }
}


function sendJsonError(res, status, message, code, extra = {}) {
  return sendJson(res, status, { ok: false, error: message, code, ...extra });
}

/* ---------------------------------------------------------------------------
 * Profile email finalization (Finalize Email button on the profile page)
 * ------------------------------------------------------------------------- */

async function handleProfileEmailRequest(req, res, body) {
  pruneExpiredPendingCodes();
  const email = typeof body.email === 'string' ? body.email.trim() : '';

  // No access code on this endpoint by design. Abuse protection is the
  // per-IP rate limit plus the per-address send cooldown below.
  if (requestRateLimiter(clientIp(req))) {
    return sendJsonError(res, 429, 'Too many requests. Please wait a while and try again.', 'rate_limited');
  }
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return sendJsonError(res, 400, 'Please enter a valid email address.', 'invalid_email');
  }
  if (cooldownActive(email, PROFILE_EMAIL_PURPOSE)) {
    return sendJsonError(res, 429, 'Please wait a minute before requesting another code.', 'cooldown');
  }

  // Fresh random code every send; any previous pending code for this address
  // is replaced so only the newest one works.
  const code = generateCode();
  const salt = crypto.randomBytes(16).toString('hex');
  store.pendingCodes = store.pendingCodes.filter(
    (pending) => pending.key !== pendingKey(email, PROFILE_EMAIL_PURPOSE),
  );
  store.pendingCodes.push({
    key: pendingKey(email, PROFILE_EMAIL_PURPOSE),
    ...makeEmailFields(email),
    industry: PROFILE_EMAIL_PURPOSE,
    salt,
    codeHash: await hashCode(code, salt),
    expiresAt: Date.now() + CODE_EXPIRY_MS,
    attempts: 0,
    createdAt: new Date().toISOString(),
  });
  saveData(store);

  const expiryMinutes = CODE_EXPIRY_MINUTES;
  try {
    await sendProfileFinalizeEmail(email, { code, expiryMinutes });
  } catch (error) {
    // Roll back the pending code so a failed send can be retried.
    store.pendingCodes = store.pendingCodes.filter(
      (pending) => pending.key !== pendingKey(email, PROFILE_EMAIL_PURPOSE),
    );
    saveData(store);
    // The mail provider rejected the address (bad mailbox, blocked domain,
    // ...): say so plainly instead of a generic server error.
    const providerStatus = error && Number.isFinite(Number(error.status)) ? Number(error.status) : 0;
    if (providerStatus >= 400 && providerStatus < 500) {
      return sendJsonError(res, 400, 'Email Invalid', 'email_invalid');
    }
    throw error;
  }
  return sendJson(res, 200, {
    ok: true,
    message: 'A confirmation code is on its way to that address.',
  });
}

async function handleProfileEmailVerify(req, res, body) {
  pruneExpiredPendingCodes();
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const verificationCode = typeof body.code === 'string' ? body.code.trim() : '';
  const rawOldEmails = Array.isArray(body.oldEmails) ? body.oldEmails : [];
  const oldEmails = [...new Set(
    rawOldEmails
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value
        && value.length <= MAX_EMAIL_LENGTH
        && EMAIL_PATTERN.test(value)
        && value.toLowerCase() !== email.toLowerCase()),
  )].slice(0, 10);

  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return sendJsonError(res, 400, 'Please enter a valid email address.', 'invalid_email');
  }
  if (!CODE_PATTERN.test(verificationCode)) {
    return sendJsonError(res, 400, 'The confirmation code must be 6 digits.', 'invalid_code');
  }
  if (verifyRateLimiter(clientIp(req))) {
    return sendJsonError(res, 429, 'Too many verification attempts. Please wait a while and try again.', 'rate_limited');
  }

  const pending = findPending(email, PROFILE_EMAIL_PURPOSE);
  if (!pending) {
    return sendJsonError(res, 400, 'No pending confirmation was found for this address. Request a new code.', 'no_pending');
  }
  if (Date.now() > pending.expiresAt) {
    store.pendingCodes = store.pendingCodes.filter((p) => p !== pending);
    saveData(store);
    return sendJsonError(res, 400, 'This code has expired. Request a new one.', 'expired');
  }
  if (pending.attempts >= VERIFY_MAX_ATTEMPTS) {
    store.pendingCodes = store.pendingCodes.filter((p) => p !== pending);
    saveData(store);
    return sendJsonError(res, 429, 'Too many attempts. Request a new code.', 'too_many_attempts');
  }

  const matches = await codeMatches(verificationCode, pending);
  // Another concurrent request may have consumed this one-time code while
  // scrypt was running. Re-check the live store before changing state.
  if (findPending(email, PROFILE_EMAIL_PURPOSE) !== pending) {
    return sendJsonError(res, 400, 'No pending confirmation was found for this address. Request a new code.', 'no_pending');
  }
  if (!matches) {
    pending.attempts += 1;
    saveData(store);
    return sendJsonError(res, 400, 'That code is not correct. Please try again.', 'wrong_code');
  }

  // Code verified: consume it, then move any server subscriptions recorded
  // under the user's old address(es) to the new profile email.
  store.pendingCodes = store.pendingCodes.filter((p) => p !== pending);
  const moved = [];
  for (const oldEmail of oldEmails) {
    const records = store.subscriptions.filter(
      (subscription) => subscription && recordMatchesEmail(subscription, oldEmail),
    );
    for (const subscription of records) {
      delete subscription.email;
      Object.assign(subscription, makeEmailFields(email));
      delete subscription.unsubscribeTokenId;
      subscription.verifiedAt = new Date().toISOString();
      subscription.source = 'backend';
      moved.push({ industry: subscription.industry, oldEmail });
    }
  }
  saveData(store);

  if (moved.length) {
    const distinctOld = [...new Set(moved.map((entry) => entry.oldEmail))];
    try {
      await sendProfileMovedEmail(email, { moved, oldEmails: distinctOld });
    } catch (error) {
      // The move already succeeded; the confirmation is a courtesy, so a
      // delivery failure is logged but does not fail the request.
      console.error('Profile move confirmation email failed:', error.message);
    }
    for (const oldEmail of distinctOld) {
      try {
        await sendProfileMovedNoticeEmail(oldEmail, {
          newEmail: email,
          moved: moved.filter((entry) => entry.oldEmail === oldEmail),
        });
      } catch (error) {
        console.error('Profile move notice email failed:', error.message);
      }
    }
  }

  return sendJson(res, 200, {
    ok: true,
    message: moved.length
      ? `Email confirmed. Moved ${moved.length} subscription${moved.length === 1 ? '' : 's'} to ${email}.`
      : 'Email confirmed.',
    moved: moved.length,
  });
}

/* ---------------------------------------------------------------------------
 * Static file serving (the Lariat frontend)
 * ------------------------------------------------------------------------- */

function serveStatic(req, res, url) {
  if (url.href.length > MAX_REQUEST_URL_LENGTH) {
    return sendText(res, 414, 'text/plain; charset=utf-8', 'Request URI too long');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    return sendText(res, 400, 'text/plain; charset=utf-8', 'Bad request');
  }
  if (pathname === '/') pathname = '/index.html';

  // Never serve hidden files or folders (.env, .git, ...). Secrets and
  // source history live in dotfiles next to the public site, so any path
  // segment starting with a dot is rejected outright.
  if (pathname.split('/').some((segment) => segment.startsWith('.'))) {
    return sendText(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
  }

  const publicRoot = path.resolve(PUBLIC_DIR);
  const filePath = path.normalize(path.join(publicRoot, pathname));
  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
    return sendText(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
  }

  // The lexical path check above does not stop a symlink inside the public
  // directory from pointing outside it. Resolve the final path before reading
  // so a mistakenly added symlink cannot expose .env, source files, or data.
  fs.realpath(filePath, (realpathError, resolvedPath) => {
    if (realpathError) {
      if (realpathError.code === 'ENOENT') {
        return sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
      }
      return sendText(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    }
    if (resolvedPath !== publicRoot && !resolvedPath.startsWith(publicRoot + path.sep)) {
      return sendText(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    }

    fs.readFile(resolvedPath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        return sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
      }
      return sendText(res, 500, 'text/plain; charset=utf-8', 'Server error');
    }
    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    // HTML + JSON revalidate (a 304 when unchanged); versioned assets (css/js
    // already use ?v=...) may be cached for a day.
    const cacheControl = ext === '.html' || ext === '.json' ? 'no-cache' : 'public, max-age=86400';
    const etag = `"${crypto.createHash('sha1').update(content).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, {
        ETag: etag,
        'Cache-Control': cacheControl,
        'Vary': 'Accept-Encoding',
        ...SECURITY_HEADERS,
      });
      return res.end();
    }
    sendBody(res, 200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'ETag': etag,
      'Vary': 'Accept-Encoding',
      ...SECURITY_HEADERS,
    }, content);
    });
  });
}

/* ---------------------------------------------------------------------------
 * Request router
 * ------------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  try {
    if (String(req.url || '').length > MAX_REQUEST_URL_LENGTH) {
      return sendText(res, 414, 'text/plain; charset=utf-8', 'Request URI too long');
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // DNS-rebinding guard: only answer requests addressed to an allowlisted
    // Host header.
    if (!isTrustedHost(req.headers.host)) {
      return sendText(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    }

    // Production is HTTPS-only: redirect plain-HTTP requests the proxy
    // forwarded with X-Forwarded-Proto: http to the same HTTPS URL.
    if (enforceHttps(req, res, url)) return;

    // CORS preflight (needed if the frontend is served from a different origin).
    if (req.method === 'OPTIONS') {
      const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        ...SECURITY_HEADERS,
        ...corsHeadersFor(req),
      };
      res.writeHead(204, headers);
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (error) {
    // Last-resort safety net: never let one bad request kill the server.
    // Log only the method and the error message  -  never the request URL,
    // whose query string can carry a signed unsubscribe token.
    console.error('Unhandled request error:', req.method, error.message);
    if (!res.headersSent) {
      sendJsonError(res, 500, 'Internal server error', 'internal');
    } else {
      res.end();
    }
  }
});

// Bound request/header lifetimes prevent slow-client connections from holding
// the single-process server open indefinitely.
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.maxHeadersCount = 100;

async function handleApi(req, res, url) {
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // Access log: HTTP method and path only. The query string is deliberately
  // omitted because it can carry a signed unsubscribe token.
  console.log(`[api] ${req.method} ${pathname}`);

  try {
    if (pathname === '/api/health') {
      if (req.method !== 'GET') return sendJsonError(res, 405, 'Method not allowed', 'method');
      return sendJson(res, 200, {
        ok: true,
        service: 'lariat-backend',
        chatbotEngine: CHATBOT_ENGINE_VERSION,
      });
    }

    if (req.method !== 'POST') {
      return sendJsonError(res, 405, 'Method not allowed', 'method');
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const declaredLength = Number(req.headers['content-length']);
    const maxBodyLength = 100_000;
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyLength) {
      return sendJsonError(res, 413, 'Request body too large.', 'body_too_large');
    }
    if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
      return sendJsonError(res, 415, 'Content-Type must be application/json.', 'unsupported_media_type');
    }

    const body = await readJsonBody(req);

    switch (pathname) {
      case '/api/legislators/lookup':
        return await handleLegislatorLookup(req, res, body);
      case '/api/chat/ask':
        return await handleChatAsk(req, res, body);
      case '/api/profile/email/request':
        return await handleProfileEmailRequest(req, res, body);
      case '/api/profile/email/verify':
        return await handleProfileEmailVerify(req, res, body);
      default:
        return sendJsonError(res, 404, 'Unknown API endpoint', 'not_found');
    }
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('API request error:', error.message);
    return sendJsonError(res, status, status === 500 ? 'Internal server error' : error.message, status === 500 ? 'internal' : 'bad_request');
  }
}

/* ---------------------------------------------------------------------------
 * Start
 * ------------------------------------------------------------------------- */

server.listen(PORT, HOST, () => {
  const emailMode = BREVO_API_KEY ? `Brevo (${BREVO_FROM_EMAIL || 'sender not set  -  add BREVO_FROM_EMAIL to .env'})` : 'console mode (set BREVO_API_KEY to send real email)';
  console.log('Lariat backend running');
  console.log(`  Chatbot engine: v${CHATBOT_ENGINE_VERSION}`);
  console.log(`  Site + API:  http://${HOST}:${PORT}`);
  console.log(`  Email:       ${emailMode}`);
  console.log(`  Data file:   ${DATA_FILE}`);
  console.log(`  Email store: ${DATA_KEY ? 'encrypted at rest (AES-256-GCM)' : 'plaintext — set SUBSCRIPTION_DATA_KEY to encrypt stored emails'}`);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(normalizeHostname(HOST))) {
    console.log('  Warning: bound to a non-loopback address  -  the API is reachable from your network.');
  }
  if (IS_PRODUCTION) {
    console.log('  HTTPS:     enforced (plain-HTTP requests redirected, HSTS advertised)');
  }
  if (!BREVO_API_KEY) {
    console.log('  Tip: add BREVO_API_KEY and BREVO_FROM_EMAIL to .env to send real verification emails.');
  } else if (!BREVO_FROM_EMAIL) {
    console.log('  Tip: BREVO_FROM_EMAIL is empty  -  set it to a sender address you verified in Brevo.');
  }
});
