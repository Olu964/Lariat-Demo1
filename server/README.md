# Lariat backend

A zero-dependency Node.js server (Node 18+  -  no `npm install` needed). In local development it serves the Lariat frontend **and** the subscription API from one process. For production, read [`../DEPLOYMENT.md`](../DEPLOYMENT.md): Vercel's static deployment cannot run this long-lived process or provide durable local JSON storage.

For security findings and the production checklist, read [`../SECURITY.md`](../SECURITY.md) before exposing this server to the internet.

## Run

```bash
node server/server.js
```

Then open <http://127.0.0.1:3000> → **Bill feed**.

The default server binds to `127.0.0.1` only, so it is reachable just from your computer. Do not set `HOST=0.0.0.0` for a public launch without a reverse proxy, HTTPS, an explicit `ALLOWED_HOSTS` value, and the production configuration described in `SECURITY.md`.

## What it replaces

The old subscription flow called EmailJS from the browser and verified codes in
localStorage  -  anyone could bypass it in DevTools. Now the browser only talks to
this backend, which stores verification codes as salted scrypt hashes and sends
email server-side, so no email API key ever reaches the browser.

## API

| Endpoint | Method | Body | Purpose |
| --- | --- | --- | --- |
| `/api/health` | GET |  -  | Public liveness status |
| `/api/legislators/lookup` | POST | `{ address }` | Geocodes a Texas address or ZIP and returns the current state senator and representative and recent major-bill voting history when available |
| `/api/subscriptions/subscribe` | POST | `{ email, industry }` | Stores the subscription and sends a confirmation email with a signed unsubscribe link |
| `/api/subscriptions/unsubscribe` | POST | `{ email, industry }` | Removes the subscription (idempotent) and emails a notice; used by the Unsubscribe button |
| `/api/subscriptions/unsubscribe?token=…` | GET | signed token | Removes the subscription named by the token and shows a confirmation page |
| `/api/profile/email/request` | POST | `{ email }` | Sends the 6-digit code that finalizes a profile email |
| `/api/profile/email/verify` | POST | `{ email, code, oldEmails }` | Confirms the code and moves subscriptions from old addresses |
| `/api/notifications/saves` | POST | `{ email, billIds[] }` | Mirrors the browser's saved bills server-side for update alerts (full replace) |
| `/api/notifications/dispatch` | POST | bearer secret | Runs the daily digest: new industry bills + saved-bill updates, one email per user |

## Find your legislator

`POST /api/legislators/lookup` accepts a JSON body such as `{ "address": "1600 Pennsylvania Ave NW, Washington, DC 20500" }`. Full addresses are geocoded server-side through the free Census Bureau Geocoder. A five-digit ZIP code uses the Census Bureau's TIGERweb ZIP centroid as a fallback. The server confirms the resulting point is in Texas before calling Open States `people.geo`.

The response contains only normalized frontend fields: `personId`, `name`, `chamber`, `party`, `district`, `photoUrl`, `roleTitle`, `votingHistoryStatus`, `votingHistoryChecked`, `votingHistory`, `committeesStatus`, `committees`, `sponsoredBillsStatus`, `sponsoredBills`, `leadershipRoles`, and `votingPattern`. Committees come from Open States `/committees?jurisdiction=Texas&include=memberships` matched by person ID or name; sponsored bills come from `/bills?jurisdiction=Texas&sponsor=<id-or-name>` (up to 8 most recent); leadership is derived from the current-role title plus committee Chair/Vice-Chair roles; voting patterns are computed only from recorded Yes/No votes. The history is checked against the most recently updated high- or moderate-impact bills in the local Lariat snapshot. A record is included only when the Open States bill detail response includes an individual voter matching the legislator by ID or name; no missing vote is inferred. Legislator contact information is not requested or returned. The Open States key is read from the same `OPEN_STATES_API_KEY` environment variable used by the bill-fetching Python pipeline and is sent only in the server-side `X-API-KEY` header. It is never included in browser code or API responses.

Successful lookups are stored in `server/data/legislator-lookups.json` for 24 hours, keyed by the normalized submitted address. The cache includes the returned profile and vote-history availability/results. Failed and no-match lookups are not cached. The endpoint is rate-limited to 30 requests per client IP per hour.

If `OPEN_STATES_API_KEY` is missing, the page shows a configuration error rather than exposing an upstream error.

## Email: two modes

- **Console mode (default, no account needed):** with no `BREVO_API_KEY` the
  server prints each verification code and unsubscribe link to its terminal.
  Perfect for testing the whole flow for free.
- **Brevo mode:** add your free Brevo API key to `.env` and codes are emailed
  to any recipient (free tier: 300 emails/day, no credit card). Brevo verifies
  a sender address by clicking a confirmation email  -  **no domain purchase
  required**.

```bash
cp .env.example .env
# then set BREVO_API_KEY=... and BREVO_FROM_EMAIL=... in .env
```

## Configuration (`.env`)

| Variable | Default | Notes |
| --- | --- | --- |
| `BREVO_API_KEY` | *(empty → console mode)* | Free tier: https://app.brevo.com/settings/keys/api |
| `BREVO_FROM_EMAIL` | *(empty)* | Sender address verified in Brevo (by email  -  no domain needed) |
| `OPEN_STATES_API_KEY` | *(empty)* | Required for Find your legislator; server-side only; register at https://open.pluralpolicy.com/accounts/signup/ |
| `SUBSCRIPTION_DATA_KEY` | *(empty → plaintext locally)* | 64 hex chars; encrypts stored emails at rest (AES-256-GCM). Required in production |
| `SUBSCRIPTION_CODE_EXPIRY_MINUTES` | `10` | Profile-email code lifetime |
| `SUBSCRIPTION_SIGNING_SECRET` | random per boot | Signs unsubscribe links; set a fixed value so links survive restarts |
| `SUBSCRIPTION_UNSUBSCRIBE_TOKEN_DAYS` | `90` | How long unsubscribe links stay valid |
| `NOTIFICATIONS_SECRET` | *(empty → dispatch disabled)* | Bearer token for `POST /api/notifications/dispatch`; same value in Vercel + GitHub Actions |
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Bind address; keep loopback for local development |
| `PUBLIC_BASE_URL` | *(empty)* | Required in production; HTTPS origin used in email links |
| `ALLOWED_HOSTS` | `127.0.0.1,localhost,::1` | Host-header allowlist; add the production hostname |
| `ALLOWED_ORIGINS` | *(empty)* | Optional exact origins for a separately hosted frontend |
| `NODE_ENV` | `development` | Set to `production` to enforce secure deployment settings |

## Test the full flow

With the server running, from another terminal:

```bash
# 1. Subscribe (in console mode the confirmation email + unsubscribe link
#    are printed to the server terminal)
curl -s -X POST http://127.0.0.1:3000/api/subscriptions/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","industry":"Energy & Utilities"}'

# 2. Re-subscribing is a no-op — the same record is returned, no second email
#    (unknown industries or malformed emails return 400)

# 3. Unsubscribe (the Unsubscribe button on Your Saves sends exactly this —
#    and a notice email goes out when a record was actually removed)
curl -s -X POST http://127.0.0.1:3000/api/subscriptions/unsubscribe \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","industry":"Energy & Utilities"}'

# 4. Or follow the signed unsubscribe link from the confirmation email
curl -s 'http://127.0.0.1:3000/api/subscriptions/unsubscribe?token=<signed token>'
```

Subscriptions are persisted to `server/data/subscriptions.json` and successful legislator lookups are cached in `server/data/legislator-lookups.json` (both gitignored). These files are for local development only; use managed persistent storage for production and never deploy `server/data/` as public static content.

## Demo pricing tiers

The frontend offers three demo-only tiers:

- **Free**  -  up to 1 industry
- **Professional**  -  up to 5 industries, displayed at $29/month
- **Business**  -  all available industries, displayed at $99/month

The selected tier is stored in the browser's localStorage. The backend does not
trust or enforce this tier because billing, accounts, and server-side plan
authorization are not active in the demo. Before accepting real payments, move
plan state and limit checks to the authenticated backend and connect them to a
payment provider.

## Subscribe flow and confirmation email

Subscribing happens from the **Industry subscriptions** section on the Your
Saves page. The browser requires a finalized profile email first (the gate
toast blocks everything else), then POSTs to `/api/subscriptions/subscribe`.
The backend validates the industry, rate-limits (20 subscribes per IP per
hour), stores the record, and sends a **confirmation email** with an
HMAC-SHA256-signed unsubscribe link; the record is rolled back if delivery
fails, so a failed send never looks like a successful subscribe.

The link carries a random subscription-generation identifier and expires after
`SUBSCRIPTION_UNSUBSCRIBE_TOKEN_DAYS` (default 90 days). Opening it removes
the subscription and shows a confirmation page; the token is not returned to
frontend JavaScript or stored in localStorage. In console mode the link is
printed to the server terminal instead of emailed. Re-subscribing after an
unsubscribe generates a fresh token.

Unsubscribing from the **Unsubscribe** button on Your Saves POSTs to
`/api/subscriptions/unsubscribe`; when a record was actually removed the
backend also sends a **"you're unsubscribed" notice** with a link back to the
Your Saves page. The notice is best-effort — a failed send is logged but the
unsubscribe still succeeds, never the other way around. The signed-link GET
path sends no notice, so email-link scanners cannot trigger mail.

## Notification digest (new industry bills + saved-bill updates)

Every day after the GitHub workflow refreshes `texas_bill_summaries.json`, it
calls `POST /api/notifications/dispatch` with
`Authorization: Bearer $NOTIFICATIONS_SECRET`. The endpoint (local and the
`api/notifications/dispatch.js` Vercel twin) then sends **at most one digest
email per user**:

- **New in {industry}** — bills whose AI-assigned `industry` field matches one
  of the user's subscriptions and that entered the feed since the last
  dispatched snapshot. Each industry section carries its own signed
  unsubscribe link.
- **Updates to your saved bills** — bills the user synced via
  `POST /api/notifications/saves` whose stable version hash (status + latest
  action + official-text hash) moved since last notified. The email lists the
  exact changes (`Status: Pending → Passed`, new dated action, text refresh).

State lives beside the subscriptions (Redis keys on Vercel; the same
`subscriptions.json` locally): a global first-seen snapshot, per-user
saved-bill records (encrypted email), and per-user notification ledgers. The
first dispatch baselines every existing bill — nobody is emailed retroactively
— and each user's first observation of a saved bill is also a silent
baseline. Ledgers advance only after that user's send succeeds and the
snapshot persists only when every send succeeded, so failures retry next run
and re-runs never duplicate content.

The browser mirrors its localStorage saved bills whenever they change (and
when the profile email becomes finalized) through `syncSaves()` in
`subscriptions.js`; sync is fire-and-forget and requires a finalized email,
the same gate as subscribing.

## Notes

- Valid industries are the five canonical Lariat industries (Energy & Utilities,
  Government & Municipal Operations, Emergency & Public Safety, Real Estate &
  Land Use, Insurance & Financial Services) — the same list as `ALL_INDUSTRIES`
  in `profile.js`; the backend rejects unknown industries.
- `OPEN_STATES_API_KEY` is required by `/api/legislators/lookup`. The browser sends only an address/ZIP to the backend; the key is sent from the backend to Open States in `X-API-KEY` and is never returned.
- Requests are rate-limited per IP: 10 profile-code requests, 25 code
  verifications, 20 subscribes, 60 unsubscribes, and 60 saved-bill syncs per
  hour. Profile-email
  verification codes expire, allow only 5 attempts, and a 1/minute cooldown
  applies per address.
- Verification codes are stored as salted **scrypt** hashes (not plaintext or
  plain SHA-256), so a leaked data file cannot be brute-forced offline.
- In production the server enforces HTTPS-only: plain-HTTP requests forwarded
  by the proxy (`X-Forwarded-Proto: http`) are redirected to the HTTPS URL, and
  every response carries HSTS. The API access log records only the HTTP method
  and path  -  never the query string, which can carry an unsubscribe token.
- The server only answers requests whose `Host` header is in `ALLOWED_HOSTS`
  (DNS-rebinding guard) and replies to CORS only for loopback or explicitly
  configured origins, so malicious websites cannot drive this API through a
  visitor's browser. Unsubscribe-link GET requests remove the subscription
  named by the signed token and then show a confirmation page; the token is
  never returned to frontend JavaScript.
- Re-subscribing an address that already has the record returns
  `alreadySubscribed: true` without sending a second confirmation email.
  Like the demo plan limits, the finalized-email requirement is enforced by
  the frontend gate (`requireVerifiedEmail`); the server itself only
  validates shape, rate limits, and delivery — add server-side verification
  before depending on it for authorization.
- In-memory rate-limit counters are per-process; restarting the server resets
  them.
- `server/data/subscriptions.json` is written with 0600 permissions in a 0700
  directory so only the user running the server can read it.
