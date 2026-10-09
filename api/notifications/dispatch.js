'use strict';

/*
 * Vercel serverless function: daily notification digest dispatcher.
 *
 *   POST /api/notifications/dispatch   Authorization: Bearer $NOTIFICATIONS_SECRET
 *
 * Called by .github/workflows/update-bills.yml right after it pushes fresh
 * bill summaries. Fetches the feed from raw GitHub (the push already landed,
 * no deploy race), then for every user with industry subscriptions and/or a
 * synced saved-bills record sends at most ONE digest email:
 *   - "New in {industry}": bills whose industry field matches a subscription
 *     and that entered the feed since the last dispatched snapshot.
 *   - "Updates to your saved bills": synced bills whose stable version hash
 *     (status + latest action + official-text hash) moved since last
 *     notified. The first observation of a bill is a silent baseline.
 *
 * The global snapshot is only persisted when every send succeeded, so a
 * failed delivery retries on the next run; per-user ledgers mark content as
 * announced only after that user's email send succeeds, making re-runs
 * idempotent.
 */

const lib = require('../_lib/lariat');

async function fetchFeed() {
  const response = await fetch(lib.NOTIFICATIONS_FEED_URL, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Feed fetch failed (HTTP ${response.status}).`);
  }
  const bills = await response.json();
  if (!Array.isArray(bills)) throw new Error('Feed is not a bill array.');
  const byIdentifier = new Map();
  const byIndustry = new Map();
  for (const bill of bills) {
    if (!bill || typeof bill.identifier !== 'string' || !bill.identifier) continue;
    byIdentifier.set(bill.identifier, bill);
    if (lib.INDUSTRY_LIST.includes(bill.industry)) {
      if (!byIndustry.has(bill.industry)) byIndustry.set(bill.industry, []);
      byIndustry.get(bill.industry).push(bill);
    }
  }
  return { byIdentifier, byIndustry };
}

// Human-readable change lines for a saved bill whose stored fields moved.
function changeLines(previous, bill) {
  const changes = [];
  if ((previous.status || '') !== (bill.status || '')) {
    changes.push(`Status: ${previous.status || 'unknown'} → ${bill.status || 'unknown'}`);
  }
  if ((previous.action || '') !== (bill.latest_action_description || '')) {
    const when = bill.latest_action_date ? ` (${bill.latest_action_date})` : '';
    changes.push(`Latest action${when}: ${bill.latest_action_description || 'updated'}`);
  }
  if ((previous.textHash || '') !== (bill.bill_text_hash || '')) {
    changes.push('Official bill text updated — the summary was refreshed.');
  }
  if (!changes.length) changes.push('This bill record was updated.');
  return changes;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return lib.sendErr(res, 405, 'Method not allowed', 'method');
  try {
    if (!lib.dispatchAuthorized(req)) {
      return lib.sendErr(res, 401, 'Not authorized.', 'unauthorized');
    }
    lib.requireCore();

    const { byIdentifier, byIndustry } = await fetchFeed();
    const snapshot = await lib.getFeedSnapshot();
    const firstRun = snapshot === null;
    const known = snapshot || {};
    const newIdentifiers = [...byIdentifier.keys()].filter((id) => !known[id]);
    const newSet = new Set(newIdentifiers);
    const nextSnapshot = { ...known };
    const nowIso = new Date().toISOString();
    for (const id of newIdentifiers) nextSnapshot[id] = nowIso;

    const [subscriptions, savesRecords] = await Promise.all([
      lib.listSubscriptions(),
      lib.listSavesRecords(),
    ]);

    // Merge per-address state by HMAC index.
    const users = new Map();
    const userFor = (emailHmac, fallbackEmail) => {
      if (!users.has(emailHmac)) {
        users.set(emailHmac, { email: fallbackEmail || '', industries: new Map(), billIds: [] });
      }
      const user = users.get(emailHmac);
      if (!user.email && fallbackEmail) user.email = fallbackEmail;
      return user;
    };
    for (const subscription of subscriptions) {
      if (!subscription || typeof subscription.emailHmac !== 'string') continue;
      if (!lib.INDUSTRY_LIST.includes(subscription.industry)) continue;
      const user = userFor(subscription.emailHmac, lib.storedEmail(subscription));
      if (!user.industries.has(subscription.industry)) user.industries.set(subscription.industry, subscription);
    }
    for (const record of savesRecords) {
      if (!record || typeof record.emailHmac !== 'string' || !Array.isArray(record.billIds)) continue;
      const user = userFor(record.emailHmac, lib.storedEmail(record));
      user.billIds = record.billIds.filter((id) => typeof id === 'string');
    }

    const siteUrl = lib.baseUrl(req);
    let emailsSent = 0;
    let usersProcessed = 0;
    let industryEmails = 0;
    let savesEmails = 0;
    let sendFailures = 0;

    for (const [emailHmac, user] of users) {
      if (!user.email || (!user.industries.size && !user.billIds.length)) continue;
      usersProcessed += 1;
      const ledger = (await lib.findNotifLedger(emailHmac)) || { industrySeen: {}, savesVersions: {} };

      // Industry section: bills globally new this run that match a
      // subscription and were not already announced to this address.
      const newBills = [];
      for (const [industry] of user.industries) {
        for (const bill of byIndustry.get(industry) || []) {
          if (!newSet.has(bill.identifier)) continue;
          if (ledger.industrySeen[bill.identifier]) continue;
          const { token } = lib.makeUnsubscribeToken(user.email, industry);
          newBills.push({
            bill,
            industry,
            unsubscribeUrl: `${siteUrl}/api/subscriptions/unsubscribe?token=${encodeURIComponent(token)}`,
          });
        }
      }

      // Saved-bill section: first observation baselines silently; later
      // version moves notify with field-level change lines.
      const savedUpdates = [];
      for (const billId of user.billIds) {
        const bill = byIdentifier.get(billId);
        if (!bill) continue;
        const version = lib.billVersion(bill);
        const previous = ledger.savesVersions[billId];
        if (!previous || typeof previous !== 'object') {
          ledger.savesVersions[billId] = {
            v: version,
            status: bill.status || '',
            action: bill.latest_action_description || '',
            actionDate: bill.latest_action_date || '',
            textHash: bill.bill_text_hash || '',
          };
          continue;
        }
        if (previous.v === version) continue;
        savedUpdates.push({ bill, changes: changeLines(previous, bill) });
        ledger.savesVersions[billId] = {
          v: version,
          status: bill.status || '',
          action: bill.latest_action_description || '',
          actionDate: bill.latest_action_date || '',
          textHash: bill.bill_text_hash || '',
        };
      }

      if (!newBills.length && !savedUpdates.length) {
        // Ledger may only contain fresh baselines — persist them so the next
        // run compares against the right versions.
        if (user.billIds.length) await lib.saveNotifLedger(emailHmac, ledger);
        continue;
      }

      try {
        await lib.sendNotificationDigest(user.email, { siteUrl, newBills, savedUpdates });
        for (const entry of newBills) ledger.industrySeen[entry.bill.identifier] = true;
        await lib.saveNotifLedger(emailHmac, ledger);
        emailsSent += 1;
        if (newBills.length) industryEmails += newBills.length;
        if (savedUpdates.length) savesEmails += savedUpdates.length;
      } catch (error) {
        // Ledger untouched for industry entries (they stay unannounced), and
        // the snapshot is not persisted below, so everything retries next run.
        sendFailures += 1;
        console.error(`Digest send failed for one subscriber: ${error.message}`);
      }
    }

    // Persist the first-seen snapshot only when nothing is left to retry.
    if (!sendFailures) await lib.saveFeedSnapshot(nextSnapshot);

    return lib.sendJson(res, 200, {
      ok: true,
      firstRun,
      usersProcessed,
      emailsSent,
      industryEmails,
      savesEmails,
      sendFailures,
      newBills: newIdentifiers.length,
      feedSize: byIdentifier.size,
    });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('Dispatch error:', error.message);
    return lib.sendErr(res, status, status === 500 ? 'Internal server error' : error.message, status === 500 ? 'internal' : 'bad_request');
  }
};

// One digest send is a Brevo HTTP call per user, so a run grows with the
// subscriber base. Vercel Hobby's default function limit is 10s — raise it
// to the Hobby maximum so a healthy list doesn't get the run killed mid-loop.
module.exports.config = { maxDuration: 60 };
