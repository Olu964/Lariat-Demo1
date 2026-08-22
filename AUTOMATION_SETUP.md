# Bill automation setup — your part (3 steps, ~15 minutes)

The pipeline is already built and tested. These are the only steps that need
your accounts:

```
Open States API ──> summarize_bills.py ──> Cloudflare Workers AI ──> Lariat-real/texas_bill_summaries.json ──> committed to GitHub daily
     (already works)        (built)                     (you create the free key)                     (auto, 13:00 UTC daily)
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
   | `SUMMARIZER_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Default model. Set to `@cf/meta/llama-3.1-8b-instruct-fp8-fast` to use ~6× fewer free neurons. |

## Step 3 — Turn it on (~2 min)

1. Push the new files to GitHub (the workflow lives in `.github/workflows/update-bills.yml`).
2. Go to your repo's **Actions** tab → **"Update bill summaries"** → **Run workflow**
   (manual trigger) and watch it run. It fetches the bills, summarizes them with
   Cloudflare AI, and commits the result automatically.
3. After the first successful run, the daily schedule (13:00 UTC ≈ 7–8am Central)
   takes over. You never have to touch it again.

## Notes

- **Free forever:** Open States API (free key), Cloudflare Workers AI
  (10,000 neurons/day — a daily 50-bill run uses ~6–7k), GitHub Actions (free),
  Brevo email (300/day). No credit card anywhere.
- **If the AI quota runs out** on a given day, the workflow still succeeds — the
  summarizer falls back to placeholder summaries and the run is marked in the log.
  Switch to the smaller model (Step 2) if that happens.
- **Running locally:** `python3 fetch_texas_bills.py --limit 15` then
  `python3 summarize_bills.py`. Without a Cloudflare token it runs in mock mode
  and **keeps existing summaries untouched** — it only writes placeholders for
  bills that have never been summarized.
- **Private-repo caveat:** GitHub pauses *scheduled* workflows in private repos
  after 60 days without activity. Pushing anything (or clicking "Run workflow")
  resets it. Public repos are unaffected.
- **Quality note:** the AI writes from the Open States record (title, subjects,
  action history). Texas records carry no abstracts, so summaries are more
  conservative than the hand-curated ones currently in the site. Verify any
  important bill at capitol.texas.gov.
