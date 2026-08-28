#!/usr/bin/env python3
"""Generate Lariat bill summaries from official Texas bill text when available."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

DEFAULT_INPUT = "texas_bills.json"
DEFAULT_OUTPUT = "Lariat-real/texas_bill_summaries.json"
DEFAULT_MODEL = "nvidia/nemotron-3-ultra:free"
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
MIN_SUMMARY_WORDS = 70
MAX_SUMMARY_WORDS = 150
FEED_META_PATTERN = re.compile(r'(<meta name="lariat-data-updated" content=")[^"]*(")')

INDUSTRIES = ["Energy & Utilities", "Government & Municipal Operations", "Emergency & Public Safety", "Real Estate & Land Use", "Insurance & Financial Services", "N/A"]
INDUSTRY_LIST = ", ".join(f'"{item}"' for item in INDUSTRIES)
STATUS_VALUES = "alive, active, pending, passed, signed, enacted, adopted, failed, did not pass, died, replaced"
SCRIPT_OWNED_FIELDS = ("id", "identifier", "session", "updated_at", "source_url")

SYSTEM_PROMPT = f"""You are a neutral Texas legislative analyst. Use ONLY the supplied official bill text and record metadata. Never invent facts. Return one JSON object on one line with exactly these keys: title (2-8 words), summary, affects, changes, business_impact, impact_level (High/Moderate/Low), industry (one of {INDUSTRY_LIST}), specific_industry (2-5 words or N/A), status (one of {STATUS_VALUES}), suggested_action. The summary MUST be one paragraph of 70-150 words, counting whitespace-separated words. It must explain the bill's purpose, operative changes, affected parties, important requirements/exceptions/funding/effective date when present, and recorded legislative status. If full text is unavailable or incomplete, say so explicitly and avoid guessing. For ceremonial resolutions, explain that they have no legal effect. This is informational, not legal advice."""

class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip = 0
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"script", "style", "noscript"}: self.skip += 1
    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style", "noscript"} and self.skip: self.skip -= 1
    def handle_data(self, data: str) -> None:
        if not self.skip: self.parts.append(data)
    def text(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.parts)).strip()

class LinkExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(); self.links: list[tuple[str, str]] = []
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a": return
        values = dict(attrs); href = values.get("href") or ""
        self.links.append((values.get("title") or "", href))
    

def load_dotenv(path: Path) -> None:
    if not path.exists(): return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        key, value = line.split("=", 1); key = key.strip(); value = value.strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key): os.environ.setdefault(key, value.strip('"\''))


def read_bills(path: Path) -> list[dict[str, Any]]:
    parsed = json.loads(path.read_text(encoding="utf-8"))
    bills = parsed if isinstance(parsed, list) else parsed.get("bills", []) if isinstance(parsed, dict) else []
    if not isinstance(bills, list): raise SystemExit(f"Unexpected JSON shape in {path}")
    return [item for item in bills if isinstance(item, dict)]


def capitol_url(bill: dict[str, Any]) -> str:
    session = str(bill.get("session") or "").strip(); identifier = str(bill.get("identifier") or "").strip()
    if session and identifier: return f"https://capitol.texas.gov/BillLookup/History.aspx?LegSess={session}&Bill={identifier.replace(' ', '')}"
    return str(bill.get("openstates_url") or "https://capitol.texas.gov/")


def fetch_html(url: str, *, attempts: int = 2, timeout: int = 30) -> str:
    """Fetch an official page with bounded retries for transient timeouts."""
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        request = Request(url, headers={
            "User-Agent": "Lariat bill research bot; contact via repository",
            "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
            "Connection": "close",
        })
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except (HTTPError, URLError, TimeoutError, ConnectionError) as exc:
            last_error = exc
            if isinstance(exc, HTTPError) and exc.code not in {408, 425, 429} and exc.code < 500:
                break
            if attempt < attempts:
                time.sleep(min(3 * attempt, 12))
    raise RuntimeError(f"official page request failed after {attempts} attempts: {last_error}")


def fetch_bill_text(bill: dict[str, Any]) -> tuple[str, str]:
    """Find and download a bill-text link from the official history page."""
    history_url = capitol_url(bill); html = fetch_html(history_url); parser = LinkExtractor(); parser.feed(html)
    identifier = re.sub(r"\s+", "", str(bill.get("identifier") or "")).lower()
    candidates: list[tuple[int, str]] = []
    for label, href in parser.links:
        absolute = urljoin(history_url, href)
        text = f"{label} {href}".lower()
        if not absolute.startswith("https://capitol.texas.gov/"): continue
        if any(word in text for word in ("text", "html", "pdf", "introduced", "engrossed", "enrolled", "substitute")):
            score = 0
            for word, points in (("enrolled", 60), ("engrossed", 50), ("substitute", 40), ("introduced", 30), ("text", 10), ("pdf", 5)):
                if word in text: score += points
            candidates.append((score, absolute))
    for _, url in sorted(candidates, reverse=True)[:4]:
        try:
            raw = fetch_html(url, attempts=2, timeout=45); extractor = TextExtractor(); extractor.feed(raw); text = extractor.text()
            if len(text.split()) >= 100 and (identifier in text.lower().replace(" ", "") or "relating to" in text.lower()): return text, url
        except (HTTPError, URLError, TimeoutError, ConnectionError, RuntimeError): continue
    raise RuntimeError("no usable official bill-text document found")


def bill_context(bill: dict[str, Any], text: str, text_url: str) -> str:
    org = bill.get("from_organization"); chamber = str(org.get("name") or "") if isinstance(org, dict) else ""
    subjects = "; ".join(str(x) for x in (bill.get("subject") or []))
    metadata = "\n".join(f"{key}: {value}" for key, value in [("identifier", bill.get("identifier")), ("title", bill.get("title")), ("chamber", chamber), ("session", bill.get("session")), ("subjects", subjects), ("latest_action_date", bill.get("latest_action_date")), ("latest_action_description", bill.get("latest_action_description")), ("latest_passage_date", bill.get("latest_passage_date")), ("official_text_url", text_url)] if value)
    return f"RECORD METADATA:\n{metadata}\n\nOFFICIAL BILL TEXT:\n{text[:120000]}"


def call_ai(context: str, model: str, api_key: str, *, system_prompt: str = SYSTEM_PROMPT) -> str:
    """Call OpenRouter's OpenAI-compatible chat endpoint and return its text."""
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": context},
        ],
        "temperature": 0.15,
        "max_tokens": 1800,
    }).encode("utf-8")
    request = Request(
        OPENROUTER_API_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "HTTP-Referer": "https://github.com/Olu964/Lariat-Demo1",
            "X-Title": "Lariat Texas Bill Summaries",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=120) as response:
            parsed = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        if exc.code == 429:
            raise RuntimeError(f"OpenRouter rate limit or quota reached (HTTP 429): {body}") from exc
        raise RuntimeError(f"OpenRouter API HTTP {exc.code}: {body}") from exc
    except (URLError, TimeoutError, ConnectionError) as exc:
        raise RuntimeError(f"OpenRouter request failed: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("OpenRouter returned an unexpected response shape")
    choices = parsed.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise RuntimeError(f"OpenRouter returned no choices: {str(parsed)[:300]}")
    message = choices[0].get("message")
    output = message.get("content") if isinstance(message, dict) else None
    if not isinstance(output, str):
        raise RuntimeError("OpenRouter returned no text content")
    return output


def extract_json(text: str) -> dict[str, Any] | None:
    cleaned = re.sub(r"```(?:json)?", "", text.strip()).strip()
    start = cleaned.find("{")
    if start < 0: return None
    depth = 0; in_string = False; escaped = False
    for index in range(start, len(cleaned)):
        character = cleaned[index]
        if in_string:
            if escaped: escaped = False
            elif character == "\\": escaped = True
            elif character == '"': in_string = False
        elif character == '"': in_string = True
        elif character == "{": depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(cleaned[start:index + 1])
                    return parsed if isinstance(parsed, dict) else None
                except json.JSONDecodeError:
                    return None
    return None


def word_count(value: Any) -> int: return len(re.findall(r"\b\w+(?:['’-]\w+)*\b", str(value or "")))


EXPANSION_PROMPT = f"""You are revising a Texas legislative bill summary. Use ONLY the supplied official bill text, metadata, and draft. Return the same JSON object with exactly the same keys. Replace only the summary with one neutral paragraph between {MIN_SUMMARY_WORDS} and {MAX_SUMMARY_WORDS} words. Add useful facts from the official text such as operative changes, affected parties, requirements, exceptions, funding, or effective dates when present. Do not pad with repetition or invent facts. Keep all other fields accurate and consistent with the text. Return JSON only."""


def generate_ai_record(context: str, model: str, api_key: str) -> dict[str, Any]:
    """Generate a valid-length record using at most two AI calls."""
    output = extract_json(call_ai(context, model, api_key))
    if output is None: raise RuntimeError("AI output was not valid JSON")
    count = word_count(output.get("summary"))
    if MIN_SUMMARY_WORDS <= count <= MAX_SUMMARY_WORDS: return output
    revision_context = f"{context}\n\nDRAFT JSON TO REVISE:\n{json.dumps(output, ensure_ascii=False)}\n\nThe draft summary contains {count} words. Rewrite it to exactly {MIN_SUMMARY_WORDS}-{MAX_SUMMARY_WORDS} words."
    revised = extract_json(call_ai(revision_context, model, api_key, system_prompt=EXPANSION_PROMPT))
    if revised is None: raise RuntimeError("AI expansion output was not valid JSON")
    revised_count = word_count(revised.get("summary"))
    if not MIN_SUMMARY_WORDS <= revised_count <= MAX_SUMMARY_WORDS:
        raise ValueError(f"summary has {revised_count} words after expansion; expected {MIN_SUMMARY_WORDS}-{MAX_SUMMARY_WORDS}")
    return revised


def normalize(record: dict[str, Any], bill: dict[str, Any], text_url: str | None, text_hash: str | None) -> dict[str, Any]:
    for field in SCRIPT_OWNED_FIELDS:
        record[field] = {"id": str(bill.get("id") or ""), "identifier": str(bill.get("identifier") or "Unknown"), "session": str(bill.get("session") or ""), "updated_at": date.today().isoformat(), "source_url": capitol_url(bill)}[field]
    record["summary"] = str(record.get("summary") or "").strip()
    if not 70 <= word_count(record["summary"]) <= 150: raise ValueError(f"summary has {word_count(record['summary'])} words; expected 70-150")
    for field in ("title", "affects", "changes", "business_impact", "suggested_action"): record[field] = str(record.get(field) or "Not provided").strip()
    record["impact_level"] = {"high": "High", "moderate": "Moderate", "low": "Low"}.get(str(record.get("impact_level") or "").lower(), "Low")
    record["status"] = str(record.get("status") or "pending").lower()
    record["industry"] = str(record.get("industry") or "N/A") if str(record.get("industry") or "N/A") in INDUSTRIES else "Government & Municipal Operations"
    record["specific_industry"] = str(record.get("specific_industry") or "N/A")
    if text_url: record["bill_text_source"] = text_url
    if text_hash: record["bill_text_hash"] = text_hash; record["summary_word_count"] = word_count(record["summary"]); record["summary_source"] = "official bill text"
    return record


def is_placeholder(record: dict[str, Any] | None) -> bool:
    return not isinstance(record, dict) or word_count(record.get("summary")) < 1 or "placeholder" in str(record.get("summary", "")).lower()


def update_feed(path: Path) -> None:
    if not path.exists(): return
    content = path.read_text(encoding="utf-8"); label = date.today().strftime("%B %-d, %Y")
    path.write_text(FEED_META_PATTERN.sub(lambda m: f'{m.group(1)}{label}"', content, count=1), encoding="utf-8")


def main() -> int:
    load_dotenv(Path(".env")); args = parse_args(); bills = read_bills(args.input)
    api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not api_key: raise SystemExit("OPENROUTER_API_KEY is required; refusing to publish metadata-only placeholders")
    model = args.model or DEFAULT_MODEL
    print(f"Using OpenRouter model: {model}")
    existing: dict[str, dict[str, Any]] = {}
    if args.output.exists():
        try: existing = {str(x.get("identifier", "")).lower(): x for x in json.loads(args.output.read_text()) if isinstance(x, dict)}
        except (OSError, json.JSONDecodeError): pass
    records: list[dict[str, Any]] = []; failures = 0; deferred: list[tuple[dict[str, Any], dict[str, Any] | None, str]] = []
    for index, bill in enumerate(bills, 1):
        identifier = str(bill.get("identifier") or "Unknown"); old = existing.get(identifier.lower())
        try:
            text, text_url = fetch_bill_text(bill); digest = hashlib.sha256(text.encode()).hexdigest()
            if old and old.get("bill_text_hash") == digest and 70 <= word_count(old.get("summary")) <= 150:
                records.append(old); print(f"[{index}/{len(bills)}] {identifier} -> cached"); continue
            output = generate_ai_record(bill_context(bill, text, text_url), args.model, api_key)
            records.append(normalize(output, bill, text_url, digest)); print(f"[{index}/{len(bills)}] {identifier} -> AI")
            time.sleep(args.delay)
        except Exception as exc:
            failures += 1; deferred.append((bill, old, str(exc))); print(f"[{index}/{len(bills)}] {identifier} -> deferred: {exc}", file=sys.stderr)
            if old and 70 <= word_count(old.get("summary")) <= 150: records.append(old)
    # A failed bill is not retried with another full page crawl in this run.
    # This keeps the batch bounded and lets the next scheduled run try again.
    for bill, old, error in deferred:
        if not old or not (70 <= word_count(old.get("summary")) <= 150):
            print(f"No valid summary available for {bill.get('identifier', 'Unknown')}; failing safely.", file=sys.stderr)
            return 1
    write_output(records, args.output); update_feed(Path("Lariat-real/feed.html"))
    print(f"Saved {len(records)} summaries; unresolved failures: {failures}"); return 1 if failures else 0


def write_output(records: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True); temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"); temp.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(); parser.add_argument("--input", type=Path, default=Path(DEFAULT_INPUT)); parser.add_argument("--output", type=Path, default=Path(DEFAULT_OUTPUT)); parser.add_argument("--model", default=os.getenv("SUMMARIZER_MODEL") or DEFAULT_MODEL); parser.add_argument("--delay", type=float, default=1.0); return parser.parse_args()

if __name__ == "__main__": raise SystemExit(main())
