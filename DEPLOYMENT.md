# Lariat production deployment

This guide describes the repository as it exists now: a static frontend plus a standalone Node.js backend.

## Important architecture decision

Vercel can deploy the static HTML, CSS, JavaScript, images, and JSON from this repository. It does **not** automatically run `server/server.js` as a permanent Node server, and the current backend writes subscriptions and legislator lookup cache data to local JSON files. Those files are not durable production storage in a serverless runtime.

Use one of these architectures:

1. **Recommended for the current code:** Vercel hosts the frontend, while a separate HTTPS Node host or protected VM runs `server/server.js` behind a TLS reverse proxy. Use a managed database or persistent disk before collecting real subscriber data.
2. **Vercel-only:** refactor every API route into Vercel Functions and replace filesystem storage, process-local rate limits, and in-memory lookup state with managed database/cache services. Do not upload `server/server.js` unchanged and expect it to work.

The instructions below assume option 1. The Find your legislator page will not work in production until the backend is reachable and has `OPEN_STATES_API_KEY`.

## 1. Prepare GitHub

1. Confirm the production branch is `main` and that the repository contains the current root-level site files: `index.html`, `feed.html`, `legislator.html`, `key-events.html`, `privacy.html`, `accessibility.html`, `styles.css`, `legislator.js`, `api-config.js`, and `server/server.js`.
2. Do not deploy the obsolete `Lariat/` or `Lariat-real/` copies as the Vercel root. The active site is the repository root.
3. Confirm `.env` and `server/data/` are ignored:

   ```bash
   git check-ignore -v .env server/data
   git status --short
   ```

4. Never commit `OPEN_STATES_API_KEY`, `OPENROUTER_API_KEY`, `BREVO_API_KEY`, `SUBSCRIPTION_ACCESS_CODE`, or `SUBSCRIPTION_SIGNING_SECRET`.
5. Review the changed files locally, then commit and push the intended changes to GitHub. Pushing to `main` is what triggers a Vercel production deployment once the project is connected.

## 2. Configure GitHub Actions for bill data

In GitHub, open **Repository → Settings → Secrets and variables → Actions**.

Add these **repository secrets**:

| Name | Value | Used by |
| --- | --- | --- |
| `OPEN_STATES_API_KEY` | Private key from Open States | `fetch_texas_bills.py` and the workflow's bill fetch step |
| `OPENROUTER_API_KEY` | Private OpenRouter key | `summarize_bills.py` |

Add these optional **repository variables**:

| Name | Value | Used by |
| --- | --- | --- |
| `LARIAT_SESSION` | The exact Open States Texas session identifier | Limits fetched records to one session |
| `SUMMARIZER_MODEL` | A currently available OpenRouter model, or leave blank | Selects the first summarizer model |

Open States API v3 requires an API key and accepts it through the `X-API-KEY` header. Register at <https://open.pluralpolicy.com/accounts/signup/> and verify the key before running the workflow.

Then run **Actions → Update bill summaries → Run workflow** on `main`. Use a modest limit for the first run. Confirm that the job fetches records, generates or preserves valid summaries, and commits only the expected public data files.

The scheduled job runs daily at the cron time in `.github/workflows/update-bills.yml`. When it commits to `main`, Vercel automatically creates a new production deployment if Git integration is enabled.

## 3. Deploy the static frontend to Vercel

1. Sign in to Vercel and choose **Add New → Project**.
2. Import the GitHub repository.
3. Set **Root Directory** to `./` (the repository root).
4. Select **Other** or the static/no-framework preset.
5. Leave the build command blank. There is no build step.
6. Leave the output directory blank or use the repository root, depending on the Vercel UI.
7. Deploy once as a preview.
8. Test the preview URL before attaching the production domain.
9. In **Project Settings → Git**, set `main` as the Production Branch if it is not already selected.
10. Add the production domain and use the HTTPS URL as the canonical public origin.

The root `_headers` file contains static-host security headers. Verify the headers on the actual Vercel domain because the host controls which header-file features it honors.

## 4. Obtain and protect the Open States key

1. Create or sign in to an Open States account at <https://open.pluralpolicy.com/accounts/signup/>.
2. Create an API key and test it against the Open States v3 documentation at <https://docs.openstates.org/api-v3/>.
3. Store the key only in the backend host's secret/environment settings and, separately, in GitHub Actions secrets if the bill-refresh workflow needs it.
4. Do **not** put the key in `api-config.js`, any HTML file, `legislator.js`, `real-script.js`, or any other browser-delivered asset.
5. If the key was ever committed or pasted into a public channel, revoke it and create a replacement.

The backend uses the key for `people.geo` and bill-detail requests. The browser sends only an address or ZIP code to `POST /api/legislators/lookup`; it never receives the key.

## 5. Deploy the current Node backend separately

The current backend is a long-running Node HTTP server. Use a Node host or VM that supports a persistent process, HTTPS/reverse-proxy configuration, and durable storage. The exact host-specific steps vary, but the required behavior is the same:

1. Deploy the same repository or a private checkout containing `server/server.js` and the public files it serves.
2. Use Node 18 or newer.
3. Run `node server/server.js` as the service start command.
4. Put the process behind a trusted TLS reverse proxy. The proxy terminates HTTPS, forwards `X-Forwarded-Proto: https`, and routes only the API host to Node.
5. Keep Node bound to `127.0.0.1` when using a VM/reverse-proxy setup. Do not expose the raw Node port directly to the internet.
6. Set the backend's production environment values. Use a secret manager or protected host settings, not a committed `.env` file:

   ```env
   NODE_ENV=production
   HOST=127.0.0.1
   PORT=3000
   PUBLIC_BASE_URL=https://api.example.com
   ALLOWED_HOSTS=api.example.com
   ALLOWED_ORIGINS=https://lariatdemo.com
   OPEN_STATES_API_KEY=<private Open States key>
   BREVO_API_KEY=<private Brevo key>
   BREVO_FROM_EMAIL=<verified Brevo sender>
   SUBSCRIPTION_ACCESS_CODE=<unique random value, at least 12 characters>
   SUBSCRIPTION_SIGNING_SECRET=<random value, at least 32 characters>
   SUBSCRIPTION_CODE_EXPIRY_MINUTES=10
   SUBSCRIPTION_UNSUBSCRIBE_TOKEN_DAYS=90
   ```

   Replace both example domains with the real production domains. If the site is also reachable at `www`, either redirect it to the canonical domain or include the exact allowed origin/host intentionally.

7. Use a production database for subscriptions, pending verification codes, legislator lookup cache, and rate-limit state. The current `server/data/*.json` files are for local testing only. If you temporarily use a persistent private disk for a controlled demo, protect it from the public web, back it up, restrict permissions, and understand that it is not a transactional database.
8. Configure the host's health check to call `GET /api/health`.
9. Confirm the backend responds with HTTPS and that the API host's certificate is valid.

The backend's production validation intentionally fails closed if the access code, signing secret, Brevo configuration, HTTPS public URL, or allowed production host is missing.

## 6. Point the Vercel frontend at the backend

Before the Vercel production deployment, edit `api-config.js`:

```javascript
window.LARIAT_API_BASE = 'https://api.example.com';
```

Use only the exact HTTPS origin. Do not add a path, query string, credentials, API key, or trailing slash. This public file contains no secret; it only tells the browser where to send API requests.

Then update the `connect-src` value in the CSP meta tags in every page that makes API requests:

- `feed.html` and `pricing.html` for subscription requests
- `legislator.html` for legislator lookup

Add the exact API origin, for example:

```text
connect-src 'self' https://api.example.com https://fonts.googleapis.com https://fonts.gstatic.com;
```

If the API and frontend share one origin through a reverse-proxy route, keep `connect-src 'self'` and configure that proxy route instead. Never use `connect-src *`.

Commit and push the `api-config.js` and CSP changes. Vercel will build a new preview, then production after the change reaches `main`.

## 7. Configure backend CORS and test the legislator feature

The backend must have:

```env
ALLOWED_ORIGINS=https://lariatdemo.com
```

The value must exactly match the browser's production origin, including `https://` and excluding a trailing slash. Test both the production domain and any intentionally supported `www` domain separately.

From the deployed site:

1. Open **Find your legislator**.
2. Submit a Texas street address that you are authorized to use.
3. Confirm the browser makes one request to `https://api.example.com/api/legislators/lookup`.
4. Confirm the response contains only normalized public fields and no API key, address cache file, contact information, or raw upstream response.
5. Test a five-digit ZIP code and confirm the page identifies that it can be approximate.
6. Test an out-of-state address, invalid input, an unknown match, an unavailable Open States key, and a temporary upstream failure.
7. Open both returned legislator profiles and verify the voting-history unavailable state is honest when no individual vote is supplied.
8. Confirm the backend cache is private and successful results expire after 24 hours.

## 8. Test every current feature before production

### Frontend pages and links

- Home page, homepage demo notice, book/vision dialog, theme toggle, responsive layout, and the full-width legislator/calendar sections.
- Bill feed loading, industry filtering, bill detail dialogs, official source links, notes, and the “Reset demo subscriptions” behavior.
- Find your legislator with a full address, ZIP code, invalid input, out-of-state input, no match, provider failure, and missing-key configuration.
- Calendar event cards, event dialogs, dates, and official-source warning.
- Pricing overlay and confirmation that plans remain demo-only and payment is not active.
- Privacy Policy, Terms and Conditions, Cookie Policy, SSL/HTTPS Security, Disclaimer, and Accessibility Statement.

### Email subscription flow

With Brevo configured, test request → verification email → confirmation → welcome email → explicit unsubscribe confirmation. Also test invalid access codes, the third-failure lockout, expired codes, wrong verification codes, resend/cooldown behavior, duplicate subscriptions, invalid tokens, and a Brevo delivery failure.

Do not use real subscriber data until the database, backups, deletion process, logging policy, and legal review are complete.

### Security and accessibility

- Confirm HTTPS, HSTS, CSP, host allowlisting, CORS, and `Cache-Control: no-store` on API responses.
- Confirm no secret appears in Git, browser source, generated JSON, logs, error responses, or screenshots.
- Test keyboard navigation, visible focus, dialogs, screen-reader names, zoom/text resizing, light/dark themes, and `prefers-reduced-motion`.
- Run the checks listed in `SECURITY.md`. The site does not claim WCAG conformance or a security certification.

## 9. Production update procedure for future changes

1. Make the change on a feature branch.
2. Test locally with `node server/server.js` and a browser.
3. For backend changes, test with production-like environment variables using a separate staging backend and database.
4. Open a GitHub pull request and test the Vercel preview URL.
5. Merge only after checking the preview and relevant API tests.
6. Vercel deploys the merge to production automatically from `main`.
7. For bill refreshes, run or wait for **Update bill summaries**, inspect its commit, then check the resulting Vercel deployment.
8. Check `/api/health`, the legislator lookup, subscriptions, and the legal pages after deployment.
9. If a deployment is bad, use Vercel's deployment rollback or revert the GitHub commit. Do not edit generated production files manually in Vercel.

## 10. Go-live blockers still requiring an owner decision

The following are not solved merely by connecting GitHub to Vercel:

- The legal entity/operator name and governing law are not finalized in the Terms and Conditions.
- The current prototype has no production database, durable shared cache, shared rate limiter, automated retention job, or tested restore procedure.
- Recurring bill-alert delivery is not implemented; only verification and welcome email are active.
- The shared subscription access code is an invitation gate, not authentication.
- The site has not received an independent WCAG or security audit.
- Privacy, email-consent, data-processing, and retention practices require jurisdiction-specific legal review.

Do not describe the service as a live paid product, guaranteed legal research, or recurring-alert service until those items are actually implemented and the public policies are updated.

## Official references

- Vercel Git deployments: <https://vercel.com/docs/git>
- Vercel Functions: <https://vercel.com/docs/functions>
- Vercel storage: <https://vercel.com/docs/storage>
- Open States API v3: <https://docs.openstates.org/api-v3/>
- Project security checklist: [`SECURITY.md`](SECURITY.md)
- Local backend/API details: [`server/README.md`](server/README.md)
