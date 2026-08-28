# Bill automation setup

The pipeline uses Open States for bill discovery and status metadata, retrieves the official bill text, then uses OpenRouter AI to create a validated 70–150 word summary.

```
Open States metadata -> official Texas bill text -> summarize_bills.py -> OpenRouter AI -> published JSON
```

## Add GitHub secrets

Open the repository on GitHub and go to **Settings -> Secrets and variables -> Actions**. Add these repository secrets:

| Secret | Purpose |
|---|---|
| `OPEN_STATES_API_KEY` | Fetches Texas bill records and document/version links. |
| `OPENROUTER_API_KEY` | Generates summaries through OpenRouter. |

No Bytez or Cloudflare credentials are required by the current workflow.

## Optional repository variables

| Variable | Default | Purpose |
|---|---|---|
| `LARIAT_SESSION` | unset | Pin fetching to a particular Texas legislative session, such as `892`. |
| `SUMMARIZER_MODEL` | `nvidia/nemotron-3-ultra:free` | OpenRouter model identifier. |

## Run the workflow

1. Push the workflow and summarizer changes to the `main` branch.
2. Open **Actions -> Update bill summaries**.
3. Choose **Run workflow**, select `main`, and enter the desired bill limit.
4. Watch the `refresh` job.
5. If successful, the workflow commits the regenerated JSON automatically.

The scheduled run executes daily at 13:00 UTC and has a 45-minute maximum runtime.

## How each bill is processed

1. Open States supplies the identifier, session, status, and source links.
2. The summarizer retrieves a public official Texas bill-history page and the best available bill-text document.
3. The document text is hashed with SHA-256.
4. OpenRouter receives the official bill text and record metadata, not visitor information.
5. The result must be valid JSON and its main summary must contain 70–150 words.
6. A short result receives one explicit expansion request using the same bill text.
7. A matching text hash reuses the existing valid summary without another AI call.
8. The output stores the bill-text URL, text hash, word count, and `summary_source`.

The workflow does not publish metadata-only summaries. If official text cannot be reached or a bill has no valid existing summary, that run fails safely without committing an incomplete dataset.

## Free usage and reliability

- Open States, GitHub Actions, and the public Texas source do not require a bill-text API key.
- OpenRouter model availability and free-tier limits can change; verify the selected model in your OpenRouter account.
- Hash caching avoids repeating AI calls for unchanged bill text.
- Keep the fetch limit reasonable, especially when regenerating the whole dataset.
- Verify important summaries against the official source. They are informational and not legal advice.

## Local run

Create a local `.env` from `.env.example`, set `OPEN_STATES_API_KEY` and `OPENROUTER_API_KEY`, then run:

```bash
python3 fetch_texas_bills.py --limit 15
python3 summarize_bills.py
```
