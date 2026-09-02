#!/usr/bin/env python3
"""Generate Lariat bill summaries from official Texas bill text when available."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

DEFAULT_INPUT = "texas_bills.json"
DEFAULT_OUTPUT = "Lariat-real/texas_bill_summaries.json"
TEXT_CACHE_DIR = Path(os.getenv("LARIAT_TEXT_CACHE_DIR", ".cache/lariat-bill-text"))
REQUESTED_MODEL: str | None = None
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
MIN_SUMMARY_WORDS = 50
MAX_SUMMARY_WORDS = 150
FEED_META_PATTERN = re.compile(r'(<meta name="lariat-data-updated" content=")[^"]*(")')

INDUSTRIES = ["Energy & Utilities", "Government & Municipal Operations", "Emergency & Public Safety", "Real Estate & Land Use", "Insurance & Financial Services", "N/A"]
INDUSTRY_LIST = ", ".join(f'"{item}"' for item in INDUSTRIES)
STATUS_VALUES = "alive, active, pending, passed, signed, enacted, adopted, failed, did not pass, died, replaced"
SCRIPT_OWNED_FIELDS = ("id", "identifier", "session", "updated_at", "source_url")

SYSTEM_PROMPT = f"""You are a neutral Texas legislative analyst. Use ONLY the supplied official bill text and record metadata. Never invent facts. Return one JSON object only, with no markdown or commentary, containing exactly one key: summary. The summary MUST be one neutral paragraph of 50-150 words, counting whitespace-separated words. Explain the bill's purpose, operative changes, affected parties, important requirements, exceptions, funding, effective date, and recorded legislative status when present. If full text is incomplete, say so explicitly and avoid guessing. For ceremonial resolutions, explain that they have no legal effect. This is informational, not legal advice."""

SUMMARY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "One neutral paragraph of 50-150 words."},
    },
    "required": ["summary"],
    "additionalProperties": False,
}

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


def capitol_text_url(bill: dict[str, Any]) -> str | None:
    """Construct direct bill text page URL."""
    session = str(bill.get("session") or "").strip()
    identifier = str(bill.get("identifier") or "").strip()
    if not session or not identifier:
        return None
    return f"https://capitol.texas.gov/BillLookup/Text.aspx?LegSess={session}&Bill={identifier.replace(' ', '')}"


def capitol_pdf_urls(bill: dict[str, Any]) -> list[str]:
    """Construct direct PDF bill text URLs from the known tlodocs pattern.
    Returns enrolled, engrossed, introduced, and substitute variants."""
    session = str(bill.get("session") or "").strip()
    identifier = str(bill.get("identifier") or "").strip()
    if not session or not identifier:
        return []
    parts = identifier.split()
    if len(parts) != 2:
        return []
    bill_type, bill_num = parts[0].upper(), parts[1]
    padded = f"{bill_type}{bill_num.zfill(4)}"
    padded5 = f"{bill_type}{bill_num.zfill(5)}"
    base = f"https://capitol.texas.gov/tlodocs/{session}/billtext/pdf/{padded}"
    base5 = f"https://capitol.texas.gov/tlodocs/{session}/billtext/pdf/{padded5}"
    # Try engrossed first (most complete), then introduced, then substitute
    # Try both 4-digit and 5-digit zero padding
    # HTML versions are easier to parse (no pdftotext needed)
    urls = []
    html_base = base.replace('/billtext/pdf/', '/billtext/html/')
    html_base5 = base5.replace('/billtext/pdf/', '/billtext/html/')
    for hb, pb in ((html_base, base), (html_base5, base5)):
        for ver in ('E', 'I', 'S', 'H'):
            urls.append(f"{hb}{ver}.htm")
            urls.append(f"{pb}{ver}.pdf")
    return urls


def ftp_bill_url(bill: dict[str, Any]) -> str | None:
    """Construct FTP URL for bill text if possible."""
    session = str(bill.get("session") or "").strip()
    identifier = str(bill.get("identifier") or "").strip()
    if not session or not identifier:
        return None
    # Parse bill type and number (e.g., "SB 1" -> type="SB", number="1")
    parts = identifier.split()
    if len(parts) != 2:
        return None
    bill_type, bill_num = parts[0].upper(), parts[1]
    # Map bill types to FTP directories
    type_map = {"SB": "senate/bill", "HB": "house/bill", "SR": "senate/resolution",
                "HR": "house/resolution", "SJR": "senate/jointresolution",
                "HJR": "house/jointresolution"}
    ftp_type = type_map.get(bill_type)
    if not ftp_type:
        return None
    # Pad bill number to 4 digits
    padded_num = bill_num.zfill(4)
    return f"ftp://ftp.legis.state.tx.us/bills/{ftp_type}/{session}/{padded_num}/bill.doc"


def fetch_url_bytes(url: str, *, attempts: int = 3, timeout: int = 60) -> bytes:
    """Fetch an official page with bounded retries for transient failures."""
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        request = Request(url, headers={
            "User-Agent": "Lariat bill research bot; contact via repository",
            "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
            "Connection": "close",
        })
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.read()
        except (HTTPError, URLError, TimeoutError, ConnectionError) as exc:
            last_error = exc
            if isinstance(exc, HTTPError) and exc.code not in {408, 425, 429} and exc.code < 500:
                break
            if attempt < attempts:
                time.sleep(min(5 * attempt, 20))
    raise RuntimeError(f"official page request failed after {attempts} attempts: {last_error}")


def fetch_html(url: str, *, attempts: int = 2, timeout: int = 30) -> str:
    return fetch_url_bytes(url, attempts=attempts, timeout=timeout).decode("utf-8", errors="replace")


def official_document_urls(value: Any) -> list[str]:
    """Collect official Texas document URLs from nested Open States fields."""
    found: list[str] = []
    if isinstance(value, dict):
        for child in value.values():
            found.extend(official_document_urls(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(official_document_urls(child))
    elif isinstance(value, str) and value.startswith("https://capitol.texas.gov/"):
        found.append(value)
    return list(dict.fromkeys(found))


def cache_file_for(bill: dict[str, Any]) -> Path:
    stable = str(bill.get("id") or f"{bill.get('session', '')}-{bill.get('identifier', '')}")
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", stable)
    return TEXT_CACHE_DIR / f"{safe}.json"


def source_marker(bill: dict[str, Any]) -> str:
    return str(bill.get("updated_at") or bill.get("latest_action_date") or "")


def save_text_cache(bill: dict[str, Any], text: str, url: str) -> None:
    path = cache_file_for(bill); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "url": url,
        "text": text,
        "source_marker": source_marker(bill),
        "cached_at": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False), encoding="utf-8")


def load_text_cache(bill: dict[str, Any]) -> tuple[str, str] | None:
    try:
        parsed = json.loads(cache_file_for(bill).read_text(encoding="utf-8"))
        if not isinstance(parsed, dict) or not isinstance(parsed.get("text"), str) or not isinstance(parsed.get("url"), str):
            return None
        cached_marker = str(parsed.get("source_marker") or "")
        if source_marker(bill) and cached_marker and cached_marker != source_marker(bill):
            return None
        if usable_bill_text(parsed["text"], str(bill.get("identifier") or "")):
            return parsed["text"], parsed["url"]
    except (OSError, json.JSONDecodeError):
        pass
    return None


def extract_document_text(url: str) -> str:
    """Download an HTML or PDF bill document and extract visible text."""
    raw = fetch_url_bytes(url, attempts=3, timeout=60)
    if url.lower().split("?", 1)[0].endswith(".pdf") or raw.startswith(b"%PDF"):
        if not shutil.which("pdftotext"):
            raise RuntimeError("official document is a PDF but pdftotext is unavailable")
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "bill.pdf"
            output_path = Path(directory) / "bill.txt"
            input_path.write_bytes(raw)
            result = subprocess.run(
                ["pdftotext", "-layout", str(input_path), str(output_path)],
                capture_output=True, text=True, timeout=45,
            )
            if result.returncode != 0 or not output_path.exists():
                raise RuntimeError("could not extract text from official PDF")
            return output_path.read_text(encoding="utf-8", errors="replace").strip()
    extractor = TextExtractor(); extractor.feed(raw.decode("utf-8", errors="replace"))
    text = extractor.text()
    # Detect if we got a website interface page instead of actual bill text
    lowered = text.lower()
    interface_signals = ["search for a bill", "bill lookup", "bill text", "session information",
                        "committee information", "member information", "capitol.texas.gov"]
    if sum(1 for signal in interface_signals if signal in lowered) >= 2:
        raise RuntimeError("website returned interface page instead of bill text")
    return text


def usable_bill_text(text: str, identifier: str) -> bool:
    """Check if extracted text is actual bill content, not just the website interface."""
    compact_identifier = identifier.lower().replace(" ", "")
    lowered = text.lower().replace(" ", "")
    word_count = len(text.split())
    if word_count < 100:
        return False
    # Reject if the text is mostly website interface elements
    interface_indicators = [
        "search for a bill", "bill lookup", "bill text", "legislative reference library",
        "session information", "committee information", "member information",
        "house of representatives", "senate of texas", "capitol.texas.gov",
        "javascript", "function()", "var ", "document.", "window.",
        "css", "style=", "class=", "<script", "<style", "<nav", "<header", "<footer",
        "menu", "navigation", "sidebar", "login", "sign in", "register",
        "about us", "contact us", "privacy policy", "terms of use",
    ]
    interface_matches = sum(1 for indicator in interface_indicators if indicator in lowered)
    if interface_matches >= 3:
        return False
    # Must have bill-specific content
    has_identifier = compact_identifier in lowered
    has_relating = "relatingto" in lowered
    has_resolution = "resolution" in lowered
    has_bill_content = has_identifier or has_relating or has_resolution
    # Additional check: look for typical bill text patterns
    # Check against lowered-with-spaces (not compact) since patterns contain spaces
    lowered_with_spaces = text.lower()
    bill_patterns = ["section ", "sec. ", "amended by", "enacted by", "the legislature",
                    "notwithstanding", "hereunder", "thereof", "pursuant to",
                    "effective date", "takes effect", "this act"]
    pattern_matches = sum(1 for pattern in bill_patterns if pattern in lowered_with_spaces)
    return has_bill_content and pattern_matches >= 1


def fetch_bill_text(bill: dict[str, Any]) -> tuple[str, str]:
    """Prefer direct official document links, then use the history page."""
    identifier = re.sub(r"\s+", "", str(bill.get("identifier") or "")).lower()
    direct_candidates = []
    for url in official_document_urls(bill):
        lowered = url.lower()
        score = 0
        for word, points in (("enrolled", 60), ("engrossed", 50), ("substitute", 40), ("introduced", 30), ("billtext", 20), ("html", 10), ("pdf", 5)):
            if word in lowered: score += points
        direct_candidates.append((score, url))
    cached = load_text_cache(bill)
    if cached:
        print(f"{bill.get('identifier', 'Unknown')}: using cached official bill text", file=sys.stderr)
        return cached

    for _, url in sorted(direct_candidates, reverse=True)[:6]:
        try:
            text = extract_document_text(url)
            if usable_bill_text(text, identifier):
                save_text_cache(bill, text, url)
                return text, url
        except (HTTPError, URLError, TimeoutError, ConnectionError, RuntimeError):
            continue

    # Try direct PDF URLs from tlodocs (most reliable source for bill text)
    for pdf_url in capitol_pdf_urls(bill):
        try:
            text = extract_document_text(pdf_url)
            if usable_bill_text(text, identifier):
                save_text_cache(bill, text, pdf_url)
                return text, pdf_url
        except (HTTPError, URLError, TimeoutError, ConnectionError, RuntimeError):
            continue

    # Try direct Text.aspx page
    text_page_url = capitol_text_url(bill)
    if text_page_url:
        try:
            text = extract_document_text(text_page_url)
            if usable_bill_text(text, identifier):
                save_text_cache(bill, text, text_page_url)
                return text, text_page_url
        except (HTTPError, URLError, TimeoutError, ConnectionError, RuntimeError):
            pass

    # Try FTP site (more reliable than the website)
    ftp_url = ftp_bill_url(bill)
    if ftp_url:
        try:
            text = extract_document_text(ftp_url)
            if usable_bill_text(text, identifier):
                save_text_cache(bill, text, ftp_url)
                return text, ftp_url
        except (HTTPError, URLError, TimeoutError, ConnectionError, RuntimeError):
            pass

    history_url = capitol_url(bill)
    html = fetch_html(history_url); parser = LinkExtractor(); parser.feed(html)
    candidates: list[tuple[int, str]] = []
    for label, href in parser.links:
        absolute = urljoin(history_url, href)
        link_text = f"{label} {href}".lower()
        if not absolute.startswith("https://capitol.texas.gov/"): continue
        if any(word in link_text for word in ("text", "html", "pdf", "introduced", "engrossed", "enrolled", "substitute")):
            score = 0
            for word, points in (("enrolled", 60), ("engrossed", 50), ("substitute", 40), ("introduced", 30), ("text", 10), ("pdf", 5)):
                if word in link_text: score += points
            candidates.append((score, absolute))
    for _, url in sorted(candidates, reverse=True)[:4]:
        try:
            text = extract_document_text(url)
            if usable_bill_text(text, identifier):
                save_text_cache(bill, text, url)
                return text, url
        except (HTTPError, URLError, TimeoutError, ConnectionError, RuntimeError):
            continue
    raise RuntimeError("no usable official bill-text document found")


def bill_context(bill: dict[str, Any], text: str, text_url: str) -> str:
    org = bill.get("from_organization"); chamber = str(org.get("name") or "") if isinstance(org, dict) else ""
    subjects = "; ".join(str(x) for x in (bill.get("subject") or []))
    metadata = "\n".join(f"{key}: {value}" for key, value in [("identifier", bill.get("identifier")), ("title", bill.get("title")), ("chamber", chamber), ("session", bill.get("session")), ("subjects", subjects), ("latest_action_date", bill.get("latest_action_date")), ("latest_action_description", bill.get("latest_action_description")), ("latest_passage_date", bill.get("latest_passage_date")), ("official_text_url", text_url)] if value)
    # Keep both the opening provisions and the ending provisions (where
    # effective dates and transition rules commonly appear) within modest
    # context limits for free models.
    if len(text) > 60000:
        text = text[:48000] + "\n\n[Middle of document omitted for context limits]\n\n" + text[-12000:]
    return f"RECORD METADATA:\n{metadata}\n\nOFFICIAL BILL TEXT:\n{text}"


def choose_openrouter_models(api_key: str, requested: str | None) -> list[str]:
    request = Request(
        OPENROUTER_MODELS_URL,
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=30) as response:
            parsed = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"OpenRouter model catalog HTTP {exc.code}: {body}") from exc
    except (URLError, TimeoutError, ConnectionError) as exc:
        raise RuntimeError(f"OpenRouter model catalog request failed: {exc}") from exc
    models = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(models, list):
        raise RuntimeError(f"OpenRouter model catalog returned no model list: {str(parsed)[:300]}")
    available = {
        str(item.get("id")): item for item in models
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    free_models = []
    for model_id, item in available.items():
        pricing = item.get("pricing") if isinstance(item, dict) else None
        if not (isinstance(pricing, dict) and pricing.get("prompt") == "0" and pricing.get("completion") == "0"):
            continue
        lowered_id = model_id.lower()
        # These model families are poor fits for a strict text-only JSON task.
        if any(term in lowered_id for term in ("reasoning", "omni", "audio", "vision", "content-safety")):
            continue
        free_models.append((model_id, item))
    # Prefer models that advertise response-format support, then ordinary
    # instruction/chat models. If the catalog omits that field, keep the model
    # eligible and let the API response decide.
    preferred_terms = ("instruct", "chat", "qwen", "llama", "mistral", "gemma")
    free_models.sort(key=lambda pair: (
        not any(parameter in (pair[1].get("supported_parameters") or []) for parameter in ("response_format", "structured_outputs")),
        not any(term in pair[0].lower() for term in preferred_terms),
        pair[0],
    ))
    ordered = [model_id for model_id, _ in free_models]
    if requested and requested in ordered:
        ordered = [requested] + [model_id for model_id in ordered if model_id != requested]
    elif requested:
        print(f"Requested model '{requested}' is unavailable; selecting available free models.", file=sys.stderr)
    if not ordered:
        raise RuntimeError("OpenRouter returned no free models")
    # Keep the fallback chain bounded so a batch cannot spend its entire
    # runtime probing every model in the catalog.
    ordered = ordered[:8]
    print(f"OpenRouter model fallback chain: {', '.join(ordered)}")
    return ordered


class ModelCapacityError(RuntimeError):
    """The selected model cannot accept another request right now."""


def is_capacity_error(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in (
        "rate limit", "quota", "resourceexhausted", "request limit", "worker local", "temporarily unavailable", "overloaded", "capacity", "timeout", "timed out", "code': 504", '"code": 504',
    ))


def call_ai(context: str, model: str, api_key: str, *, system_prompt: str = SYSTEM_PROMPT) -> str:
    """Call one OpenRouter model with structured JSON output."""
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": context},
        ],
        # json_object is supported by more free models than strict JSON Schema;
        # the script still validates the parsed object and word count locally.
        "response_format": {"type": "json_object"},
        "plugins": [{"id": "response-healing"}],
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
        message = f"OpenRouter API HTTP {exc.code}: {body}"
        if exc.code in {400, 429, 502, 503, 504} or is_capacity_error(message):
            raise ModelCapacityError(message) from exc
        raise RuntimeError(message) from exc
    except (URLError, TimeoutError, ConnectionError) as exc:
        raise ModelCapacityError(f"OpenRouter request failed: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("OpenRouter returned an unexpected response shape")
    choices = parsed.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        message = str(parsed)[:500]
        if is_capacity_error(message):
            raise ModelCapacityError(f"OpenRouter model capacity error: {message}")
        raise RuntimeError(f"OpenRouter returned no choices: {message}")
    message = choices[0].get("message")
    output = message.get("content") if isinstance(message, dict) else None
    if isinstance(output, list):
        output = "".join(
            str(part.get("text", "")) for part in output
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    if not isinstance(output, str) or not output.strip():
        raise ModelCapacityError("OpenRouter returned no text content; switching models")
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


EXPANSION_PROMPT = f"""You are revising a Texas legislative bill summary. Use ONLY the supplied official bill text, metadata, and draft. Return one JSON object containing exactly one key: summary. Replace the draft with one neutral paragraph between {MIN_SUMMARY_WORDS} and {MAX_SUMMARY_WORDS} words. Add useful facts from the official text such as operative changes, affected parties, requirements, exceptions, funding, or effective dates when present. Do not pad with repetition or invent facts. Return JSON only."""


def generate_ai_record(context: str, models: list[str], start_index: int, api_key: str) -> tuple[dict[str, Any], int]:
    """Try each model once, including one bounded expansion request."""
    last_error: Exception | None = None
    for index in range(start_index, len(models)):
        model = models[index]
        try:
            output = extract_json(call_ai(context, model, api_key))
            if output is None or not isinstance(output.get("summary"), str):
                raise ValueError("AI output was not a valid summary object")
            count = word_count(output.get("summary"))
            if MIN_SUMMARY_WORDS <= count <= MAX_SUMMARY_WORDS:
                return output, index
            revision_context = f"{context}\n\nDRAFT JSON TO REVISE:\n{json.dumps(output, ensure_ascii=False)}\n\nThe draft summary contains {count} words. Rewrite it to exactly {MIN_SUMMARY_WORDS}-{MAX_SUMMARY_WORDS} words."
            revised = extract_json(call_ai(revision_context, model, api_key, system_prompt=EXPANSION_PROMPT))
            if revised is None or not isinstance(revised.get("summary"), str):
                raise ValueError("AI expansion output was not a valid summary object")
            revised_count = word_count(revised.get("summary"))
            if not MIN_SUMMARY_WORDS <= revised_count <= MAX_SUMMARY_WORDS:
                raise ValueError(f"summary has {revised_count} words after expansion; expected {MIN_SUMMARY_WORDS}-{MAX_SUMMARY_WORDS}")
            return revised, index
        except (ModelCapacityError, RuntimeError, ValueError) as exc:
            last_error = exc
            if index + 1 < len(models):
                print(f"Model attempt failed; switching from {model} to {models[index + 1]}.", file=sys.stderr)
    raise RuntimeError(f"All OpenRouter models failed to produce a valid summary: {last_error}") from last_error


def fallback_display_fields(bill: dict[str, Any], old: dict[str, Any] | None) -> dict[str, str]:
    """Provide non-AI display fields without inventing legislative details."""
    identifier = str(bill.get("identifier") or "Unknown")
    bill_title = str(bill.get("title") or identifier).strip().rstrip(".")
    subjects = [str(subject).strip() for subject in (bill.get("subject") or []) if str(subject).strip()]
    classification = {str(value).lower() for value in (bill.get("classification") or [])}
    ceremonial = bool(classification.intersection({"resolution", "memorial", "congratulatory"}))
    if old:
        fields = {key: str(old.get(key) or "").strip() for key in (
            "title", "affects", "changes", "business_impact", "impact_level",
            "industry", "specific_industry", "status", "suggested_action",
        )}
    else:
        fields = {}
    fields["title"] = fields.get("title") or bill_title
    fields["affects"] = fields.get("affects") or ("N/A - ceremonial resolution" if ceremonial else ", ".join(subjects[:3]) or "Affected parties identified in the official text")
    fields["changes"] = fields.get("changes") or ("N/A - no substantive policy change" if ceremonial else f"See the official text for changes proposed by {identifier}.")
    fields["business_impact"] = fields.get("business_impact") or ("N/A - no business impact" if ceremonial else "Practical effects should be determined from the official text and the bill's current status.")
    fields["impact_level"] = fields.get("impact_level") or "Low"
    fields["industry"] = fields.get("industry") if fields.get("industry") in INDUSTRIES else "N/A"
    fields["specific_industry"] = fields.get("specific_industry") or "N/A"
    fields["status"] = fields.get("status") or "pending"
    fields["suggested_action"] = fields.get("suggested_action") or "Review the official bill text and monitor the recorded legislative status."
    return fields


def normalize(record: dict[str, Any], bill: dict[str, Any], text_url: str | None, text_hash: str | None, old: dict[str, Any] | None = None) -> dict[str, Any]:
    fields = fallback_display_fields(bill, old)
    output = {**fields, "summary": str(record.get("summary") or "").strip()}
    output.update({
        "id": str(bill.get("id") or ""),
        "identifier": str(bill.get("identifier") or "Unknown"),
        "session": str(bill.get("session") or ""),
        "updated_at": date.today().isoformat(),
        "source_url": capitol_url(bill),
    })
    if not MIN_SUMMARY_WORDS <= word_count(output["summary"]) <= MAX_SUMMARY_WORDS:
        raise ValueError(f"summary has {word_count(output['summary'])} words; expected {MIN_SUMMARY_WORDS}-{MAX_SUMMARY_WORDS}")
    if text_url: output["bill_text_source"] = text_url
    if text_hash:
        output["bill_text_hash"] = text_hash
        output["summary_word_count"] = word_count(output["summary"])
        output["summary_source"] = "official bill text"
    return output


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
    models = choose_openrouter_models(api_key, args.model)
    active_model_index = 0
    existing: dict[str, dict[str, Any]] = {}
    if args.output.exists():
        try: existing = {str(x.get("identifier", "")).lower(): x for x in json.loads(args.output.read_text()) if isinstance(x, dict)}
        except (OSError, json.JSONDecodeError): pass
    records: list[dict[str, Any]] = []; failures = 0; deferred: list[tuple[dict[str, Any], dict[str, Any] | None, str]] = []
    for index, bill in enumerate(bills, 1):
        identifier = str(bill.get("identifier") or "Unknown"); old = existing.get(identifier.lower())
        try:
            text, text_url = fetch_bill_text(bill); digest = hashlib.sha256(text.encode()).hexdigest()
            if old and old.get("bill_text_hash") == digest and MIN_SUMMARY_WORDS <= word_count(old.get("summary")) <= MAX_SUMMARY_WORDS:
                records.append(old); print(f"[{index}/{len(bills)}] {identifier} -> cached"); continue
            output, active_model_index = generate_ai_record(bill_context(bill, text, text_url), models, active_model_index, api_key)
            records.append(normalize(output, bill, text_url, digest, old)); print(f"[{index}/{len(bills)}] {identifier} -> AI ({models[active_model_index]})")
            time.sleep(args.delay)
        except Exception as exc:
            failures += 1; deferred.append((bill, old, str(exc))); print(f"[{index}/{len(bills)}] {identifier} -> deferred: {exc}", file=sys.stderr)
            if old and MIN_SUMMARY_WORDS <= word_count(old.get("summary")) <= MAX_SUMMARY_WORDS: records.append(old)
    # Merge with any existing bills that were not in this run's input.
    # This preserves old summaries when the workflow fetches a different subset of bills.
    processed_identifiers = {str(r.get("identifier", "")).lower() for r in records}
    for identifier, old_record in existing.items():
        if identifier not in processed_identifiers and MIN_SUMMARY_WORDS <= word_count(old_record.get("summary")) <= MAX_SUMMARY_WORDS:
            records.append(old_record)
    # A failed bill is not retried with another full page crawl in this run.
    # This keeps the batch bounded and lets the next scheduled run try again.
    unresolved = []
    for bill, old, error in deferred:
        if not old or not (MIN_SUMMARY_WORDS <= word_count(old.get("summary")) <= MAX_SUMMARY_WORDS):
            unresolved.append(bill.get('identifier', 'Unknown'))
            print(f"No valid summary available for {bill.get('identifier', 'Unknown')}; failing safely.", file=sys.stderr)
    if unresolved and not args.write_partial:
        print(f"{len(unresolved)} bill(s) could not be summarized: {', '.join(unresolved)}", file=sys.stderr)
        print("Use --write-partial to publish successful bills anyway.", file=sys.stderr)
        return 1
    if unresolved:
        print(f"Warning: publishing {len(records)} summaries; {len(unresolved)} bill(s) unresolved: {', '.join(unresolved)}", file=sys.stderr)
    write_output(records, args.output); update_feed(Path("Lariat-real/feed.html"))
    print(f"Saved {len(records)} summaries; unresolved failures: {failures}")
    if failures and not args.write_partial:
        return 1
    return 0 if records else 1


def write_output(records: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True); temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"); temp.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(); parser.add_argument("--input", type=Path, default=Path(DEFAULT_INPUT)); parser.add_argument("--output", type=Path, default=Path(DEFAULT_OUTPUT)); parser.add_argument("--model", default=os.getenv("SUMMARIZER_MODEL") or REQUESTED_MODEL); parser.add_argument("--delay", type=float, default=5.0); parser.add_argument("--write-partial", action="store_true", help="Write output even when some bills fail")
    return parser.parse_args()

if __name__ == "__main__": raise SystemExit(main())
