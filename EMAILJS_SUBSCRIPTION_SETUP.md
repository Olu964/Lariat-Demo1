# Archived: EmailJS subscription setup

> **This document is obsolete and must not be used for the current site.**

The browser-based EmailJS subscription prototype has been replaced by the zero-dependency backend in `server/server.js`.

The current flow is:

1. The browser sends subscription requests to the Lariat backend.
2. The backend checks the private access code.
3. After three incorrect access-code attempts from a network address, the backend enforces a 24-hour lockout. The Bill feed displays a live countdown.
4. The backend generates and stores only a salted scrypt hash of the verification code.
5. Brevo sends the verification and welcome emails server-side.
6. The browser never receives an email API key.

Use these current instructions instead:

- [`server/README.md`](server/README.md) — local setup, API, and testing
- [`SECURITY.md`](SECURITY.md) — security and free pre-release checklist
- [`README.md`](README.md) — project setup

Do not add EmailJS credentials to `Lariat-real/subscriptions.js`. Do not restore the old client-side verification flow: client-side verification is not a security boundary and exposes the email-sending integration to visitors.
