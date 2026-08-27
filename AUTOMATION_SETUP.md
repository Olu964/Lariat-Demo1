# Bill automation setup — your part (3 steps, ~15 minutes)

The pipeline is already built and tested. These are the only steps that need
your accounts:

```
Open States metadata ──> official Texas bill text ──> summarize_bills.py ──> Cloudflare Workers AI ──> Lariat-real/texas_bill_summaries.json
       (discovery)             (free source)                 (70–150 words, cached by text hash)       (committed daily)
```

## Step 1 — Get a free Cloudflare API token (~5 min)

1. Go to **https://dash.cloudflare.com** and sign up (free plan, no credit card).
2. In the left sidebar click **Workers & Pages**. Copy the **Account ID** shown
   there (32-character string). Keep it — you'll need it below.
3. Click your profile icon (top right) → **My Profile → API Tokens → Create Token**.
4. Choose the **"Workers AI"** template. If it's not listed, create a custom
   token with one permission: `Account → Workers AI → Edit`.
5. Click **Continue** → **Create token** → **Copy** the token (it's shown only once).

You now have two values: your **Account ID** and your **API token**.

## Step 2 — Add them to GitHub (~3 min)

1. On your repo page (github.com/Olu964/Lariat-Demo1) go to
   **Settings → Secrets and variables → Actions**.
2. Under **Secrets**, click **New repository secret** and add these three:

   | Name | Value |
   |---|---|
   | `OPEN_STATES_API_KEY` | your Open States key (already in your local `.env`) |
   | `CLOUDFLARE_ACCOUNT_ID` | the Account ID from Step 1 |
   | `CLOUDFLARE_API_TOKEN` | the token from Step 1 |

3. (Optional) Under **Variables**, click **New repository variable**:

   | Name | Value | Why |
   |---|---|---|
   | `LARIAT_SESSION` | e.g. `892` | Pin the legislative session so fetches don't mix sessions. Leave unset to fetch the most recently updated bills. |
   | `SUMMARIZER_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fp8` | Default (cheap) model — a 25-bill run uses ~2k of the 10k free daily neurons. Set to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for higher-quality summaries at ~8× the neuron cost. Leave unset. |

## Step 3 — Turn it on (~2 min)

1. Push the new files to GitHub (the workflow lives in `.github/workflows/update-bills.yml`).
2. Go to your repo's **Actions** tab → **"Update bill summaries"** → **Run workflow**
   (manual trigger) and watch it run. It fetches the bills, summarizes them with
   Cloudflare AI, and commits the result automatically.
3. After the first successful run, the daily schedule (13:00 UTC ≈ 7–8am Central)
   takes over. You never have to touch it again.

## Notes

- **Free forever:** Open States API (free key), Cloudflare Workers AI
  (10,000 neurons/day — a 25-bill run with the default 8B model uses ~2k),
  GitHub Actions (free), Brevo email (300/day). No credit card anywhere.
- **If the AI quota runs out** on a given day (e.g. after many manual test runs,
  or if you switched to the 70B model), the summarize step fails and nothing is
  committed — mock placeholder summaries are never pushed to the site. The
  10k-neuron allowance resets daily at 00:00 UTC; re-run the workflow after the
  reset to generate the real AI summaries.
- **Bills accumulate over time:** each run refreshes the summaries of the
  most recently updated bills and **adds new ones**, while bills that drop out
  of the daily fetch are retained in the dataset — so the feed grows instead
  of churning through only the latest 25. (The fetch limit is `25` by default;
  raise it via the workflow's "Run workflow" input to bring in more bills per
  day.)
- **Running locally:** `python3 fetch_texas_bills.py --limit 15` then
  `python3 summarize_bills.py`. Without a Cloudflare token it runs in mock mode
  and **keeps existing summaries untouched** — it only writes placeholders for
  bills that have never been summarized.
- **Private-repo caveat:** GitHub pauses *scheduled* workflows in private repos
  after 60 days without activity. Pushing anything (or clicking "Run workflow")
  resets it. Public repos are unaffected.- **Quality note:** the summarizer retrieves the latest usable official Texas bill-text document from each bill history page and requires a 70–150 word summary. The exact document URL, SHA-256 text hash, word count, and `summary_source` are stored with each record. If a bill-text document cannot be retrieved, the run fails rather than publishing an unsupported metadata-only summary. Verify important bills at capitol.texas.gov.
