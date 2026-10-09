'use strict';

/*
 * Vercel serverless function: industry subscribe (Your Saves page).
 *
 *   POST /api/subscriptions/subscribe   { email, industry }
 *
 * Stateless port of handleIndustrySubscribe in server/server.js: validates
 * shape, rate-limits per IP, stores the subscription record in Redis, and
 * sends one confirmation email carrying a signed unsubscribe link. The record
 * is rolled back when delivery fails, so a failed send never looks like a
 * successful subscribe.
 */

const lib = require('../_lib/lariat');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return lib.sendErr(res, 405, 'Method not allowed', 'method');
  try {
    lib.requireEmail();
    const ip = lib.clientIp(req);
    const body = await lib.readJsonBody(req);
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const industry = typeof body.industry === 'string' ? body.industry.trim() : '';

    if (email.length > lib.MAX_EMAIL_LENGTH || !lib.EMAIL_PATTERN.test(email)) {
      return lib.sendErr(res, 400, 'Please enter a valid email address.', 'invalid_email');
    }
    if (!lib.INDUSTRY_LIST.includes(industry)) {
      return lib.sendErr(res, 400, 'That industry is not valid.', 'invalid_industry');
    }
    if (await lib.rateLimited('subscribe', ip, 60 * 60, 20)) {
      return lib.sendErr(res, 429, 'Too many subscription requests. Please wait a while and try again.', 'rate_limited');
    }

    const existing = await lib.findSubscription(email, industry);
    if (existing) {
      return lib.sendJson(res, 200, {
        ok: true,
        alreadySubscribed: true,
        message: `Already subscribed to ${industry}.`,
        subscription: { email, industry, verifiedAt: existing.verifiedAt || '' },
      });
    }

    const { token, tokenId } = lib.makeUnsubscribeToken(email, industry);
    const record = {
      ...lib.makeEmailFields(email),
      industry,
      verifiedAt: new Date().toISOString(),
      source: 'backend',
      unsubscribeTokenId: tokenId,
    };
    await lib.saveSubscription(record);

    const unsubscribeUrl = `${lib.baseUrl(req)}/api/subscriptions/unsubscribe?token=${encodeURIComponent(token)}`;
    try {
      await lib.sendSubscriptionConfirmationEmail(email, { industry, unsubscribeUrl });
    } catch (error) {
      await lib.deleteSubscription(email, industry);
      const providerStatus = error && Number.isFinite(Number(error.status)) ? Number(error.status) : 0;
      if (providerStatus >= 400 && providerStatus < 500) {
        return lib.sendErr(res, 400, 'Email Invalid', 'email_invalid');
      }
      console.error('Subscription confirmation email failed:', error.message);
      return lib.sendErr(res, 502, 'We could not send the confirmation email. Please try again later.', 'email_delivery_failed');
    }

    return lib.sendJson(res, 200, {
      ok: true,
      message: `Subscribed to ${industry}. A confirmation email is on its way to ${email}.`,
      subscription: { email, industry, verifiedAt: record.verifiedAt },
    });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('API request error:', error.message);
    return lib.sendErr(res, status, status === 500 ? 'Internal server error' : error.message, status === 500 ? 'internal' : 'bad_request');
  }
};
