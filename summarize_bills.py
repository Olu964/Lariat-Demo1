#!/usr/bin/env python3
"""Turn raw Open States bill records into the Lariat summary JSON.

Reads the aggregate file produced by fetch_texas_bills.py (default
texas_bills.json) and writes Lariat-real/texas_bill_summaries.json — the file
the Bill feed and the backend's industry list read.

Summaries are written by Cloudflare Workers AI when CLOUDFLARE_ACCOUNT_ID and
CLOUDFLARE_API_TOKEN are set (see AUTOMATION_SETUP.md). Without them the script
runs in MOCK mode and generates deterministic placeholder summaries, so the
whole pipeline works end-to-end with zero keys and you can preview the format.

Usage:
    python3 summarize_bills.py [--input texas_bills.json]
                               [--output Lariat-real/texas_bill_summaries.json]
                               [--model @cf/meta/llama-3.3-70b-instruct-fp8-fast]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_INPUT = "texas_bills.json"
DEFAULT_OUTPUT = "Lariat-real/texas_bill_summaries.json"
DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
# If the daily free neuron quota runs out, switch the model to the smaller one:
#   --model @cf/meta/llama-3.1-8b-instruct-fp8-fast
FEED_PATH = "Lariat-real/feed.html"
FEED_META_PATTERN = re.compile(r'(<meta name="lariat-data-updated" content=")[^"]*(")')

# The fixed industry taxonomy the model must choose from. Keeping the list
# small means the industry dropdown on the feed stays tidy.
INDUSTRIES = [
    "Energy & Utilities",
    "Government & Municipal Operations",
    "Emergency & Public Safety",
    "Real Estate & Land Use",
    "Health & Human Services",
    "Education",
    "Insurance & Financial Services",
    "Transportation & Infrastructure",
    "Agriculture & Natural Resources",
    "Technology & Communications",
    "Labor & Employment",
    "Criminal Justice & Law",
    "Other",
    "N/A",
]
INDUSTRY_LIST = ", ".join(f'"{industry}"' for industry in INDUSTRIES)

STATUS_VALUES = (
    "alive, active, pending, passed, signed, enacted, adopted, "
    "failed, did not pass, died, replaced"
)

# Fields the script fills from the record itself (never from the model), so
# identifiers and links are always correct even if the model drifts.
SCRIPT_OWNED_FIELDS = ("id", "identifier", "session", "updated_at", "source_url")

SYSTEM_PROMPT = f"""You are a Texas legislative analyst producing business-ready bill summaries for Lariat, a bill-intelligence feed.

You will receive one Open States bill record (identifier, title, chamber, subjects, action dates, latest action description). The record may be thin — Texas records often have no abstract. Work only from what the record contains. Never invent vote counts, dollar amounts, sponsors, deadlines, or session history that are not in the record.

Return ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
- "title": a short friendly title (2-8 words), e.g. "Voter-approval tax rate reduction". Never use the literal "Relating to ..." phrasing.
- "summary": 3-5 sentences, plain business-ready language. Describe what the bill does per the record, its current recorded status, and anything notable. If the record is thin, say so honestly (e.g. "the record shows the bill was filed with no further action recorded").
- "affects": who/what it affects (agencies, industries, groups). Use "N/A — ..." for ceremonial resolutions.
- "changes": what the bill changes or does in one or two sentences.
- "business_impact": the practical impact on businesses, in one or two sentences. Use "N/A — no business impact" when none.
- "impact_level": exactly one of "High", "Moderate", "Low".
- "industry": exactly one of {INDUSTRY_LIST}. Use "N/A" only for ceremonial resolutions.
- "specific_industry": a more specific sub-category (2-5 words), or "N/A".
- "status": exactly one of {STATUS_VALUES}. Use "signed"/"enacted" only if the record shows signing/effective language; "passed" only if a passage date or enrolled action appears; otherwise "pending" and note in the summary that final status must be verified.
- "suggested_action": one practical paragraph (2-4 sentences) advising a business audience on what to do or watch, tailored to the bill. If the bill needs no action, say so.

For ceremonial resolutions (congratulatory, honorary, memorial): title as-is, summary noting it is a ceremonial resolution with no legal effect, "affects"/"changes"/"business_impact" = "N/A — ...", "impact_level" = "Low", "industry" = "N/A", "suggested_action" = a short no-action-needed line.

This is a starting point for human review, not legal advice."""


def load_dotenv(path: Path) -> None:
    """Load simple KEY=VALUE entries without printing secret values."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        os.environ.setdefault(key, value)


def read_bills(path: Path) -> list[dict[str, Any]]:
    """Read the aggregate fetch output; accept either shape Open States or
    the wrapper {"bills": [...]} produced by fetch_texas_bills.py."""
    if not path.exists():
        raise SystemExit(f"Input file not found: {path} (run fetch_texas_bills.py first)")
    parsed = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(parsed, list):
        bills = parsed
    elif isinstance(parsed, dict) and isinstance(parsed.get("bills"), list):
        bills = parsed["bills"]
    else:
        raise SystemExit(f"Unexpected JSON shape in {path}: expected an array or {{bills: [...]}}")
    return [bill for bill in bills if isinstance(bill, dict)]


def bill_context(bill: dict[str, Any]) -> str:
    """Render the record as a compact key/value block for the model prompt."""
    org = bill.get("from_organization")
    chamber = str(org.get("name") or "") if isinstance(org, dict) else ""
    classification = ", ".join(str(item) for item in (bill.get("classification") or []))
    subjects = "; ".join(str(item) for item in (bill.get("subject") or []))
    fields = [
        ("identifier", bill.get("identifier") or ""),
        ("title", bill.get("title") or ""),
        ("classification", classification),
        ("chamber", chamber),
        ("session", bill.get("session") or ""),
        ("subjects", subjects or "(none)"),
        ("first_action_date", bill.get("first_action_date") or ""),
        ("latest_action_date", bill.get("latest_action_date") or ""),
        ("latest_action_description", bill.get("latest_action_description") or ""),
        ("latest_passage_date", bill.get("latest_passage_date") or ""),
        ("abstracts", "; ".join(str(item) for item in (bill.get("abstracts") or [])) or "(none)"),
        ("openstates_url", bill.get("openstates_url") or ""),
    ]
    return "\n".join(f"{key}: {value}" for key, value in fields if value)


def call_cloudflare_ai(context: str, model: str, account_id: str, api_token: str) -> str:
    """Call Workers AI and return the model's raw text. Raises on failure."""
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}"
    payload = json.dumps({
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": context},
        ],
        "temperature": 0.2,
        "max_tokens": 900,
    }).encode("utf-8")
    request = Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urlopen(request, timeout=60) as response:
        parsed = json.loads(response.read().decode("utf-8"))
    if not isinstance(parsed, dict) or not parsed.get("success"):
        errors = parsed.get("errors") if isinstance(parsed, dict) else None
        detail = "; ".join(str(error) for error in errors) if errors else "unknown error"
        raise RuntimeError(f"Cloudflare API error: {detail}")
    result = parsed.get("result")
    if isinstance(result, dict) and isinstance(result.get("response"), str):
        return result["response"]
    raise RuntimeError("Cloudflare API returned an unexpected response shape")


def extract_json(text: str) -> dict[str, Any] | None:
    """Extract a JSON object from model output, tolerating code fences and prose."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def is_ceremonial(bill: dict[str, Any]) -> bool:
    text = " ".join([
        " ".join(str(item) for item in (bill.get("classification") or [])),
        " ".join(str(item) for item in (bill.get("subject") or [])),
        str(bill.get("title") or ""),
    ]).lower()
    return any(
        keyword in text
        for keyword in ("congratulatory", "honorary", "memorial", "recognizing", "in memory of", "honoring")
    )


# --- Mock mode: deterministic placeholders so the pipeline runs with no key ---

MOCK_INDUSTRY_RULES = [
    ("Emergency & Public Safety", ("emergency", "disaster", "flood", "siren", "warning", "rescue", "preparedness", "first respond")),
    ("Real Estate & Land Use", ("deed", "title", "real property", "impervious", "zoning", "land use", "subdivision", "property")),
    ("Energy & Utilities", ("groundwater", "water", "energy", "oil", "gas", "utility", "electric", "pipeline")),
    ("Health & Human Services", ("health", "hospital", "medical", "mental")),
    ("Education", ("school", "education", "student", "universit", "curriculum", "teacher")),
    ("Insurance & Financial Services", ("insurance", "bank", "finance", "credit", "lending", "loan")),
    ("Transportation & Infrastructure", ("highway", "road", "transport", "transit", "vehicle", "driver", "license", "dmv")),
    ("Agriculture & Natural Resources", ("agriculture", "farm", "ranch", "wildlife", "crop")),
    ("Technology & Communications", ("technology", "data", "internet", "cyber", "telecom", "software")),
    ("Labor & Employment", ("labor", "employment", "wage", "worker", "occupational")),
    ("Criminal Justice & Law", ("crime", "criminal", "penalty", "offense", "firearm", "gun", "judge", "court")),
    ("Government & Municipal Operations", ("tax", "budget", "appropriation", "comptroller", "levy", "municipal", "county", "election", "voter")),
]


def mock_summary_record(bill: dict[str, Any], today_iso: str) -> dict[str, Any]:
    identifier = str(bill.get("identifier") or "Unknown")
    raw_title = str(bill.get("title") or "Untitled bill").strip()
    chamber = ""
    org = bill.get("from_organization")
    if isinstance(org, dict):
        chamber = str(org.get("name") or "")
    latest_action = str(bill.get("latest_action_description") or "no action recorded")
    latest_date = str(bill.get("latest_action_date") or "")
    first_date = str(bill.get("first_action_date") or "")
    subjects = "; ".join(str(item) for item in (bill.get("subject") or []))

    friendly = re.sub(r"^relating to\s+", "", raw_title, flags=re.IGNORECASE).strip().rstrip(".")
    friendly = friendly[:1].upper() + friendly[1:] if friendly else raw_title
    ceremonial = is_ceremonial(bill)

    if ceremonial:
        kind = "ceremonial resolution" if "resolution" in " ".join(str(item) for item in (bill.get("classification") or [])).lower() else "resolution"
        summary = (f"Texas {identifier} is a {kind} with no statutory or regulatory content. "
                   f"It was filed on {first_date} and carries no legal obligations. "
                   "This is an automated placeholder summary — see the Verify link for the official record.")
        affects = "N/A — ceremonial resolution"
        changes = "N/A — no substantive policy change"
        business_impact = "N/A — no business impact"
        industry = "N/A"
        specific = "N/A"
        impact = "Low"
        status = "passed" if latest_date else "pending"
        suggested = "No action needed — this resolution carries no compliance, funding, or regulatory implications."
    else:
        status = "signed" if re.search(r"signed|effective immediately", latest_action, re.IGNORECASE) else (
            "passed" if bill.get("latest_passage_date") or re.search(r"enrolled", latest_action, re.IGNORECASE) else "pending")
        # Strip the parenthetical topic codes (e.g. "(I0211)") Open States
        # appends to subject names so keyword matching is not confused by them.
        lowered = re.sub(r"\s*\([^)]*\)", "", f"{raw_title} {subjects}").lower()
        industry = "Other"
        for candidate, keywords in MOCK_INDUSTRY_RULES:
            if any(keyword in lowered for keyword in keywords):
                industry = candidate
                break
        if industry == "Other":
            industry = "Government & Municipal Operations"
        specific = "General"
        impact = "Moderate" if re.search(r"\$\s?\d|million|billion|appropriat", lowered) else "Low"
        summary = (
            f"Texas {identifier} — {friendly}. Filed in the {chamber or 'legislature'} on {first_date}; "
            f"latest recorded action: {latest_action} ({latest_date}). "
            "The Open States record contains no abstract, so this is a provisional automated summary — "
            "verify the bill's text and current status at the official Texas Legislature website."
        )
        affects = subjects if subjects else "Not yet determined from the record"
        changes = latest_action if latest_action != "no action recorded" else f"Would {friendly.lower()}"
        business_impact = "Assessment pending — this is an automated placeholder summary. Review the bill text for business impact."
        suggested = (
            "Review the bill's text and current status at the official Texas Legislature website "
            "(see the Verify link). This automated summary is a starting point and is not legal advice."
        )

    return {
        "id": str(bill.get("id") or ""),
        "identifier": identifier,
        "session": str(bill.get("session") or ""),
        "title": friendly if not ceremonial else raw_title,
        "summary": summary,
        "affects": affects,
        "changes": changes,
        "business_impact": business_impact,
        "impact_level": impact,
        "industry": industry,
        "specific_industry": specific,
        "status": status,
        "updated_at": today_iso,
        "source_url": capitol_url(bill),
        "suggested_action": suggested,
    }


def capitol_url(bill: dict[str, Any]) -> str:
    session = str(bill.get("session") or "").strip()
    identifier = str(bill.get("identifier") or "").strip()
    if session and identifier:
        return f"https://capitol.texas.gov/BillLookup/History.aspx?LegSess={session}&Bill={identifier.replace(' ', '')}"
    openstates = str(bill.get("openstates_url") or "").strip()
    return openstates or "https://capitol.texas.gov/"


def normalize_record(record: dict[str, Any], bill: dict[str, Any]) -> dict[str, Any]:
    """Fill SCRIPT_OWNED_FIELDS from the record and coerce model fields into
    the shapes the frontend expects, so a model slip cannot break the feed."""
    for field in SCRIPT_OWNED_FIELDS:
        if field == "id":
            record[field] = str(bill.get("id") or "")
        elif field == "identifier":
            record[field] = str(bill.get("identifier") or "Unknown")
        elif field == "session":
            record[field] = str(bill.get("session") or "")
        elif field == "updated_at":
            record[field] = date.today().isoformat()
        elif field == "source_url":
            record[field] = capitol_url(bill)

    record.setdefault("title", str(bill.get("title") or "Untitled bill"))
    for field in ("summary", "affects", "changes", "business_impact", "suggested_action"):
        value = record.get(field)
        record[field] = str(value).strip() if value else "Not provided"
    impact = str(record.get("impact_level") or "").strip().lower()
    record["impact_level"] = {"high": "High", "moderate": "Moderate", "low": "Low"}.get(impact, "Low")
    status = str(record.get("status") or "").strip().lower()
    allowed = {"alive", "active", "pending", "passed", "signed", "enacted", "adopted",
               "failed", "did not pass", "died", "replaced"}
    record["status"] = status if status in allowed else "pending"
    industry = str(record.get("industry") or "").strip()
    record["industry"] = industry if industry else "Other"
    specific = str(record.get("specific_industry") or "").strip()
    record["specific_industry"] = specific if specific else ("N/A" if record["industry"] == "N/A" else "General")
    return record


def update_feed_freshness(feed_path: Path) -> None:
    """Bump the dataset freshness meta tag the feed displays."""
    if not feed_path.exists():
        print(f"  (feed freshness not updated: {feed_path} missing)", file=sys.stderr)
        return
    content = feed_path.read_text(encoding="utf-8")
    month_names = ["January", "February", "March", "April", "May", "June",
                   "July", "August", "September", "October", "November", "December"]
    today = date.today()
    label = f"{month_names[today.month - 1]} {today.day}, {today.year}"
    new_content, count = FEED_META_PATTERN.subn(lambda match: f'{match.group(1)}{label}"', content, count=1)
    if count:
        feed_path.write_text(new_content, encoding="utf-8")
        print(f"  feed freshness set to: {label}")
    else:
        print(f"  (lariat-data-updated meta not found in {feed_path})", file=sys.stderr)


def write_output(records: list[dict[str, Any]], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = output_path.with_suffix(output_path.suffix + ".tmp")
    tmp.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(output_path)


# Marker strings mock summaries carry, used to detect placeholder content so
# curated or AI-written summaries are never overwritten by mock placeholders.
PLACEHOLDER_MARKERS = ("automated placeholder summary", "provisional automated summary")


def is_placeholder(record: dict[str, Any] | None) -> bool:
    if not isinstance(record, dict):
        return True
    text = " ".join(str(record.get(key) or "") for key in ("summary", "business_impact"))
    return not text.strip() or any(marker in text for marker in PLACEHOLDER_MARKERS)


def summarize_one(
    bill: dict[str, Any],
    *,
    model: str,
    account_id: str,
    api_token: str,
    delay: float,
    existing: dict[str, dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], str]:
    """Return (record, mode) where mode is 'ai', 'mock', or 'kept'."""
    context = bill_context(bill)
    if api_token and account_id:
        for attempt in (1, 2):
            try:
                text = call_cloudflare_ai(context, model, account_id, api_token)
                parsed = extract_json(text)
                if parsed is None:
                    raise ValueError("model output did not contain a JSON object")
                record = normalize_record(parsed, bill)
                time.sleep(delay)
                return record, "ai"
            except (HTTPError, URLError, TimeoutError, RuntimeError, ValueError) as exc:
                if attempt == 2:
                    print(f"    AI failed ({exc}); falling back to mock for this bill", file=sys.stderr)
                else:
                    print(f"    retrying after error: {exc}", file=sys.stderr)
                    time.sleep(2 * attempt)
    # Mock mode: never destroy a curated or AI-written summary that already
    # exists for the same bill — keep it instead of writing a placeholder.
    identifier = str(bill.get("identifier") or "").strip().lower()
    if existing and identifier:
        for existing_record in existing.values():
            if str(existing_record.get("identifier") or "").strip().lower() == identifier and not is_placeholder(existing_record):
                return existing_record, "kept"
    return mock_summary_record(bill, date.today().isoformat()), "mock"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path(DEFAULT_INPUT), help=f"Fetch output to read (default: {DEFAULT_INPUT})")
    parser.add_argument("--output", type=Path, default=Path(DEFAULT_OUTPUT), help=f"Summary file to write (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--model", default=os.getenv("SUMMARIZER_MODEL", DEFAULT_MODEL), help="Cloudflare Workers AI model id")
    parser.add_argument("--delay", type=float, default=0.2, help="Seconds to pause between AI calls (default: 0.2)")
    return parser.parse_args()


def main() -> int:
    load_dotenv(Path(__file__).resolve().parent / ".env")
    args = parse_args()

    account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
    api_token = os.getenv("CLOUDFLARE_API_TOKEN", "").strip()
    use_ai = bool(account_id and api_token)
    mode_label = f"Cloudflare AI ({args.model})" if use_ai else "MOCK mode (no Cloudflare token — placeholder summaries)"

    bills = read_bills(args.input)
    if not bills:
        print(f"No bills found in {args.input}", file=sys.stderr)
        return 1
    print(f"Summarizing {len(bills)} bills via {mode_label}")

    existing: dict[str, dict[str, Any]] = {}
    if args.output.exists():
        try:
            existing = {str(record.get("identifier") or "").strip().lower(): record
                        for record in json.loads(args.output.read_text(encoding="utf-8"))
                        if isinstance(record, dict)}
        except (json.JSONDecodeError, OSError):
            existing = {}

    records: list[dict[str, Any]] = []
    for index, bill in enumerate(bills, start=1):
        record, mode = summarize_one(
            bill,
            model=args.model,
            account_id=account_id,
            api_token=api_token,
            delay=args.delay,
            existing=existing,
        )
        records.append(record)
        print(f"  [{index}/{len(bills)}] {record['identifier']} -> {mode}")

    write_output(records, args.output)
    print(f"Saved {len(records)} summaries to {args.output}")
    update_feed_freshness(Path(args.output).resolve().parent / "feed.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
