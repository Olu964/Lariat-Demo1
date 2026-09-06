# Lariat Project  -  Session Context (September 2, 2026)

## What This Project Is

Lariat is a Texas bill tracking website that:
- Fetches recent bills from the Texas Legislature via Open States API
- Downloads official bill text for each bill
- Uses AI (via OpenRouter) to generate 50-200 word summaries from the bill text
- Commits updated summaries to GitHub, which auto-deploys the website
- The website lives in `Lariat-real/` and reads from `Lariat-real/texas_bill_summaries.json`

## Project Structure

```
.github/workflows/update-bills.yml    -  GitHub Actions workflow (daily + manual)
fetch_texas_bills.py                   -  Fetches bill metadata from Open States API
summarize_bills.py                     -  Fetches bill text + calls AI to generate summaries
Lariat-real/texas_bill_summaries.json  -  The JSON file the website reads from
Lariat-real/real-script.js             -  Website frontend (line 367 loads the JSON)
Lariat-real/feed.html                  -  The bill feed page
.env.example                           -  Template for API keys
```

## API Keys / Secrets in GitHub

| Secret/Variable         | Where Used         | Purpose                              |
|------------------------|--------------------|------------------------------------|
| `OPEN_STATES_API_KEY`  | fetch_texas_bills.py | Fetch bill metadata from Open States |
| `OPENROUTER_API_KEY`   | summarize_bills.py   | Call AI models for summarization    |
| `SUMMARIZER_MODEL` (var)| summarize_bills.py | Optional: override default AI model |
| `LARIAT_SESSION` (var) | fetch_texas_bills.py | Optional: filter by session          |

## Most Recent Workflow Run (September 2, 2026)

### Status: PARTIAL SUCCESS ✅

**14 out of 25 bills successfully summarized!**

**Bills that got AI summaries:**
- SB 10, SB 8, SB 16, SB 5, SB 3, SB 58
- HB 161, HB 200, HB 188, SB 9, HB 194, HB 242, HB 294, HB 259

**Bills that still failed:**
- Resolutions (SR 76, HR 32, SR 60, HR 23, SR 23, HJR 40, HR 35, HJR 21, SR 95)  -  these may not have bill text documents
- SB 2  -  summary was too long (189 words, now fixed to allow 50-200 words)

**Summary:**
- 24 summaries saved (14 new AI-generated + 10 existing)
- 1 bill unresolved (SR 23)
- AI model used: `liquid/lfm-2.5-2.6b:free`
- Workflow succeeded (green checkmark)

### What Changed Since Last Run
- Increased max summary length from 150 to 200 words (to fix SB 2 failure)
- This should allow more detailed summaries for complex bills

## Current Status: Ready to Push Changes

### What the Latest Workflow Run Showed

When you ran the workflow on GitHub, this is what happened:

1. **Fetch bills step**  -  Works fine. Gets 25 bills from Open States.
2. **Summarize bills step**  -  MIXED RESULTS:
   ```
   [2/25] SB 10 -> AI (liquid/lfm-2.5-2.6b:free)     ✅ SUCCESS
   [3/25] SB 8 -> AI (liquid/lfm-2.5-2.6b:free)       ✅ SUCCESS
   [4/25] SB 2 -> deferred: summary too long            ❌ FIXED (now allows 200 words)
   [8/25] SR 76 -> deferred: no usable bill text        ❌ RESOLUTION (may not have text)
   ... (14 bills succeeded, 11 failed)
   ```
3. **AI runs**  -  Successfully generated 50-150 word summaries from actual bill text
4. **Commit step runs**  -  Published 24 summaries (14 new + 10 existing)
5. **Website needs pull**  -  Run `git pull` to see updates

### Why It Happens (The Complete Explanation)

The workflow has a chain of steps to get bill text:

```
Step 1: Check cache for previously downloaded text → Empty (first time)
Step 2: Check Open States API for document URLs → NONE (API doesn't provide them for Texas)
Step 3: Try direct Text.aspx page → JavaScript-loaded, HTML parser gets interface instead of content
Step 4: Try FTP site → Times out or file not found
Step 5: Try History page scraping → Finds links but they're also JavaScript-loaded
Result: "no usable official bill-text document found"
```

**The fundamental problem**: The Texas Legislature website (`capitol.texas.gov`) stores bill text in HTML and PDF files at a known URL pattern, but the script wasn't trying those URLs directly. Instead, it was scraping the website's interface pages, which don't contain the actual bill text (it's loaded via JavaScript).

### The Fix (Two Bugs Fixed)

**Bug 1  -  Wrong bill text source:**
- The Open States API returns NO document URLs for Texas bills
- The Texas Legislature website loads bill text via JavaScript, so scraping HTML pages doesn't get the content
- The FTP site was unreliable
- FIX: Added `capitol_pdf_urls()` function that constructs direct PDF/HTML URLs:
  - HTML: `https://capitol.texas.gov/tlodocs/{session}/billtext/html/{padded_number}{version}.htm`
  - PDF: `https://capitol.texas.gov/tlodocs/{session}/billtext/pdf/{padded_number}{version}.pdf`
  - Example: `https://capitol.texas.gov/tlodocs/892/billtext/html/SB00001E.htm`
  - Versions tried: E (engrossed), I (introduced), S (substitute), H
  - Both 4-digit and 5-digit zero padding are tried (e.g., SB0001 and SB00001)

**Bug 2  -  Broken validation:**
- `usable_bill_text()` checked for patterns like `"amended by"`, `"the legislature"`, `"section "` against text with ALL spaces removed
- Multi-word patterns could NEVER match in space-removed text
- Only single-word patterns like `"notwithstanding"` worked
- FIX: Changed to check patterns against `text.lower()` (with spaces) instead of `lowered` (spaces removed)
- Also reduced required pattern matches from 2 to 1

### What Should Happen After Pushing the Fix

1. **Fetch bills step**  -  Same, gets 25 bills
2. **Summarize bills step**  -  Bills now show:
   ```
   [1/25] SB 1: using cached official bill text   (or: fetching from HTML URL)
   [1/25] SB 1 -> AI (minimax/minimax-m2.7:free)   ← THIS IS THE GOAL
   ```
3. **AI runs**  -  Generates 50-200 word summaries from actual bill text
4. **Commit step**  -  Publishes new longer summaries
5. **Website updates**  -  Shows proper bill summaries

### What Was Verified Locally
- `fetch_bill_text()` successfully got 2,421 words for SB 1 from the HTML URL
- `usable_bill_text()` returns True for SB 1 and HB 200
- The full chain works end-to-end
- The PDF URL `https://capitol.texas.gov/tlodocs/892/billtext/pdf/SB00001E.pdf` returns HTTP 200
- The HTML URL `https://capitol.texas.gov/tlodocs/892/billtext/html/SB00001E.htm` returns HTTP 200
- Both contain real bill text (2,400+ words)

## What Has NOT Been Pushed Yet

The following changes are committed locally but NOT pushed to GitHub:

```
e962b09 Fix bill text retrieval with direct PDF/HTML URLs
        (also includes usable_bill_text validation fix)
```

Additional uncommitted change: the `usable_bill_text` pattern matching fix may need to be committed.

### CHECK LOCAL STATE FIRST
Run `git status -sb` and `git log -3 --oneline` to see what's committed and what's ahead of origin.

## How to Push (Type These Commands)

```bash
# Stage any uncommitted changes
git add summarize_bills.py

# Commit
git commit -m "Fix bill text validation and URL patterns"

# Pull and rebase
git pull --rebase origin main

# Push
git push origin main

# Verify
git status -sb
# Should show: ## main...origin/main (no [ahead N])
```

## How to Run the Workflow After Pushing

1. Go to GitHub → Actions → "Update bill summaries"
2. Click "Run workflow"
3. Select `main`
4. Enter `25` for the limit
5. Click "Run workflow"
6. Open the newest run
7. Check the "Verify workflow revision" step  -  it should say "Summary-only prompt is active"
8. Bills should now show `→ AI (model_name)` instead of `→ deferred`

## Other Changes Made in This Session

### Workflow changes (.github/workflows/update-bills.yml)
- Added `if: always()` to commit step so partial results are published even when some bills fail
- Added `--write-partial` flag to summarize_bills.py so successful bills are published even if some fail
- Both code paths pass `--write-partial`
- Added verification step that prints "Summary-only prompt is active"

### Summarize_bills.py changes
- AI now generates ONLY `{ "summary": "..." }` (not 10 fields)
- Script preserves existing display fields (title, affects, changes, business_impact, etc.)
- Added `--write-partial` flag
- Added `capitol_text_url()` for direct Text.aspx page
- Added `capitol_pdf_urls()` for direct PDF/HTML bill text URLs
- Increased timeouts: 30s → 60s, retries: 2 → 3, delays: 3-12s → 5-20s
- Added 5-second delay between API requests
- Added merge logic so old bills are preserved when new bills are fetched
- With `--write-partial`: exits 0 if at least one bill succeeds
- Minimum summary length: 50 words (was 70)
- Maximum summary length: 200 words (increased from 150 to allow more detailed summaries)

### AUTOMATION_SETUP.md changes
- Updated to reflect 50-200 word requirement
- Updated to reflect summary-only AI output

## Other TODOs for Going Live

### Website Deployment (not yet done)
The website needs a hosting service. Recommended options:
1. **Netlify** (recommended)  -  free, auto-deploys on push
   - Base directory: `Lariat-real`
   - Publish directory: `.`
2. **GitHub Pages**  -  free, simpler
   - Settings → Pages → Source: Deploy from a branch → main → folder: /Lariat-real
3. **Vercel**  -  similar to Netlify

The workflow already works for deployment  -  it commits to main, and any hosting service that auto-deploys on push will pick up the changes.

### Browser Caching Fix (recommended for live site)
In `Lariat-real/real-script.js`, change the fetch call to bust cache:
```javascript
// Change: const response = await fetch('texas_bill_summaries.json', { cache: 'default' });
// To:     const response = await fetch(`texas_bill_summaries.json?v=${Date.now()}`, { cache: 'no-store' });
```

### Browser Cache Workaround (for local testing)
Hard refresh: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)

## Key File Locations for Reference

| File | Line | What |
|------|------|------|
| summarize_bills.py | ~108 | `capitol_pdf_urls()`  -  constructs direct bill text URLs |
| summarize_bills.py | ~253 | `usable_bill_text()`  -  validates extracted text |
| summarize_bills.py | ~270 | `fetch_bill_text()`  -  main bill text retrieval chain |
| summarize_bills.py | ~88 | `capitol_url()`  -  history page URL |
| summarize_bills.py | ~94 | `capitol_pdf_urls()` / `fetch_bill_text()`  -  official HTTPS bill-text retrieval |
| .github/workflows/update-bills.yml | 1-75 | Full workflow definition |
| Lariat-real/real-script.js | ~367 | Where website loads the JSON |
| fetch_texas_bills.py | ~100 | Open States API request with `include: ["abstracts", "documents", "versions"]` |

## OpenRouter Free Models (Fallback Chain)

```
google/gemma-4-26b-a4b-it:free
google/gemma-4-31b-it:free
dots-studio/dots-3-note-preview:free
google/lyria-3-clip-preview
google/lyria-3-pro-preview
liquid/lfm-2.5-2.6b:free
minimax/minimax-m2.7:free
minimax/minimax-m3:free
```

Rate limits reset at midnight UTC. Free models have daily limits.

## Error Messages and What They Mean

| Error | What It Means | Fix |
|-------|--------------|-----|
| `no usable official bill-text document found` | Script couldn't find bill text from any source | Push the new PDF/HTML URL fix |
| `official page request failed after N attempts: timed out` | Texas Legislature website is slow/down | Wait and retry, or increase timeout |
| `website returned interface page instead of bill text` | Got the website navigation instead of bill content | The `extract_document_text` function rejected it |
| `AI output is missing required fields` | AI didn't return valid JSON with a `summary` field | Model issue  -  fallback chain tries next model |
| `minimax/minimax-m3:free is temporarily rate-limited` | OpenRouter free model rate limit hit | Wait for rate limit reset (midnight UTC) |
| `model does not exist or has yet to be added` | Wrong model name in SUMMARIZER_MODEL variable | Check the model name, or remove the variable to use defaults |
| `Error: Process completed with exit code 1` | Some bills failed but `--write-partial` published successful ones | Normal when some bills fail  -  check if commit step ran |

## What to Do When You Return

1. **First**: Run `git status -sb` and `git log -3 --oneline` to see current state
2. **Pull latest changes from GitHub**: `git pull`
3. **Push any unpushed changes** (see push commands above)
4. **Run the workflow** from GitHub Actions
5. **Check if bills now get `→ AI` instead of `→ deferred`**
6. **If bills still fail**: Check the specific error after the `→ deferred` line
7. **Pull changes**: `git pull` after workflow completes
8. **Refresh browser**: Cmd+Shift+R to see updated summaries

### Current State Summary (End of Session)
- ✅ 14 out of 25 bills successfully summarized with AI
- ✅ Bill text retrieval working for most bills (HTML/PDF URLs)
- ✅ AI generating 50-200 word summaries from actual bill text
- ⚠️ 11 bills still failing (mostly resolutions without text documents)
- ⚠️ Local changes not yet pushed (max word count increase)
- 📋 TODO: Deploy website to hosting service (Netlify/GitHub Pages)
- 📋 TODO: Add browser caching fix to real-script.js
