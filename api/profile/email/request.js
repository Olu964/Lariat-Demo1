'use strict';

/*
 * Vercel serverless function: profile-email confirmation-code request.
 *
 *   POST /api/profile/email/request   { email }
 *
 * Stateless port of handleProfileEmailRequest in server/server.js (the Finalize
 * Email / Get code flow). No access code by design; abuse protection is the
 * per-IP rate limit plus the per-address send cooldown. A fresh random code
 * replaces any previous one, so only the newest code works.
 */

const lib = require('../../_lib/lariat');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return lib.sendErr(res, 405, 'Method not allowed', 'method');
  try {
    lib.requireEmail();
    const ip = lib.clientIp(req);
    const body = await lib.readJsonBody(req);
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    if (await lib.rateLimited('profile-request', ip, 60 * 60, 10)) {
      return lib.sendErr(res, 429, 'Too many requests. Please wait a while and try again.', 'rate_limited');
    }
    if (email.length > lib.MAX_EMAIL_LENGTH || !lib.EMAIL_PATTERN.test(email)) {
      return lib.sendErr(res, 400, 'Please enter a valid email address.', 'invalid_email');
    }
    if (await lib.cooldownActive(email, lib.PROFILE_EMAIL_PURPOSE)) {
      return lib.sendErr(res, 429, 'Please wait a minute before requesting another code.', 'cooldown');
    }

    const code = lib.generateCode();
    await lib.savePending(email, lib.PROFILE_EMAIL_PURPOSE, code);
    try {
      await lib.sendProfileFinalizeEmail(email, { code, expiryMinutes: lib.CODE_EXPIRY_MINUTES });
    } catch (error) {
      await lib.deletePending(email, lib.PROFILE_EMAIL_PURPOSE);
      const providerStatus = error && Number.isFinite(Number(error.status)) ? Number(error.status) : 0;
      if (providerStatus >= 400 && providerStatus < 500) {
        return lib.sendErr(res, 400, 'Email Invalid', 'email_invalid');
      }
      throw error;
    }
    return lib.sendJson(res, 200, {
      ok: true,
      message: 'A confirmation code is on its way to that address.',
    });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('API request error:', error.message);
    return lib.sendErr(res, status, status === 500 ? 'Internal server error' : error.message, status === 500 ? 'internal' : 'bad_request');
  }
};
