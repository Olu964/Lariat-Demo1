'use strict';

/*
 * Vercel serverless function: industry unsubscribe.
 *
 *   POST /api/subscriptions/unsubscribe   { email, industry }  (page toggle)
 *   GET  /api/subscriptions/unsubscribe?token=…                (email link)
 *
 * Stateless port of handleIndustryUnsubscribe / handleUnsubscribeLink in
 * server/server.js. The GET confirmation page is deliberately plain markup —
 * no inline styles — because the site-wide CSP in vercel.json only allows
 * styles from 'self'.
 */

const lib = require('../_lib/lariat');

function sendPage(res, status, messageHtml) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribe — Lariat</title>
</head>
<body>
  <main>
    <h1>Lariat subscriptions</h1>
    <p>${messageHtml}</p>
    <p><a href="/your-bills.html">Back to Your Saves</a> · <a href="/feed.html">Bill feed</a></p>
  </main>
</body>
</html>`;
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
}

function tokenFromRequest(req) {
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('token') || '';
  } catch (error) {
    return '';
  }
}

// GET — signed link from the confirmation email. The token proves the email
// + industry (HMAC, expiring); re-clicks stay idempotent once removed.
async function handleLink(req, res) {
  if (await lib.rateLimited('unsubscribe-link', lib.clientIp(req), 60 * 60, 60)) {
    return sendPage(res, 429, 'Too many requests. Please try again later.');
  }
  const payload = lib.verifyToken(tokenFromRequest(req));
  if (!payload) {
    return sendPage(res, 400, 'This unsubscribe link is invalid or has expired.');
  }
  try {
    lib.requireCore();
    const subscription = await lib.findSubscription(payload.email, payload.industry);
    // Same replay rule as the local backend: the stored tokenId only adds
    // rotation protection; records without one still remove.
    if (subscription && (!subscription.unsubscribeTokenId || subscription.unsubscribeTokenId === payload.tokenId)) {
      await lib.deleteSubscription(payload.email, payload.industry);
    }
  } catch (error) {
    console.error('Unsubscribe link failed:', error.message);
    return sendPage(res, 503, 'Subscriptions are temporarily unavailable. Please try again in a moment.');
  }
  return sendPage(res, 200, `You are unsubscribed from <strong>${lib.escapeHtml(payload.industry)}</strong> updates.`);
}

// POST — the Unsubscribe button on Your Saves. Idempotent.
async function handlePost(req, res) {
  lib.requireCore();
  const ip = lib.clientIp(req);
  const body = await lib.readJsonBody(req);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const industry = typeof body.industry === 'string' ? body.industry.trim() : '';

  if (industry.length > lib.MAX_INDUSTRY_LENGTH || !industry) {
    return lib.sendErr(res, 400, 'That industry is not valid.', 'invalid_industry');
  }
  if (email && (email.length > lib.MAX_EMAIL_LENGTH || !lib.EMAIL_PATTERN.test(email))) {
    return lib.sendErr(res, 400, 'Please enter a valid email address.', 'invalid_email');
  }
  if (await lib.rateLimited('unsubscribe', ip, 60 * 60, 60)) {
    return lib.sendErr(res, 429, 'Too many requests. Please wait a while and try again.', 'rate_limited');
  }

  // Without an address nothing can be matched safely — report a clean no-op.
  if (!email) {
    return lib.sendJson(res, 200, { ok: true, removed: 0, message: `No subscription for ${industry}.` });
  }
  const existing = await lib.findSubscription(email, industry);
  if (existing) {
    await lib.deleteSubscription(email, industry);
    // Courtesy notice: delivery failure is logged only — the unsubscribe
    // already happened and is never undone for a courtesy email.
    try {
      await lib.sendUnsubscribeNoticeEmail(email, { industry, resubscribeUrl: `${lib.baseUrl(req)}/your-bills.html` });
    } catch (error) {
      console.error('Unsubscribe notice email failed:', error.message);
    }
  }
  return lib.sendJson(res, 200, {
    ok: true,
    removed: existing ? 1 : 0,
    message: existing ? `Unsubscribed from ${industry}.` : `No subscription for ${industry}.`,
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') return await handleLink(req, res);
    if (req.method === 'POST') return await handlePost(req, res);
    return lib.sendErr(res, 405, 'Method not allowed', 'method');
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('API request error:', error.message);
    return lib.sendErr(res, status, status === 500 ? 'Internal server error' : error.message, status === 500 ? 'internal' : 'bad_request');
  }
};
