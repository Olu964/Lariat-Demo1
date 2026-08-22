# Security audit and go-live checklist

Audit scope: the `Lariat-real/` frontend, `server/server.js`, environment configuration, static-file serving, and the subscription flow. Audit date: August 19, 2026.

The code-level issues found in this audit have been fixed. The steps below cover the remaining deployment, operations, data, and legal work required before a public launch.

## Lowest-cost safe remediation plan

### 0. Choose a simple deployment shape

1. Keep the static frontend and Node API on the same HTTPS origin if possible. This avoids unnecessary CORS and cross-domain configuration.
2. Run Node behind a maintained reverse proxy or managed hosting platform. Do not expose the raw HTTP process directly to the internet.
3. Keep the Node process bound to `127.0.0.1` behind the proxy. The proxy should terminate TLS, redirect HTTP to HTTPS, renew certificates, and apply request-size/rate limits.
4. Use one application instance until there is a real need to scale. The current in-memory rate limiter is safer and easier to reason about in one instance.
5. Set the production environment variables below and verify that the process refuses to start if required values are missing.

```env
NODE_ENV=production
SUBSCRIPTION_ACCESS_CODE=<unique random value, at least 12 characters>
SUBSCRIPTION_SIGNING_SECRET=<random value, at least 32 characters>
BREVO_API_KEY=<private key>
BREVO_FROM_EMAIL=<verified sender>
PUBLIC_BASE_URL=https://your-domain.example
ALLOWED_HOSTS=your-domain.example
```

### 1. Replace the JSON subscription store

**Risk:** `server/data/subscriptions.json` is suitable for local testing, but it is not a production database.

1. Choose a managed database included in the cheapest reliable hosting tier, preferably encrypted at rest with private credentials and automated backups. A small managed PostgreSQL-compatible database is a safer default than exposing a file or self-managing a database server.
2. Create tables for subscriptions, pending verification codes, and alert-delivery records. Store only the fields the product needs.
3. Give the application a database user that can read/write only those tables; do not use an administrator credential.
4. Replace the JSON read/write functions with parameterized database queries. Never build SQL by concatenating email addresses, industries, or tokens.
5. Store verification-code hashes and signed/opaque unsubscribe data in the database, not in the public directory.
6. Enable automated backups and test restoring one backup before launch. A backup that has never been restored is not a recovery plan.
7. Keep the local JSON file only for development. Do not copy real subscriber data into Git, staging fixtures, logs, or screenshots.

### 2. Make abuse protection work across the deployment

**Risk:** the current rate limiter is in memory and applies only within one process.

1. Configure the reverse proxy or hosting edge to limit requests by IP before they reach Node.
2. Use conservative limits for `/api/subscriptions/request`, `/verify`, and `/unsubscribe`; keep the application limits enabled as a second layer.
3. Keep the per-address one-minute cooldown and five-attempt verification limit.
4. If you add multiple instances, move rate-limit counters and cooldowns to a shared managed key-value store, or keep the API single-instance until that store is available.
5. Add alerts for spikes in code requests, invalid access codes, verification failures, Brevo failures, and storage errors.
6. Do not trust arbitrary `X-Forwarded-For` values in Node. Configure the proxy to pass a verified client address and document the proxy trust boundary.

### 3. Replace the shared access code when real users arrive

**Risk:** the shared access code is an invitation gate, not authentication. Anyone who receives it can reuse it.

1. For a small private trial, use a long random code, share it privately, rotate it when it spreads, and keep email verification enabled.
2. For a public product, create per-user invitation tokens or accounts rather than one permanent code.
3. Make invitations single-use, short-lived, and stored server-side as hashes where possible.
4. If accounts are added, use secure, HttpOnly, SameSite cookies and server-side sessions; do not put passwords or session credentials in localStorage.
5. Add account-level authorization checks before exposing saved watchlists, notes, billing, or administrative actions.

### 4. Add production monitoring and safe logs

1. Send application and proxy logs to a restricted log service with a defined retention period.
2. Never log Brevo keys, access codes, verification codes, signed unsubscribe tokens, request bodies, or full unsubscribe URLs.
3. Minimize email addresses in logs; hash or redact them when an identifier is needed for troubleshooting.
4. Alert on process crashes, repeated 5xx responses, failed database writes, Brevo quota/authentication errors, abnormal traffic, and backup failures.
5. Add a health check that reports only service liveness and non-sensitive dependency status. Do not expose subscriber counts or database details publicly.
6. Document who can access logs, backups, the database, and the secret manager.

### 5. Manage and rotate secrets correctly

1. Put production values in the hosting platform's secret manager or protected environment settings, not in `.env` files uploaded with the application.
2. Confirm `.env`, subscription data, backups, logs, and build artifacts are excluded from Git and public static output.
3. Use separate Brevo keys and signing secrets for development, staging, and production.
4. Rotate the Brevo key immediately if it was committed, pasted into chat, placed in frontend JavaScript, or included in a diagnostic log.
5. Rotate the signing secret only with a planned migration because existing unsubscribe links become invalid.
6. Use a verified sender address and configure the provider's domain authentication when available; monitor bounce and complaint rates.

### 6. Protect unsubscribe tokens and email flows

1. Keep the current signed, expiring token design and the explicit confirmation POST. Do not return to a state-changing GET link.
2. Serve the site and unsubscribe flow only over HTTPS in production. (Done: the server redirects plain-HTTP requests to HTTPS in production and advertises HSTS; the proxy must terminate TLS and pass a correct `X-Forwarded-Proto`.)
3. Configure the proxy not to retain query strings containing unsubscribe tokens, or redact them from access logs. (Done: the server's API access log records only the HTTP method and path, never the query string.)
4. Keep the default token lifetime short. (Done: the default is now 90 days via `SUBSCRIPTION_UNSUBSCRIBE_TOKEN_DAYS`; set it to the shortest period the product can support.)
5. For a larger product, replace bearer tokens in URLs with random opaque tokens whose hashes are stored server-side; revoke them after use or rotation.
6. Keep the email content escaped and avoid putting sensitive data into subjects or URLs.
7. Test link scanners and email security tools so they see only the confirmation page and cannot unsubscribe automatically.

### 7. Keep browser storage low-risk

1. Continue treating localStorage as user-controlled and readable by any future same-origin XSS.
2. Tell users not to store confidential information in bill notes; the updated privacy policy does this.
3. Do not add passwords, payment information, API keys, or account sessions to localStorage.
4. When real accounts are introduced, move authentication to secure HttpOnly, SameSite cookies and keep authorization server-side.
5. Provide a clear way to clear local notes and preference data. Explain that the current reset button does not delete the backend subscription.
6. If the product no longer needs in-app unsubscribe, stop storing the unsubscribe token in localStorage and require the email link instead.

### 8. Make the bill-data pipeline trustworthy

1. Fetch Open States data only from the backend or a controlled job; never place the Open States API key in frontend code.
2. Validate response size, JSON shape, bill identifiers, dates, URLs, and allowed field lengths before publishing data.
3. Convert raw Open States records into the frontend's expected summary schema in a separate server-side transformation step.
4. Treat titles, summaries, and other fetched fields as untrusted data. Escape them at every HTML sink and never execute them as markup or scripts.
5. Review generated summaries and legislative status before publication; the feed is informational and is not legal advice.
6. Write a new versioned data artifact atomically, validate it, then publish it. Keep the previous known-good version for rollback.
7. Record the source timestamp and dataset version in the feed so users can see how current it is. The current feed visibly labels the published dataset date; update that metadata only after verifying the underlying records.

### 9. Maintain infrastructure and dependencies

1. Use a supported Node.js LTS release and a patched operating system/container image.
2. Keep the current zero-dependency server where possible; fewer packages reduce supply-chain exposure.
3. If packages are added, commit the lockfile, review maintainers and permissions, run dependency audits, and update on a scheduled cadence.
4. Enable repository secret scanning and protected deployment branches.
5. Restrict CI/CD tokens to the minimum permissions and require review for production deployments.
6. Periodically run an external TLS/header scan and an independent accessibility/security review.

### 10. Finish privacy, consent, and legal readiness

1. Decide what entity operates the public service, where subscriber data is stored, and how long it is retained.
2. Review Brevo's current privacy terms, data-processing terms, sender requirements, bounce/complaint handling, and applicable email-consent rules.
3. Define a retention and deletion schedule for subscriptions, pending codes, logs, backups, and provider records.
4. Provide a working contact method for access, correction, deletion, and accessibility requests.
5. Make the subscription copy accurately describe verification, welcome messages, future alerts, unsubscribe behavior, and the use of Brevo.
6. Obtain jurisdiction-specific legal review before collecting public subscriber data. The website's policy is informational and is not legal advice.

## Free pre-release checks

These checks require no paid tools or services:

1. Rotate any Brevo key that may have been exposed, then test a verification and unsubscribe email with the replacement key.
2. Make a private backup of `server/data/` and test restoring a copy; never commit subscriber data or backups.
3. For every published bill, verify the identifier, session, title, status, effective date, summary, and source URL against the official Texas Legislature record or the documented Open States record.
4. Run the feed with a keyboard only and test focus order, dialogs, forms, live messages, zoom, reduced motion, and screen-reader labels. Use the browser's built-in Lighthouse/accessibility tools and record failures rather than claiming certification.
5. Test hostile bill values such as `<script>alert(1)</script>` as fixture data and confirm they render as text, not executable markup.
6. Test the full subscription flow: valid and invalid access codes, three failures, the 24-hour countdown, expired verification codes, resends, duplicate subscriptions, and both unsubscribe paths.
7. Review the public pages for claims about live data, alerts, billing, privacy, and accessibility. Rewrite any planned feature described as active.
8. Keep the incident-response steps below with the private project records.

## Free incident-response notes

If a problem is reported:

1. Stop the server or disable the subscription endpoint if subscriber data or email sending may be exposed.
2. Rotate the Brevo API key and, if necessary, the subscription signing secret.
3. Preserve relevant timestamps and redacted logs without copying secrets, email bodies, verification codes, or unsubscribe URLs.
4. Restore the last known-good data backup only after checking that it is not corrupted or exposed.
5. Tell affected subscribers what happened when required, remove compromised data, and document the resolution.
6. Record the cause and the code/configuration change that prevents recurrence.

## Production configuration requirements

Set these in the server's secret manager or environment—not in frontend JavaScript and not in Git:

```env
NODE_ENV=production
SUBSCRIPTION_ACCESS_CODE=<unique random value, at least 12 characters>
SUBSCRIPTION_SIGNING_SECRET=<random value, at least 32 characters>
BREVO_API_KEY=<Brevo API key>
BREVO_FROM_EMAIL=<verified Brevo sender>
PUBLIC_BASE_URL=https://your-domain.example
ALLOWED_HOSTS=your-domain.example
```

If the frontend is hosted separately, also set an exact origin:

```env
ALLOWED_ORIGINS=https://www.your-domain.example
```

Update the deployed static site's CSP `connect-src` to contain only the exact API origin when the API is separate. Do not use `*`.

## Current code-level protections

- Response-level CSP and browser security headers are set by the Node server; the deployed static `_headers` file contains equivalent baseline headers.
- Host headers are allowlisted and CORS origins are restricted to loopback development origins or explicitly configured origins.
- Three incorrect access-code attempts trigger a persisted 24-hour lockout keyed by an HMAC-derived network identifier; the frontend displays a live countdown and the backend enforces the lockout.
- Inputs have size limits and browser API POSTs require JSON.
- Verification codes use asynchronous salted scrypt hashes, expire, and have limited attempts.
- Brevo requests have a timeout and email-template values are escaped.
- Unsubscribe GET requests show a confirmation page; the state-changing action requires POST.
- The default server binds to loopback and production configuration fails closed when required settings are missing.
- Production is HTTPS-only: the server redirects plain-HTTP requests (as reported by the proxy's `X-Forwarded-Proto`) to the HTTPS URL and every response advertises HSTS.
- API access logs record only the HTTP method and path; query strings, which can carry signed unsubscribe tokens, are never logged.
- Signed unsubscribe tokens expire after 90 days by default (`SUBSCRIPTION_UNSUBSCRIBE_TOKEN_DAYS`).

## Release verification

Before launch:

- Confirm the server fails closed with an intentionally incomplete production configuration.
- Verify HTTPS redirects and HSTS at the reverse proxy.
- Confirm the public host and frontend origin are the only allowed values.
- Check response headers on HTML, JSON, API errors, and unsubscribe pages.
- Test invalid access codes, the third-failure 24-hour lockout and live countdown, expired verification codes, five failed verification-code attempts, repeated requests, malformed JSON, oversized bodies, traversal paths, and invalid unsubscribe tokens.
- Test the Brevo verification and unsubscribe flow from a real mailbox, including link-scanner behavior.
- Confirm no secret appears in Git, frontend assets, generated JSON, logs, backups, or error responses.
- Review the public data for prompt injection or unsafe generated content before publishing it.
