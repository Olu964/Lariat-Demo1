# Lariat local backend

A zero-dependency Node.js server (Node 18+ — no `npm install` needed). It serves
the Lariat frontend **and** the subscription API from one process.

For security findings and the production checklist, read [`../SECURITY.md`](../SECURITY.md) before exposing this server to the internet.

## Run

```bash
node server/server.js
```

Then open <http://127.0.0.1:3000> → **Bill feed**.

The default server binds to `127.0.0.1` only, so it is reachable just from your computer. Do not set `HOST=0.0.0.0` for a public launch without a reverse proxy, HTTPS, an explicit `ALLOWED_HOSTS` value, and the production configuration described in `SECURITY.md`.

## What it replaces

The old subscription flow called EmailJS from the browser and verified codes in
localStorage — anyone could bypass it in DevTools. Now the browser only talks to
this backend, which stores verification codes as salted scrypt hashes and sends
email server-side, so no email API key ever reaches the browser.

## API

| Endpoint | Method | Body | Purpose |
| --- | --- | --- | --- |
| `/api/health` | GET | — | Public liveness status |
| `/api/subscriptions/request` | POST | `{ email, industry, accessCode }` | Sends a 6-digit verification code |
| `/api/subscriptions/verify` | POST | `{ email, industry, verificationCode }` | Confirms the code, activates the subscription |
| `/api/subscriptions/unsubscribe` | POST | `{ email, industry, token }` | Removes the subscription when called by an API client with a valid signed token; the web UI uses the email link |
| `/api/subscriptions/unsubscribe?token=…` | GET | signed token | Shows a confirmation page; the follow-up POST performs unsubscribe |

## Email: two modes

- **Console mode (default, no account needed):** with no `BREVO_API_KEY` the
  server prints each verification code and unsubscribe link to its terminal.
  Perfect for testing the whole flow for free.
- **Brevo mode:** add your free Brevo API key to `.env` and codes are emailed
  to any recipient (free tier: 300 emails/day, no credit card). Brevo verifies
  a sender address by clicking a confirmation email — **no domain purchase
  required**.

```bash
cp .env.example .env
# then set BREVO_API_KEY=... and BREVO_FROM_EMAIL=... in .env
```

## Configuration (`.env`)

| Variable | Default | Notes |
| --- | --- | --- |
| `BREVO_API_KEY` | *(empty → console mode)* | Free tier: https://app.brevo.com/settings/keys/api |
| `BREVO_FROM_EMAIL` | *(empty)* | Sender address verified in Brevo (by email — no domain needed) |
| `SUBSCRIPTION_ACCESS_CODE` | `LARIAT-TRIAL-2026` | Private code visitors must enter |
| `SUBSCRIPTION_CODE_EXPIRY_MINUTES` | `10` | Code lifetime |
| `SUBSCRIPTION_SIGNING_SECRET` | random per boot | Signs unsubscribe links; set a fixed value so links survive restarts |
| `SUBSCRIPTION_UNSUBSCRIBE_TOKEN_DAYS` | `90` | How long unsubscribe links stay valid |
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Bind address; keep loopback for local development |
| `PUBLIC_BASE_URL` | *(empty)* | Required in production; HTTPS origin used in email links |
| `ALLOWED_HOSTS` | `127.0.0.1,localhost,::1` | Host-header allowlist; add the production hostname |
| `ALLOWED_ORIGINS` | *(empty)* | Optional exact origins for a separately hosted frontend |
| `NODE_ENV` | `development` | Set to `production` to enforce secure deployment settings |

## Test the full flow

With the server running, from another terminal:

```bash
# 1. Request a code (check the server terminal for the code in console mode)
curl -s -X POST http://127.0.0.1:3000/api/subscriptions/request \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","industry":"Energy & Utilities","accessCode":"LARIAT-TRIAL-2026"}'

# 2. Verify it (use the code printed by the server)
curl -s -X POST http://127.0.0.1:3000/api/subscriptions/verify \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","industry":"Energy & Utilities","verificationCode":"123456"}'

# 3. Unsubscribe (use the signed token from a welcome email, or an API client that already has one)
curl -s -X POST http://127.0.0.1:3000/api/subscriptions/unsubscribe \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","industry":"Energy & Utilities","token":"<signed token from the welcome email>"}'
```

Subscriptions are persisted to `server/data/subscriptions.json` (gitignored).

## Demo pricing tiers

The frontend offers three demo-only tiers:

- **Free** — up to 1 industry
- **Professional** — up to 5 industries, displayed at $29/month
- **Business** — all available industries, displayed at $99/month

The selected tier is stored in the browser's localStorage. The backend does not
trust or enforce this tier because billing, accounts, and server-side plan
authorization are not active in the demo. Before accepting real payments, move
plan state and limit checks to the authenticated backend and connect them to a
payment provider.

## Unsubscribe link (signed token)

After a successful verification, the backend sends a **welcome email** that
contains an unsubscribe link. The link carries an HMAC-SHA256-signed token with
a random subscription-generation identifier and expires after
`SUBSCRIPTION_UNSUBSCRIBE_TOKEN_DAYS` (default 90 days). Opening the link shows a
confirmation page; only submitting that page unsubscribes the address. This
prevents email security scanners and browser prefetchers from unsubscribing
people automatically. The token is not returned to frontend JavaScript or stored
in localStorage. In console mode the link is printed to the server terminal
instead of emailed.

## Notes

- Valid industries are read from `Lariat-real/texas_bill_summaries.json`; the
  backend rejects unknown industries.
- Requests are rate-limited per IP. Three incorrect private access-code attempts
  trigger a 24-hour lockout for that network address; the frontend shows a live
  countdown and the backend returns the lockout expiry. There is also a
  1/minute cooldown per address; verification codes expire, and verification
  allows only 5 attempts.
- Verification codes are stored as salted **scrypt** hashes (not plaintext or
  plain SHA-256), so a leaked data file cannot be brute-forced offline.
- In production the server enforces HTTPS-only: plain-HTTP requests forwarded
  by the proxy (`X-Forwarded-Proto: http`) are redirected to the HTTPS URL, and
  every response carries HSTS. The API access log records only the HTTP method
  and path — never the query string, which can carry an unsubscribe token.
- The server only answers requests whose `Host` header is in `ALLOWED_HOSTS`
  (DNS-rebinding guard) and replies to CORS only for loopback or explicitly
  configured origins, so malicious websites cannot drive this API through a
  visitor's browser. Unsubscribe-link GET requests show a confirmation page;
  the signed token is consumed only after the user submits the POST.
- The API uses a generic response for already-subscribed addresses so it does
  not intentionally reveal subscription status. Failed access-code counts and
  24-hour lockouts are persisted using HMAC-derived network keys, not raw IP
  addresses, and count separately from the general request limit.
- `server/data/subscriptions.json` is written with 0600 permissions in a 0700
  directory so only the user running the server can read it.
