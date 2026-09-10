# Lariat-Demo1

Fetch Texas bills directly from the Open States API and save the raw bill records to JSON.

Before exposing the site, subscription API, or Find your legislator lookup publicly, read [`SECURITY.md`](SECURITY.md) and [`DEPLOYMENT.md`](DEPLOYMENT.md). The current repository is a static frontend plus a standalone Node API; Vercel does not automatically make `server/server.js` or its local JSON files production-ready.

## Setup

The scripts use Python 3.10+ and the standard library only; no package installation is required. Bill summaries use `OPEN_STATES_API_KEY` to fetch records and `OPENROUTER_API_KEY` for official-text summaries when available; the summarizer can publish explicitly labeled 30–40 word metadata-only summaries when official text or the OpenRouter key is unavailable.

1. Copy `.env.example` to `.env`.
2. Add your `OPEN_STATES_API_KEY` and `OPENROUTER_API_KEY` to `.env`.
3. Keep `.env` private. It is ignored by Git.

## Run

```bash
python3 fetch_texas_bills.py --limit 15
```

The default output is `texas_bills.json`. The script also creates one JSON file per bill in `texas_bills/`, so `--limit 15` produces 16 JSON files total: one aggregate file plus 15 individual bill files. Each individual file contains the complete bill record returned by Open States.

To filter to a legislative session or fetch more bills:

```bash
python3 fetch_texas_bills.py \
  --session 89 \
  --limit 25 \
  --per-page 20 \
  --output data/texas-bills.json \
  --bill-dir data/texas-bill-files
```

The session is optional, but providing it avoids mixing bills from multiple Texas legislative sessions. Confirm the current Texas session identifier in Open States before running a large fetch.

## Find your legislator

The site includes a **Find your legislator** page linked after **Bill feed**. Users can submit a Texas street address or five-digit ZIP code; the backend geocodes it with the Census Bureau, confirms it is in Texas, and calls Open States `people.geo` to return the current state senator and state representative. Clicking either result opens an accessible profile dialog with recent major-bill vote records when Open States provides individual voter data; unavailable history is labeled rather than inferred. Successful results are cached privately on the server for 24 hours. The Open States key uses the existing `OPEN_STATES_API_KEY` environment variable and is never sent to the browser. See `server/README.md` for the lookup endpoint and runtime details, and `DEPLOYMENT.md` for the GitHub/Vercel production boundary.


The subscription flow on the Bill feed runs against a zero-dependency local Node.js backend (`server/server.js`)  -  no `npm install`, no hosting, no cost. It serves the site and the API from one process:

```bash
node server/server.js
# open http://127.0.0.1:3000
```

Without a `BREVO_API_KEY` it runs in console mode and prints verification codes to the terminal, so the full subscribe → verify → unsubscribe flow works with no accounts at all. Add a free Brevo key to `.env` (Brevo verifies a sender address by email  -  no domain purchase required) to send real verification email to any address. See `server/README.md` for the API and configuration. The Node server is local-development software by default; do not expose it to the internet without completing `SECURITY.md`.

The subscription access code allows three incorrect attempts per network address. A third failure starts a 24-hour server-enforced lockout; the Bill feed displays a live countdown in the subscription dialog. The lockout is persisted using an HMAC-derived network key rather than the raw IP address.

The Pricing page has three demo tiers: Free (1 industry), Professional ($29/month, up to 5 industries), and Business ($99/month, all industries). Because this is a single-user demo, the selected tier is stored in that browser's localStorage and limits new industry subscriptions in the frontend; billing, accounts, and server-side plan authorization are not active.

Before sharing the site, use the release steps in [`DEPLOYMENT.md`](DEPLOYMENT.md) and the free pre-release checks in [`SECURITY.md`](SECURITY.md): back up and test restoring local data, verify each bill against its official source, run keyboard/accessibility checks, test hostile data values, test the full subscription flow, and review public claims for accuracy.
