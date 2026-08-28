# Bill automation setup

The pipeline uses Open States for bill discovery and status metadata, retrieves the official bill text, then uses Bytez AI to create a validated 70–150 word summary.

```
Open States metadata -> official Texas bill text -> summarize_bills.py -> Bytez AI -> published JSON
```

## Add GitHub secrets

Open the repository on GitHub and go to **Settings -> Secrets and variables -> Actions**. Add these repository secrets:

| Secret | Purpose |
|---|---|
| `OPEN_STATES_API_KEY` | Fetches Texas bill records and document/version links. |
| `BYTEZ_API_KEY` | Generates summaries through Bytez's OpenAI-compatible API. |

No Cloudflare credentials are required by the current workflow.

## Optional repository variables

| Variable | Default | Purpose |
|---|---|---|
| `LARIAT_SESSION` | unset | Pin fetching to a particular Texas legislative session, such as `892`. |
| `SUMMARIZER_MODEL` | auto-discovered | Optional Bytez chat model identifier. The script verifies it against Bytez's live chat catalog; if unset or unavailable, it selects an available model, preferring free-meter models. |

## Run the workflow

1. Push the workflow and summarizer changes to the `main` branch.
2. Open **Actions -> Update bill summaries**.
3. Choose **Run workflow**, select `main`, and enter the desired bill limit.
4. Watch the `refresh` job.
5. If successful, the workflow commits the regenerated JSON automatically.

The scheduled run executes daily at 13:00 UTC. It also has a 45-minute maximum runtime.

## How each bill is processed

1. Open States supplies the identifier, session, status, and source links.
2. The summarizer retrieves a public official Texas bill-history page and the best available bill-text document.
3. The document text is hashed with SHA-256.
4. Bytez receives the official bill text and record metadata, not visitor information.
5. The result must be valid JSON and its main summary must contain 70–150 words.
6. A short result receives one explicit expansion request using the same bill text.
7. A matching text hash reuses the existing valid summary without another AI call.
8. The output stores the bill-text URL, text hash, word count, and `summary_source`.

The workflow does not publish metadata-only summaries. If official text cannot be reached or a bill has no valid existing summary, that run fails safely without committing an incomplete dataset.

## Free usage and reliability

- Open States, GitHub Actions, and the public Texas source do not require a bill-text API key.
- Bytez usage depends on the account's plan and model limits.
- Hash caching avoids repeating AI calls for unchanged bill text.
- Keep the fetch limit reasonable, especially when regenerating the whole dataset.
- The official Texas site may occasionally time out from a GitHub runner. The script uses bounded retries and the workflow stops after 45 minutes instead of running indefinitely.
- Verify important summaries against the official source. They are informational and not legal advice.

## Local run

Create a local `.env` from `.env.example`, set `OPEN_STATES_API_KEY` and `BYTEZ_API_KEY`, then run:

```bash
python3 fetch_texas_bills.py --limit 15
python3 summarize_bills.py
```
