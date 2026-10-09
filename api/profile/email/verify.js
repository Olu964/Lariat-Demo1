'use strict';

/*
 * Vercel serverless function: profile-email confirmation-code confirm.
 *
 *   POST /api/profile/email/verify   { email, code, oldEmails[] }
 *
 * Stateless port of handleProfileEmailVerify in server/server.js. On success,
 * every subscription recorded under the user's old address(es) moves to the
 * new profile email with freshly signed unsubscribe links; the confirmation
 * email carries those links and each old address gets a best-effort notice.
 */

const lib = require('../../_lib/lariat');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return lib.sendErr(res, 405, 'Method not allowed', 'method');
  try {
    lib.requireEmail();
    const ip = lib.clientIp(req);
    const body = await lib.readJsonBody(req);
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const verificationCode = typeof body.code === 'string' ? body.code.trim() : '';
    const rawOldEmails = Array.isArray(body.oldEmails) ? body.oldEmails : [];
    const oldEmails = [...new Set(
      rawOldEmails
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value
          && value.length <= lib.MAX_EMAIL_LENGTH
          && lib.EMAIL_PATTERN.test(value)
          && value.toLowerCase() !== email.toLowerCase()),
    )].slice(0, 10);

    if (email.length > lib.MAX_EMAIL_LENGTH || !lib.EMAIL_PATTERN.test(email)) {
      return lib.sendErr(res, 400, 'Please enter a valid email address.', 'invalid_email');
    }
    if (!lib.CODE_PATTERN.test(verificationCode)) {
      return lib.sendErr(res, 400, 'The confirmation code must be 6 digits.', 'invalid_code');
    }
    if (await lib.rateLimited('profile-verify', ip, 60 * 60, 25)) {
      return lib.sendErr(res, 429, 'Too many verification attempts. Please wait a while and try again.', 'rate_limited');
    }

    const pending = await lib.findPending(email, lib.PROFILE_EMAIL_PURPOSE);
    if (!pending) {
      return lib.sendErr(res, 400, 'No pending confirmation was found for this address. Request a new code.', 'no_pending');
    }
    if (Date.now() > pending.expiresAt) {
      await lib.deletePending(email, lib.PROFILE_EMAIL_PURPOSE);
      return lib.sendErr(res, 400, 'This code has expired. Request a new one.', 'expired');
    }
    if (pending.attempts >= lib.VERIFY_MAX_ATTEMPTS) {
      await lib.deletePending(email, lib.PROFILE_EMAIL_PURPOSE);
      return lib.sendErr(res, 429, 'Too many attempts. Request a new code.', 'too_many_attempts');
    }

    const matches = await lib.codeMatches(verificationCode, pending);
    // Re-check the live store before changing state so a concurrent request
    // cannot consume the same one-time code twice.
    const fresh = await lib.findPending(email, lib.PROFILE_EMAIL_PURPOSE);
    if (!fresh || fresh.codeHash !== pending.codeHash) {
      return lib.sendErr(res, 400, 'No pending confirmation was found for this address. Request a new code.', 'no_pending');
    }
    if (!matches) {
      await lib.bumpPendingAttempts(email, lib.PROFILE_EMAIL_PURPOSE);
      return lib.sendErr(res, 400, 'That code is not correct. Please try again.', 'wrong_code');
    }

    // Code verified: consume it, then move subscriptions and notification
    // state (saved bills + notification ledgers) recorded under the user's
    // old address(es) to the new profile email.
    await lib.deletePending(email, lib.PROFILE_EMAIL_PURPOSE);
    const newFields = lib.makeEmailFields(email);
    const moved = [];
    for (const oldEmail of oldEmails) {
      const records = await lib.findSubscriptionsByHmac(lib.emailLookupId(oldEmail));
      for (const subscription of records) {
        const updated = {
          ...newFields,
          industry: subscription.industry,
          verifiedAt: new Date().toISOString(),
          source: 'backend',
        };
        delete updated.unsubscribeTokenId;
        await lib.saveSubscription(updated);
        // The record key contains the email HMAC, so the stale record under
        // the old address must be deleted (the local server mutates one
        // object in place; here the key itself changes).
        const oldKey = lib.subKey(subscription.emailHmac, subscription.industry);
        const newKey = lib.subKey(updated.emailHmac, updated.industry);
        if (oldKey !== newKey) await lib.ucmd('DEL', oldKey);
        moved.push({
          industry: subscription.industry,
          oldEmail,
        });
      }

      // Saved-bill sync records and the per-user notification ledger follow
      // the address; overwriting an existing ledger on the new address is
      // safe because lost "seen" marks only re-baseline silently.
      const oldHmac = lib.emailLookupId(oldEmail);
      const oldSaves = await lib.findSavesByHmac(oldHmac);
      if (oldSaves) {
        await lib.saveSavesRecord({
          ...newFields,
          billIds: Array.isArray(oldSaves.billIds) ? oldSaves.billIds : [],
          updatedAt: new Date().toISOString(),
        });
        await lib.deleteSavesByHmac(oldHmac);
      }
      const oldLedger = await lib.findNotifLedger(oldHmac);
      if (oldLedger) {
        await lib.saveNotifLedger(newFields.emailHmac, oldLedger);
        await lib.deleteNotifLedger(oldHmac);
      }
    }

    if (moved.length) {
      const distinctOld = [...new Set(moved.map((entry) => entry.oldEmail))];
      try {
        await lib.sendProfileMovedEmail(email, { moved, oldEmails: distinctOld });
      } catch (error) {
        // The move already succeeded; the confirmation is a courtesy, so a
        // delivery failure is logged but does not fail the request.
        console.error('Profile move confirmation email failed:', error.message);
      }
      for (const oldEmail of distinctOld) {
        try {
          await lib.sendProfileMovedNoticeEmail(oldEmail, {
            newEmail: email,
            moved: moved.filter((entry) => entry.oldEmail === oldEmail),
          });
        } catch (error) {
          console.error('Profile move notice email failed:', error.message);
        }
      }
    }

    return lib.sendJson(res, 200, {
      ok: true,
      message: moved.length
        ? `Email confirmed. Moved ${moved.length} subscription${moved.length === 1 ? '' : 's'} to ${email}.`
        : 'Email confirmed.',
      moved: moved.length,
    });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('API request error:', error.message);
    return lib.sendErr(res, status, status === 500 ? 'Internal server error' : error.message, status === 500 ? 'internal' : 'bad_request');
  }
};
