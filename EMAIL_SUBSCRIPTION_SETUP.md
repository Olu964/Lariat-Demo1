# Lariat Email Subscription System

> **Security notice:** This is a historical planning document. Do not follow its
> old Resend/EmailJS or browser-localStorage implementation instructions for a
> deployment. The current implementation is `server/server.js` with Brevo and
> is documented in `server/README.md` and `SECURITY.md`.

## Private setup and testing instructions

This document describes how to add an email-only subscription system that can be tested privately with one email address. It is documentation only and is not loaded by the website.

> **Implementation status:** the backend described here is implemented in `server/server.js`, and the frontend in `Lariat-real/subscriptions.js` now talks to it. Run it with `node server/server.js` and open <http://127.0.0.1:3000>. Without a `RESEND_API_KEY` it runs in console mode and prints verification codes to the terminal, so the whole flow works with no accounts. See `server/README.md` for setup and testing.

---

## Recommended setup

For a private, email-only test, use:

- The existing Lariat HTML/CSS/JavaScript site
- A small local Node.js backend
- Resend, or another transactional email provider, for sending email
- Local storage for one test subscription
- A private access code
- A separate, one-time email verification code

The website can remain private on your computer at `127.0.0.1`. Only the email provider will receive the test email address and email content. The provider will technically process that recipient address, so "not public" does not mean that the address never leaves your computer.

The current Lariat site is static and does not currently have a backend. Sending email securely requires a backend so the email-provider API key is never exposed to browser JavaScript.

---

## 1. Decide the subscription rules

Before implementation, decide these values.

### Test email

Use one email address that you control:

```text
your-email@example.com
```

### Private access code

Choose a private code that users must know before subscribing:

```text
LARIAT-TRIAL-2026
```

This must not be the same as the email verification code.

### Verification process

Use this flow:

1. The user clicks **Subscribe** for an industry.
2. The user enters the private access code.
3. The user enters an email address.
4. The system sends a one-time six-digit code by email.
5. The user enters that code on the website.
6. The subscription becomes active.

Do not use one permanent codeword as the only password. A permanent code can be forwarded or reused. The access code controls who is allowed to subscribe, while the one-time code proves that the email belongs to the user.

### Email wording

Prepare the message you want users to receive. Example:

```text
Subject:
Confirm your Lariat bill alert subscription

Body:
You requested bill alerts for the {{industry}} industry.

Your verification code is:

{{verification_code}}

This code expires in 10 minutes and can only be used once.

If you did not request this subscription, you can ignore this email.
```

---

## 2. Install Node.js locally

The current project is a static site and does not have a backend. Install the current Node.js LTS release on your computer.

After installing it, open Terminal and verify the installation:

```bash
node --version
npm --version
```

You should see version numbers for both commands.

Node.js itself is free.

---

## 3. Create an email-provider account

Create an account with Resend or another transactional email provider. Resend is a suitable developer-focused option for verification emails and bill-alert emails.

For private testing:

- Use your own email address.
- Do not invite other users.
- Do not publish the API key.
- Do not add the API key to frontend JavaScript.
- Check the provider's current free-tier limits before testing repeatedly.

During early testing, the provider may require messages to be sent only to the email address associated with your account. That is sufficient for a one-email test.

---

## 4. Configure the sender email

You need a sender address, such as:

```text
alerts@yourdomain.com
```

There are two possibilities.

### Option A: Provider test sender

Use the provider's test sender if it allows messages to your own account email. This is easiest for local testing and may not require a custom domain.

### Option B: Verify your own domain

If the provider requires a custom sender, add the DNS records requested by the provider at your domain registrar. This does not make your website public. It only verifies that you are authorized to send mail from that domain.

You may need to add:

- SPF
- DKIM
- DMARC

Do not use a fake sender address. Messages sent from an unverified address are more likely to fail or go to spam.

---

## 5. Create an API key

Inside the email-provider dashboard:

1. Open the API key section.
2. Create a key for development or testing.
3. Give it the minimum available permissions.
4. Copy it once.
5. Store it only in a local environment file.

Never put the API key in:

- `real-script.js`
- `feed.html`
- Browser developer tools
- GitHub
- Screenshots
- Chat messages
- Any public JavaScript file

Anyone who obtains the API key could send email through your account.

---

## 6. Create a local environment file

The repository contains `.env.example`. Create a local `.env` file at the project root.

It should contain values similar to:

```env
RESEND_API_KEY=your_private_api_key
RESEND_FROM_EMAIL=your_verified_sender@example.com
SUBSCRIPTION_ACCESS_CODE=LARIAT-TRIAL-2026
SUBSCRIPTION_CODE_EXPIRY_MINUTES=10
```

Do not commit this file.

The repository's `.gitignore` is intended to ignore `.env` files. Confirm that `.env` is not shown by:

```bash
git status
```

If `.env` appears as an untracked file, stop and update `.gitignore` before continuing.

Do not paste the API key into chat.

---

## 7. Keep subscription data outside the public website folder

The public frontend is in:

```text
Lariat-real/
```

The backend's private data should not be placed inside a browser-accessible folder.

A safe structure would be:

```text
Lariat-Demo1/
├── Lariat-real/
│   ├── feed.html
│   ├── real-script.js
│   ├── styles.css
│   └── texas_bill_summaries.json
├── server/
│   ├── server.js
│   └── data/
│       └── subscriptions.json
├── .env
└── .gitignore
```

The subscription file must never be loaded by frontend JavaScript.

For a one-email local test, a local file can be acceptable. It should contain only the data needed:

```json
[
  {
    "email": "your-email@example.com",
    "industry": "Healthcare",
    "verified": true,
    "createdAt": "2026-08-12T12:00:00.000Z"
  }
]
```

For a real launch, use an encrypted database rather than a plain JSON file.

---

## 8. Add the backend subscription endpoints

The backend should provide endpoints similar to these.

### Request a verification code

```text
POST /api/subscriptions/request
```

Input:

```json
{
  "email": "your-email@example.com",
  "industry": "Healthcare",
  "accessCode": "LARIAT-TRIAL-2026"
}
```

The server should:

1. Validate the email format.
2. Validate that the industry exists.
3. Check the private access code.
4. Generate a random six-digit code.
5. Store only a hash of the verification code.
6. Set an expiration time.
7. Send the code through the email provider.
8. Avoid revealing whether an email is already subscribed.

### Verify the email

```text
POST /api/subscriptions/verify
```

Input:

```json
{
  "email": "your-email@example.com",
  "industry": "Healthcare",
  "verificationCode": "482913"
}
```

The server should:

1. Hash the submitted code.
2. Compare it with the stored hash.
3. Confirm that it has not expired.
4. Confirm that it has not already been used.
5. Mark the subscription as verified.
6. Delete the verification code.
7. Show a success message.

### Unsubscribe

```text
POST /api/subscriptions/unsubscribe
```

The unsubscribe flow should not require a normal login. It can use a signed unsubscribe token contained in an alert email.

---

## 9. Add the subscription UI

For every rendered industry group, add a button near the industry heading:

```text
Subscribe to Healthcare alerts
```

Clicking the button should open a modal containing:

1. The industry name
2. An email input
3. A private access-code input
4. A **Send verification code** button
5. A verification-code input that is initially hidden
6. A **Confirm subscription** button
7. Success and error messages
8. A privacy explanation

Example privacy text:

```text
Your email is used only for Lariat bill alerts. It is not displayed publicly.
You can unsubscribe at any time.
```

The UI must never contain:

```text
RESEND_API_KEY
```

The browser should communicate only with the local backend.

---

## 10. Customize the verification email

The backend can send a custom HTML email containing:

- The Lariat name or logo
- The industry name
- The verification code
- The expiration time
- An explanation of why the email was sent
- Privacy language
- A support contact
- Unsubscribe or ignore instructions

Example:

```html
<h1>Confirm your Lariat subscription</h1>

<p>
  You requested bill alerts for the <strong>Healthcare</strong> industry.
</p>

<p>Your verification code is:</p>

<p style="font-size: 28px; font-weight: bold;">
  482913
</p>

<p>
  This code expires in 10 minutes and can only be used once.
</p>

<p>
  If you did not request this, you can safely ignore this email.
</p>
```

Use a random code for every request. Do not email the permanent private access code.

---

## 11. Keep the website private while testing

Start the backend so it listens only on your computer:

```text
127.0.0.1
```

The private local URL would look like:

```text
http://127.0.0.1:3000
```

This means:

- Other people cannot access it over the internet.
- Search engines cannot index it.
- Your home network generally cannot access it.
- You can test it from your own computer.

Do not use port forwarding, ngrok, Cloudflare tunnels, or public hosting during the first test.

Do not bind the server to:

```text
0.0.0.0
```

Use `127.0.0.1` instead.

---

## 12. Test the complete flow

Use your own email and test this sequence:

1. Open the local Lariat page.
2. Select an industry.
3. Click that industry's Subscribe button.
4. Enter the private access code.
5. Enter your email address.
6. Click **Send verification code**.
7. Confirm that the email arrives.
8. Enter the one-time code.
9. Confirm that the UI says the subscription is active.
10. Check the local subscription data.
11. Trigger a test bill alert.
12. Confirm that the alert email arrives.
13. Click unsubscribe.
14. Confirm that future alerts are disabled.

Also test these failure cases:

- Incorrect access code
- Invalid email address
- Incorrect verification code
- Expired verification code
- Reused verification code
- Missing industry
- Repeated verification requests
- Unsubscribe after verification

---

## 13. Test new-bill alerts

The current `texas_bill_summaries.json` file is a local snapshot. It will not automatically know when Texas releases a new bill.

The alert system eventually needs this process:

1. Fetch the newest bill records from Open States or another source.
2. Compare their unique IDs with previously seen bill IDs.
3. Identify new records.
4. Read each bill's industry.
5. Find verified subscribers for that industry.
6. Send each subscriber one email.
7. Record that the alert was sent.
8. Avoid sending the same bill repeatedly.

For private testing, the simplest approach is a manually triggered test alert. This verifies email delivery before automatic bill retrieval is connected.

After that works, test detection by adding a mock bill with a new unique identifier to a copy of the local data.

---

## 14. Protect the test data

For the private test:

- Keep `.env` local.
- Keep subscription data outside `Lariat-real/`.
- Use `127.0.0.1`.
- Do not commit the email address to Git.
- Do not log email addresses unnecessarily.
- Do not log verification codes.
- Use a short code expiration time.
- Delete unverified subscriptions after a short period.
- Limit verification attempts.
- Rate-limit email requests.
- Never return the full subscription list to the browser.

The email provider will still process the recipient email address because it must deliver the message. The important distinction is that the address will not be publicly exposed by your website.

---

## 15. What the project owner must provide before implementation

The account-related steps must be completed by the project owner:

1. Create the email-provider account.
2. Decide the test email address.
3. Decide the private access code.
4. Obtain the provider API key.
5. Choose or verify the sender email.
6. Put the credentials in the local `.env` file.
7. Confirm that the local credentials are ready.

Never paste the API key into chat. Once the local credentials are ready, the technical implementation can add the frontend, local backend, verification flow, custom email templates, and private test-alert endpoint.

---

## Important cost and privacy notes

- A small email-only test may fit within a provider's free tier, but free-tier limits can change.
- A custom sending domain may require owning a domain, which can have a cost.
- SMS is generally not free and is not included in this email-only setup.
- No system can guarantee zero cybercrime risk.
- HTTPS, encrypted storage, restricted access, short-lived codes, minimal logging, rate limiting, and data minimization reduce risk.
- A third-party email provider can technically see the email address and message content required to deliver the email.
- Keeping the website local prevents the website from being publicly accessible, but it does not prevent the email provider from processing delivery data.
