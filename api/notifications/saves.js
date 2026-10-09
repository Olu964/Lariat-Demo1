'use strict';

/*
 * Vercel serverless function: saved-bill sync for notification digests.
 *
 *   POST /api/notifications/saves   { email, billIds[] }
 *
 * The browser's profile keeps saved bills in localStorage only; this endpoint
 * mirrors the list server-side (encrypted email, HMAC index — same shapes as
 * subscriptions) so the daily dispatch can watch those bills for updates.
 * Full replace: the posted list becomes the complete saved set for the
 * address. Requires a finalized profile email on the client; the server
 * validates shape, rate limits, and encrypts — same trust model as the
 * industry-subscribe gate.
 */

const lib = require('../_lib/lariat');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return lib.sendErr(res, 405, 'Method not allowed', 'method');
  try {
    lib.requireCore();
    const ip = lib.clientIp(req);
    const body = await lib.readJsonBody(req);
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const rawIds = Array.isArray(body.billIds) ? body.billIds : [];

    if (email.length > lib.MAX_EMAIL_LENGTH || !lib.EMAIL_PATTERN.test(email)) {
      return lib.sendErr(res, 400, 'Please enter a valid email address.', 'invalid_email');
    }
    if (rawIds.length > lib.MAX_SAVED_BILLS) {
      return lib.sendErr(res, 400, `At most ${lib.MAX_SAVED_BILLS} saved bills are supported.`, 'too_many_bills');
    }
    if (await lib.rateLimited('saves-sync', ip, 60 * 60, 60)) {
      return lib.sendErr(res, 429, 'Too many requests. Please wait a while and try again.', 'rate_limited');
    }

    // Normalize + dedupe; any malformed entry is dropped rather than failing
    // the whole sync (mirrors profile.js toggleBookmark validation).
    const billIds = [...new Set(
      rawIds
        .filter((value) => typeof value === 'string')
        .map((value) => lib.normalizeBillId(value))
        .filter(Boolean),
    )].slice(0, lib.MAX_SAVED_BILLS);

    const fields = lib.makeEmailFields(email);
    await lib.saveSavesRecord({
      ...fields,
      billIds,
      updatedAt: new Date().toISOString(),
    });

    return lib.sendJson(res, 200, {
      ok: true,
      saved: billIds.length,
      message: `Synced ${billIds.length} saved bill${billIds.length === 1 ? '' : 's'}.`,
    });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('API request error:', error.message);
    return lib.sendErr(res, status, status === 500 ? 'Internal server error' : error.message, status === 500 ? 'internal' : 'bad_request');
  }
};
