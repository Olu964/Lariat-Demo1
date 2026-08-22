#!/usr/bin/env node
'use strict';

/*
 * Lariat local backend
 * ====================
 * A zero-dependency Node.js server (Node 18+; no `npm install` required).
 *
 * It does two things:
 *
 *   1. Serves the Lariat frontend from ../Lariat-real so the whole site runs
 *      from one command:  node server/server.js  →  http://127.0.0.1:3000
 *
 *   2. Provides the subscription API that the frontend calls instead of the
 *      old client-side EmailJS flow:
 *
 *        POST /api/subscriptions/request      { email, industry, accessCode }
 *        POST /api/subscriptions/verify       { email, industry, verificationCode }
 *        POST /api/subscriptions/unsubscribe  { email, industry, token }  (signed token from /verify)
 *        GET  /api/subscriptions/unsubscribe?token=<signed>   (link in emails)
 *        GET  /api/health
 *
 * Email is sent through Brevo (https://www.brevo.com) when BREVO_API_KEY is
 * set. Brevo verifies a sender address by email (no domain required), so any
 * recipient can be reached on the free plan (300 emails/day). Without a key
 * the server runs in "console mode": verification codes and unsubscribe links
 * are printed to the terminal instead of emailed, so the entire flow can be
 * tested for free before any account is created.
 *
 * Every confirmed subscription gets a signed unsubscribe link (HMAC-SHA256)
 * sent in a welcome email, so users can stop alerts with one click and no
 * login. Tokens are signed with SUBSCRIPTION_SIGNING_SECRET (or a random
 * per-boot secret) and expire after SUBSCRIPTION_UNSUBSCRIBE_TOKEN_DAYS.
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
const PUBLIC_DIR = path.join(ROOT, 'Lariat-real');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'subscriptions.json');
const BILL_DATA_FILE = process.env.LARIAT_DATA_FILE
  || path.join(PUBLIC_DIR, 'texas_bill_summaries.json');

/* ---------------------------------------------------------------------------
 * Environment (.env parser — tiny, no dependency)
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
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL || '';
const DEFAULT_ACCESS_CODE = 'LARIAT-TRIAL-2026';
const ACCESS_CODE = process.env.SUBSCRIPTION_ACCESS_CODE || DEFAULT_ACCESS_CODE;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_HOSTS || '127.0.0.1,localhost,::1')
  .split(',').map((value) => value.trim().toLowerCase().replace(/^\\[|\\]$/g, '')).filter(Boolean));
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '')
  .split(',').map((value) => {
    try { return new URL(value.trim()).origin; } catch (error) { return ''; }
  }).filter(Boolean));
const CODE_EXPIRY_MS = (Math.max(1, Number(process.env.SUBSCRIPTION_CODE_EXPIRY_MINUTES) || 10)) * 60 * 1000;
const REQUEST_COOLDOWN_MS = 60 * 1000;          // min time between codes for one address
const VERIFY_MAX_ATTEMPTS = 5;                   // wrong-code tries before the code is voided
const ACCESS_CODE_MAX_ATTEMPTS = 3;              // wrong private-code tries before lockout
const ACCESS_CODE_LOCKOUT_MS = 24 * 60 * 60 * 1000;
const IP_RATE_LIMIT = { windowMs: 60 * 60 * 1000, max: 10 }; // /request calls per IP per hour
const UNSUBSCRIBE_TOKEN_DAYS = Math.max(1, Number(process.env.SUBSCRIPTION_UNSUBSCRIBE_TOKEN_DAYS) || 90);
const SIGNING_SECRET = process.env.SUBSCRIPTION_SIGNING_SECRET || crypto.randomBytes(32).toString('hex');
// Keep local-development lockouts stable across restarts without reusing the
// random unsubscribe-token secret; production uses the configured secret.
const ACCESS_CODE_LOCKOUT_SECRET = process.env.SUBSCRIPTION_SIGNING_SECRET
  || crypto.createHash('sha256').update(`lariat-access-lockouts:${ROOT}:${ACCESS_CODE}`).digest('hex');
const MAX_EMAIL_LENGTH = 254;
const MAX_INDUSTRY_LENGTH = 200;
const MAX_ACCESS_CODE_LENGTH = 256;
const MAX_TOKEN_LENGTH = 4096;
const IS_PRODUCTION = NODE_ENV === 'production';

/* Security headers applied to every response. The small HTML pages the server
 * generates itself get an extra CSP in sendHtmlPage(). */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
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
 * a preflight) refuses the request entirely — so malicious websites cannot
 * drive this local server through a visitor's browser. */
function trustedOrigin(origin) {
  if (!origin) return '';
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const hostname = url.hostname.toLowerCase().replace(/^\\[|\\]$/g, '');
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
    return parsed.hostname.toLowerCase().replace(/^\\[|\\]$/g, '');
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
 * X-Forwarded-Proto header. Enforce HTTPS-only: any request the proxy
 * forwarded as plain HTTP is redirected to the same HTTPS URL. The query
 * string is preserved so unsubscribe links keep working; nothing here is
 * written to logs. Requests with no X-Forwarded-Proto header (local
 * development, or a proxy that does not set it) are passed through. */
function enforceHttps(req, res, url) {
  if (!IS_PRODUCTION) return false;
  const scheme = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (scheme !== 'http') return false;
  const target = new URL(url.href);
  target.protocol = 'https:';
  if (target.port === '80') target.port = '';
  res.writeHead(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, {
    Location: target.href,
    ...SECURITY_HEADERS,
  });
  res.end();
  return true;
}

/* Constant-time comparison for secrets such as the private access code. */
function constantTimeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^[0-9]{6}$/;

function validateConfiguration() {
  if (!BREVO_API_KEY && BREVO_FROM_EMAIL) {
    throw new Error('BREVO_FROM_EMAIL requires BREVO_API_KEY, or remove the sender address.');
  }
  if (IS_PRODUCTION) {
    if (ACCESS_CODE === DEFAULT_ACCESS_CODE || ACCESS_CODE.length < 12) {
      throw new Error('Production requires a unique SUBSCRIPTION_ACCESS_CODE of at least 12 characters.');
    }
    if (!process.env.SUBSCRIPTION_SIGNING_SECRET || SIGNING_SECRET.length < 32) {
      throw new Error('Production requires SUBSCRIPTION_SIGNING_SECRET with at least 32 characters.');
    }
    if (!BREVO_API_KEY || !EMAIL_PATTERN.test(BREVO_FROM_EMAIL)) {
      throw new Error('Production requires BREVO_API_KEY and a valid verified BREVO_FROM_EMAIL.');
    }
    if (!PUBLIC_BASE_URL) {
      throw new Error('Production requires PUBLIC_BASE_URL, including the https:// scheme.');
    }
    let publicUrl;
    try { publicUrl = new URL(PUBLIC_BASE_URL); } catch (error) { publicUrl = null; }
    if (!publicUrl || publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
      throw new Error('Production PUBLIC_BASE_URL must be a clean https:// URL without credentials or query parameters.');
    }
    if (!ALLOWED_HOSTS.has(publicUrl.hostname.toLowerCase().replace(/^\\[|\\]$/g, ''))) {
      throw new Error('Production PUBLIC_BASE_URL hostname must be included in ALLOWED_HOSTS.');
    }
  }
}
validateConfiguration();

/* ---------------------------------------------------------------------------
 * Data store (server/data/subscriptions.json)
 * ------------------------------------------------------------------------- */

function defaultData() {
  return { subscriptions: [], pendingCodes: [], accessCodeAttempts: [] };
}

function loadData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
      // Discard records from the pre-scrypt format rather than retaining
      // weakly protected six-digit verification hashes.
      pendingCodes: Array.isArray(parsed.pendingCodes)
        ? parsed.pendingCodes.filter((pending) => typeof pending?.codeHash === 'string' && pending.codeHash.startsWith('scrypt$'))
        : [],
      // Access-code lockouts are keyed by an HMAC of the client IP rather than
      // storing the IP itself. They survive normal restarts when the signing
      // secret is fixed, while keeping the raw network address out of storage.
      accessCodeAttempts: Array.isArray(parsed.accessCodeAttempts)
        ? parsed.accessCodeAttempts.filter((attempt) => typeof attempt?.key === 'string'
          && Number.isFinite(Number(attempt.firstFailureAt))
          && Number.isFinite(Number(attempt.attempts)))
        : [],
    };
  } catch (error) {
    return defaultData();
  }
}

function saveData(store) {
  // The file holds subscriber emails and unsubscribe tokens: keep it and its
  // directory readable only by the user running the server.
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DATA_DIR, 0o700);
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.chmodSync(tmpFile, 0o600);
  fs.renameSync(tmpFile, DATA_FILE);
}

const store = loadData();

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
 * into Node — no dependency) so a leaked data file cannot be brute-forced
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

/* Signed unsubscribe tokens (HMAC-SHA256, tamper-proof, expiring). */
function signToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SIGNING_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyToken(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(parts[0]).digest('base64url');
    const received = Buffer.from(parts[1]);
    const expectedBuffer = Buffer.from(expected);
    if (received.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(received, expectedBuffer)) return null;
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof payload.email !== 'string' || typeof payload.industry !== 'string') return null;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function makeUnsubscribeToken(email, industry) {
  return signToken({ email, industry, exp: Date.now() + UNSUBSCRIBE_TOKEN_DAYS * 86_400_000 });
}

function baseUrl() {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return `http://${HOST}:${PORT}`;
}

// The industry list only changes when the dataset is regenerated, so parse the
// JSON at most once a minute instead of on every request.
let industriesCache = { at: 0, list: null };
const INDUSTRIES_TTL_MS = 60 * 1000;

function validIndustries() {
  const now = Date.now();
  if (industriesCache.list && now - industriesCache.at < INDUSTRIES_TTL_MS) {
    return industriesCache.list;
  }
  let list = [];
  try {
    const bills = JSON.parse(fs.readFileSync(BILL_DATA_FILE, 'utf8'));
    if (Array.isArray(bills)) {
      list = [...new Set(bills
        .map((bill) => (bill && typeof bill.industry === 'string' ? bill.industry.trim() : ''))
        .filter((industry) => industry && industry !== 'N/A'))];
    }
  } catch (error) { /* keep the empty list */ }
  industriesCache = { at: now, list };
  return list;
}

const pendingKey = (email, industry) => `${email.toLowerCase()}::${industry}`;

function findPending(email, industry) {
  const key = pendingKey(email, industry);
  return store.pendingCodes.find((pending) => pending.key === key) || null;
}

function findSubscription(email, industry) {
  return store.subscriptions.find(
    (subscription) => subscription.email.toLowerCase() === email.toLowerCase()
      && subscription.industry === industry,
  ) || null;
}

/* ---------------------------------------------------------------------------
 * Email (Brevo REST API — uses global fetch, so no SDK needed)
 * ------------------------------------------------------------------------- */

function safeEmailSubject(value) {
  return String(value ?? '').replace(/[\\r\\n]/g, ' ').slice(0, 200);
}

function buildVerificationEmail({ industry, code, expiryMinutes }) {
  const safeIndustry = escapeHtml(industry);
  return {
    subject: safeEmailSubject(`Confirm your Lariat subscription — ${industry} alerts`),
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #1c3a52;">
        <h1 style="font-size: 22px; margin: 0 0 14px;">Confirm your Lariat subscription</h1>
        <p style="font-size: 14px; line-height: 1.6;">You requested bill alerts for the
          <strong>${safeIndustry}</strong> industry.</p>
        <p style="font-size: 14px; line-height: 1.6;">Your verification code is:</p>
        <p style="font-size: 30px; font-weight: bold; letter-spacing: 4px; margin: 12px 0;">${code}</p>
        <p style="font-size: 13px; color: #5a7285; line-height: 1.6;">
          This code expires in ${expiryMinutes} minutes and can only be used once.</p>
        <p style="font-size: 13px; color: #5a7285; line-height: 1.6;">
          If you did not request this subscription, you can safely ignore this email.</p>
      </div>
    `,
  };
}

function buildWelcomeEmail({ industry, unsubscribeUrl }) {
  const safeIndustry = escapeHtml(industry);
  const safeUnsubscribeUrl = escapeHtml(unsubscribeUrl);
  return {
    subject: safeEmailSubject(`You're subscribed to Lariat ${industry} alerts`),
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #1c3a52;">
        <h1 style="font-size: 22px; margin: 0 0 14px;">You're subscribed</h1>
        <p style="font-size: 14px; line-height: 1.6;">You'll receive Lariat bill alerts for the
          <strong>${safeIndustry}</strong> industry.</p>
        <p style="font-size: 14px; line-height: 1.6;">To stop these alerts at any time, click the link below
          (no login needed):</p>
        <p style="margin: 18px 0;">
          <a href="${safeUnsubscribeUrl}" style="display: inline-block; padding: 11px 18px; border-radius: 6px; background: #16334f; color: #ffffff; font-size: 13px; font-weight: bold; text-decoration: none;">
            Unsubscribe from ${safeIndustry} alerts
          </a>
        </p>
        <p style="font-size: 13px; color: #5a7285; line-height: 1.6;">
          If you did not request this subscription, you can unsubscribe with the link above.</p>
      </div>
    `,
  };
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

async function sendVerificationEmail(email, { industry, code, expiryMinutes }) {
  const { subject, html } = buildVerificationEmail({ industry, code, expiryMinutes });
  return deliverEmail(email, { subject, html, consoleText: `verification code: ${code} (valid ${expiryMinutes} min)` });
}

async function sendWelcomeEmail(email, { industry, unsubscribeUrl }) {
  const { subject, html } = buildWelcomeEmail({ industry, unsubscribeUrl });
  return deliverEmail(email, { subject, html, consoleText: `unsubscribe link: ${unsubscribeUrl}` });
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
  const acceptsGzip = /gzip/.test(String((req.headers && req.headers['accept-encoding']) || ''));
  if (acceptsGzip && body.length > 512) {
    const compressed = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
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
function sendHtmlPage(res, status, title, message) {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lariat — ${escapeHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fbfc; color: #1c3a52; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
  .card { width: min(440px, calc(100% - 48px)); padding: 34px 30px; border: 1px solid #d6e3ea; border-radius: 14px; background: #ffffff; box-shadow: 0 18px 50px rgba(7,26,45,.10); text-align: center; }
  .mark { display: inline-block; margin-bottom: 14px; color: #277fbb; font-size: 11px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
  h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.25; }
  p { margin: 0; color: #5a7285; font-size: 14px; line-height: 1.65; }
</style>
</head>
<body><main class="card"><span class="mark">Lariat</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;
  return sendText(res, status, 'text/html; charset=utf-8', body, {
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  });
}

function sendUnsubscribeConfirmation(res, token, payload) {
  const safeToken = escapeHtml(token);
  const safeIndustry = escapeHtml(payload.industry);
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lariat — Confirm unsubscribe</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fbfc; color: #1c3a52; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
  .card { width: min(440px, calc(100% - 48px)); padding: 34px 30px; border: 1px solid #d6e3ea; border-radius: 14px; background: #ffffff; box-shadow: 0 18px 50px rgba(7,26,45,.10); text-align: center; }
  .mark { display: inline-block; margin-bottom: 14px; color: #277fbb; font-size: 11px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
  h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.25; }
  p { margin: 0 0 20px; color: #5a7285; font-size: 14px; line-height: 1.65; }
  button { border: 0; border-radius: 6px; padding: 11px 18px; background: #16334f; color: #ffffff; font: inherit; font-weight: 700; cursor: pointer; }
</style>
</head>
<body><main class="card"><span class="mark">Lariat</span><h1>Stop ${safeIndustry} alerts?</h1><p>Confirm below to unsubscribe from this industry's Lariat alerts.</p><form method="post" action="/api/subscriptions/unsubscribe?token=${safeToken}"><button type="submit">Confirm unsubscribe</button></form></main></body>
</html>`;
  return sendText(res, 200, 'text/html; charset=utf-8', body, {
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  });
}

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
        req.destroy();
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

function accessCodeAttemptKey(req) {
  return crypto.createHmac('sha256', ACCESS_CODE_LOCKOUT_SECRET).update(clientIp(req)).digest('hex');
}

function pruneAccessCodeAttempts() {
  const now = Date.now();
  const remaining = store.accessCodeAttempts.filter((attempt) => {
    const firstFailureAt = Number(attempt.firstFailureAt);
    const lockedUntil = Number(attempt.lockedUntil || 0);
    return (lockedUntil > now && lockedUntil <= now + ACCESS_CODE_LOCKOUT_MS)
      || (!lockedUntil && now - firstFailureAt <= ACCESS_CODE_LOCKOUT_MS);
  });
  if (remaining.length !== store.accessCodeAttempts.length) {
    store.accessCodeAttempts = remaining;
    saveData(store);
  }
}

function activeAccessCodeLockout(req) {
  const key = accessCodeAttemptKey(req);
  const attempt = store.accessCodeAttempts.find((entry) => entry.key === key);
  if (!attempt) return null;
  if (Number(attempt.lockedUntil) > Date.now()) return attempt;
  if (Number(attempt.lockedUntil) || Date.now() - Number(attempt.firstFailureAt) > ACCESS_CODE_LOCKOUT_MS) {
    store.accessCodeAttempts = store.accessCodeAttempts.filter((entry) => entry !== attempt);
    saveData(store);
    return null;
  }
  return null;
}

function recordFailedAccessCode(req) {
  const key = accessCodeAttemptKey(req);
  const now = Date.now();
  let attempt = store.accessCodeAttempts.find((entry) => entry.key === key);
  if (!attempt || now - Number(attempt.firstFailureAt) > ACCESS_CODE_LOCKOUT_MS) {
    attempt = { key, attempts: 0, firstFailureAt: now };
    store.accessCodeAttempts.push(attempt);
  }
  attempt.attempts += 1;
  if (attempt.attempts >= ACCESS_CODE_MAX_ATTEMPTS) {
    attempt.lockedUntil = now + ACCESS_CODE_LOCKOUT_MS;
  }
  saveData(store);
  return attempt;
}

function clearAccessCodeAttempts(req) {
  const key = accessCodeAttemptKey(req);
  const remaining = store.accessCodeAttempts.filter((entry) => entry.key !== key);
  if (remaining.length !== store.accessCodeAttempts.length) {
    store.accessCodeAttempts = remaining;
    saveData(store);
  }
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
const unsubscribeRateLimiter = makeRateLimiter(60 * 60 * 1000, 25);                      // POST /unsubscribe per IP per hour

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
  unsubscribeRateLimiter.prune();
  const now = Date.now();
  for (const [key, last] of requestCooldowns) {
    if (now - last >= REQUEST_COOLDOWN_MS * 2) requestCooldowns.delete(key);
  }
  pruneAccessCodeAttempts();
}, 60 * 60 * 1000).unref();

/* ---------------------------------------------------------------------------
 * API handlers
 * ------------------------------------------------------------------------- */

async function handleRequestCode(req, res, body) {
  pruneExpiredPendingCodes();
  pruneAccessCodeAttempts();
  const lockout = activeAccessCodeLockout(req);
  if (lockout) {
    const retryAfterSeconds = Math.max(1, Math.ceil((Number(lockout.lockedUntil) - Date.now()) / 1000));
    return sendJsonError(
      res,
      429,
      'Too many incorrect access-code attempts. Subscription requests are locked for 24 hours.',
      'access_code_locked',
      { lockoutUntil: new Date(Number(lockout.lockedUntil)).toISOString(), retryAfterSeconds },
    );
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const industry = typeof body.industry === 'string' ? body.industry.trim() : '';
  const accessCode = typeof body.accessCode === 'string' ? body.accessCode : '';

  if (requestRateLimiter(clientIp(req))) {
    return sendJsonError(res, 429, 'Too many requests. Please wait a while and try again.', 'rate_limited');
  }
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return sendJsonError(res, 400, 'Please enter a valid email address.', 'invalid_email');
  }
  if (industry.length > MAX_INDUSTRY_LENGTH || !validIndustries().includes(industry)) {
    return sendJsonError(res, 400, 'That industry is not part of the current dataset.', 'invalid_industry');
  }
  if (accessCode.length > MAX_ACCESS_CODE_LENGTH || !accessCode) {
    return sendJsonError(res, 400, 'Please enter the private access code.', 'missing_access_code');
  }
  if (!constantTimeEqual(accessCode, ACCESS_CODE)) {
    const failedAttempt = recordFailedAccessCode(req);
    if (failedAttempt.lockedUntil) {
      const retryAfterSeconds = Math.max(1, Math.ceil((Number(failedAttempt.lockedUntil) - Date.now()) / 1000));
      return sendJsonError(
        res,
        429,
        'Too many incorrect access-code attempts. Subscription requests are locked for 24 hours.',
        'access_code_locked',
        { lockoutUntil: new Date(Number(failedAttempt.lockedUntil)).toISOString(), retryAfterSeconds },
      );
    }
    const attemptsRemaining = ACCESS_CODE_MAX_ATTEMPTS - Number(failedAttempt.attempts);
    return sendJsonError(
      res,
      403,
      `That private access code is not correct. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} remaining before a 24-hour lockout.`,
      'bad_access_code',
      { attemptsRemaining },
    );
  }
  clearAccessCodeAttempts(req);
  if (cooldownActive(email, industry)) {
    return sendJsonError(res, 429, 'Please wait a minute before requesting another code.', 'cooldown');
  }

  // Reply the same way whether or not this address is already subscribed, so
  // the API does not leak subscription status. Already-subscribed addresses
  // get no email (saves quota) but the response looks identical.
  if (findSubscription(email, industry)) {
    return genericCodeResponse(res);
  }

  const code = generateCode();
  const salt = crypto.randomBytes(16).toString('hex');
  store.pendingCodes = store.pendingCodes.filter(
    (pending) => pending.key !== pendingKey(email, industry),
  );
  store.pendingCodes.push({
    key: pendingKey(email, industry),
    email,
    industry,
    salt,
    codeHash: await hashCode(code, salt),
    expiresAt: Date.now() + CODE_EXPIRY_MS,
    attempts: 0,
    createdAt: new Date().toISOString(),
  });
  saveData(store);

  const expiryMinutes = Math.round(CODE_EXPIRY_MS / 60_000);
  try {
    await sendVerificationEmail(email, { industry, code, expiryMinutes });
  } catch (error) {
    // Roll back the pending code so a failed send can be retried.
    store.pendingCodes = store.pendingCodes.filter(
      (pending) => pending.key !== pendingKey(email, industry),
    );
    saveData(store);
    throw error;
  }
  return genericCodeResponse(res);
}

function genericCodeResponse(res) {
  return sendJson(res, 200, {
    ok: true,
    message: 'If this address is not already subscribed, a verification code is on its way.',
  });
}

function sendJsonError(res, status, message, code, extra = {}) {
  return sendJson(res, status, { ok: false, error: message, code, ...extra });
}

async function handleVerifyCode(req, res, body) {
  pruneExpiredPendingCodes();
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const industry = typeof body.industry === 'string' ? body.industry.trim() : '';
  const verificationCode = typeof body.verificationCode === 'string' ? body.verificationCode.trim() : '';

  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return sendJsonError(res, 400, 'Please enter a valid email address.', 'invalid_email');
  if (industry.length > MAX_INDUSTRY_LENGTH) return sendJsonError(res, 400, 'Industry is invalid.', 'invalid_industry');
  if (!CODE_PATTERN.test(verificationCode))    return sendJsonError(res, 400, 'The verification code must be 6 digits.', 'invalid_code');
  if (verifyRateLimiter(clientIp(req))) {
    return sendJsonError(res, 429, 'Too many verification attempts. Please wait a while and try again.', 'rate_limited');
  }

  const pending = findPending(email, industry);
  if (!pending) {
    return sendJsonError(res, 400, 'No pending verification was found for this address. Request a new code.', 'no_pending');
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
  if (!matches) {
    pending.attempts += 1;
    saveData(store);
    return sendJsonError(res, 400, 'That code is not correct. Please try again.', 'wrong_code');
  }

  // Code verified: remove the pending record and upsert the subscription.
  store.pendingCodes = store.pendingCodes.filter((p) => p !== pending);
  let subscription = findSubscription(email, industry);
  if (subscription) {
    subscription.verifiedAt = new Date().toISOString();
    subscription.source = 'backend';
  } else {
    subscription = {
      email,
      industry,
      verifiedAt: new Date().toISOString(),
      source: 'backend',
    };
    store.subscriptions.push(subscription);
  }
  subscription.unsubscribeToken = makeUnsubscribeToken(email, industry);
  saveData(store);

  // Welcome email carries a signed unsubscribe link (no login); the link opens
  // a confirmation page so automated scanners cannot mutate subscription state.
  const unsubscribeUrl = `${baseUrl()}/api/subscriptions/unsubscribe?token=${encodeURIComponent(subscription.unsubscribeToken)}`;
  sendWelcomeEmail(email, { industry, unsubscribeUrl }).catch((error) => {
    console.error('Could not send the welcome email:', error.message);
  });

  return sendJson(res, 200, {
    ok: true,
    message: `You're subscribed to ${industry} alerts.`,
    subscription: { email, industry, verifiedAt: subscription.verifiedAt },
    unsubscribeUrl,
    unsubscribeToken: subscription.unsubscribeToken,
  });
}

/**
 * Handles a signed unsubscribe link clicked from an email. The token encodes
 * the email + industry and is HMAC-signed, so it cannot be forged or edited;
 * it also expires. Renders a small HTML page since it is opened in a browser.
 */
function removeSubscription(payload) {
  const before = store.subscriptions.length;
  store.subscriptions = store.subscriptions.filter(
    (subscription) => !(subscription.email.toLowerCase() === payload.email.toLowerCase() && subscription.industry === payload.industry),
  );
  const removed = store.subscriptions.length !== before;
  if (removed) saveData(store);
  return removed;
}

function handleUnsubscribeLink(res, url) {
  const token = url.searchParams.get('token') || '';
  if (token.length > MAX_TOKEN_LENGTH) {
    return sendHtmlPage(res, 400, 'Unsubscribe link invalid', 'This unsubscribe link is invalid or has expired.');
  }
  const payload = verifyToken(token);
  if (!payload) {
    return sendHtmlPage(
      res,
      400,
      'Unsubscribe link invalid',
      'This unsubscribe link is invalid or has expired. You can manage alerts from the Unsubscribe button on the Lariat bill feed.',
    );
  }

  // Do not mutate state on GET: mail scanners and browser prefetchers commonly
  // follow links automatically. The user must explicitly confirm the POST.
  return sendUnsubscribeConfirmation(res, token, payload);
}

function handleUnsubscribeToken(req, res, token) {
  if (token.length > MAX_TOKEN_LENGTH || unsubscribeRateLimiter(clientIp(req))) {
    return sendHtmlPage(res, 429, 'Please try again later', 'This unsubscribe request could not be completed right now.');
  }
  const payload = verifyToken(token);
  if (!payload) {
    return sendHtmlPage(res, 400, 'Unsubscribe link invalid', 'This unsubscribe link is invalid or has expired.');
  }
  const removed = removeSubscription(payload);
  return sendHtmlPage(
    res,
    200,
    removed ? 'Unsubscribed from Lariat alerts' : 'Nothing to change',
    removed
      ? `${payload.email} is no longer subscribed to ${payload.industry} alerts. You can resubscribe anytime from the Lariat bill feed.`
      : `${payload.email} was not subscribed to ${payload.industry} alerts — nothing to change.`,
  );
}

function handleUnsubscribe(req, res, body) {
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const industry = typeof body.industry === 'string' ? body.industry.trim() : '';
  const token = typeof body.token === 'string' ? body.token : '';

  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return sendJsonError(res, 400, 'Please enter a valid email address.', 'invalid_email');
  if (industry.length > MAX_INDUSTRY_LENGTH) return sendJsonError(res, 400, 'Industry is invalid.', 'invalid_industry');
  if (token.length > MAX_TOKEN_LENGTH) return sendJsonError(res, 400, 'Unsubscribe token is invalid.', 'bad_token');
  if (!industry)    return sendJsonError(res, 400, 'Industry is required.', 'invalid_industry');
  if (unsubscribeRateLimiter(clientIp(req))) {
    return sendJsonError(res, 429, 'Too many requests. Please wait a while and try again.', 'rate_limited');
  }

  // Unsubscribing requires proof of ownership of the address: the signed token
  // issued when the address verified. Without it, any website the user visits
  // could drop them from alerts by guessing their address + industry.
  const payload = verifyToken(token);
  if (!payload || payload.email.toLowerCase() !== email.toLowerCase() || payload.industry !== industry) {
    return sendJsonError(res, 403, 'Please use the unsubscribe link from your welcome email, or resubscribe to get a fresh one.', 'bad_token');
  }

  removeSubscription({ email, industry });

  return sendJson(res, 200, { ok: true, message: `Unsubscribed from ${industry} alerts.` });
}

/* ---------------------------------------------------------------------------
 * Static file serving (the Lariat frontend)
 * ------------------------------------------------------------------------- */

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    return sendText(res, 400, 'text/plain; charset=utf-8', 'Bad request');
  }
  if (pathname === '/') pathname = '/index.html';

  const publicRoot = path.resolve(PUBLIC_DIR);
  const filePath = path.normalize(path.join(publicRoot, pathname));
  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
    return sendText(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        return sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
      }
      return sendText(res, 500, 'text/plain; charset=utf-8', 'Server error');
    }
    const ext = path.extname(filePath).toLowerCase();
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
}

/* ---------------------------------------------------------------------------
 * Request router
 * ------------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  try {
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
    // Log only the method and the error message — never the request URL,
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
        email: BREVO_API_KEY ? 'brevo' : 'console-mode',
      });
    }

    // Signed unsubscribe link clicked from an email (opens a confirmation page).
    if (pathname === '/api/subscriptions/unsubscribe' && req.method === 'GET') {
      return handleUnsubscribeLink(res, url);
    }

    if (req.method !== 'POST') {
      return sendJsonError(res, 405, 'Method not allowed', 'method');
    }

    // The confirmation form carries only the signed token in the query string;
    // handling it separately avoids accepting browser form posts for the JSON API.
    if (pathname === '/api/subscriptions/unsubscribe' && url.searchParams.has('token')) {
      return handleUnsubscribeToken(req, res, url.searchParams.get('token') || '');
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
      return sendJsonError(res, 415, 'Content-Type must be application/json.', 'unsupported_media_type');
    }

    const body = await readJsonBody(req);

    switch (pathname) {
      case '/api/subscriptions/request':
        return await handleRequestCode(req, res, body);
      case '/api/subscriptions/verify':
        return await handleVerifyCode(req, res, body);
      case '/api/subscriptions/unsubscribe':
        return handleUnsubscribe(req, res, body);
      default:
        return sendJsonError(res, 404, 'Unknown API endpoint', 'not_found');
    }
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    return sendJsonError(res, status, status === 500 ? 'Internal server error' : error.message, status === 500 ? 'internal' : 'bad_request');
  }
}

/* ---------------------------------------------------------------------------
 * Start
 * ------------------------------------------------------------------------- */

server.listen(PORT, HOST, () => {
  const emailMode = BREVO_API_KEY ? `Brevo (${BREVO_FROM_EMAIL || 'sender not set — add BREVO_FROM_EMAIL to .env'})` : 'console mode (set BREVO_API_KEY to send real email)';
  console.log('Lariat backend running');
  console.log(`  Site + API:  http://${HOST}:${PORT}`);
  console.log(`  Email:       ${emailMode}`);
  console.log(`  Access code: ${process.env.SUBSCRIPTION_ACCESS_CODE ? 'configured' : 'default development code'}`);
  console.log(`  Data file:   ${DATA_FILE}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '[::1]' && HOST !== '::1') {
    console.log('  Warning: bound to a non-loopback address — the API is reachable from your network.');
  }
  if (IS_PRODUCTION) {
    console.log('  HTTPS:     enforced (plain-HTTP requests redirected, HSTS advertised)');
  }
  if (!BREVO_API_KEY) {
    console.log('  Tip: add BREVO_API_KEY and BREVO_FROM_EMAIL to .env to send real verification emails.');
  } else if (!BREVO_FROM_EMAIL) {
    console.log('  Tip: BREVO_FROM_EMAIL is empty — set it to a sender address you verified in Brevo.');
  }
  if (!process.env.SUBSCRIPTION_SIGNING_SECRET) {
    console.log('  Note: SUBSCRIPTION_SIGNING_SECRET not set — unsubscribe links reset on restart.');
  }
});
