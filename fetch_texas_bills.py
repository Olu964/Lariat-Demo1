#!/usr/bin/env python3
"""Fetch Texas bills from Open States and save them to a JSON file."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


OPEN_STATES_BILLS_URL = "https://v3.openstates.org/bills"
DEFAULT_JURISDICTION = "ocd-jurisdiction/country:us/state:tx/government"
DEFAULT_OUTPUT = "texas_bills.json"
DEFAULT_BILL_DIR = "texas_bills"
MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024


class NoRedirectHandler(HTTPRedirectHandler):
    """Do not forward API credentials to an unexpected redirect target."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        raise URLError("redirects are not allowed for API requests")


SAFE_OPENER = build_opener(NoRedirectHandler)


def read_bounded_response(response: Any, max_bytes: int) -> bytes:
    """Read an HTTP response without allowing an unbounded allocation."""
    content_length = response.headers.get("Content-Length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise ApiError("API response exceeded the configured size limit")
        except ValueError:
            pass
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(64 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise ApiError("API response exceeded the configured size limit")
        chunks.append(chunk)
    return b"".join(chunks)


class ApiError(RuntimeError):
    """An API request failed in a way that should be shown to the user."""


def load_dotenv(path: Path) -> None:
    """Load simple KEY=VALUE entries without printing or returning secret values."""
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


def request_json(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
    retries: int = 3,
) -> dict[str, Any]:
    """Make a JSON GET request with bounded retries for transient failures."""
    request_headers = {"Accept": "application/json", **(headers or {})}

    for attempt in range(retries):
        request = Request(url, headers=request_headers, method="GET")
        try:
            with SAFE_OPENER.open(request, timeout=timeout) as response:
                parsed = json.loads(read_bounded_response(response, MAX_JSON_RESPONSE_BYTES).decode("utf-8"))
            if not isinstance(parsed, dict):
                raise ApiError("API returned an unexpected JSON shape")
            return parsed
        except HTTPError as exc:
            retryable = exc.code == 429 or 500 <= exc.code < 600
            if not retryable or attempt == retries - 1:
                raise ApiError(f"HTTP {exc.code} from {url.split('?', 1)[0]}") from exc
            retry_after = exc.headers.get("Retry-After")
            try:
                delay = max(1.0, float(retry_after)) if retry_after else 2**attempt
            except ValueError:
                delay = 2**attempt
            time.sleep(min(delay, 30.0))
        except (URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as exc:
            if attempt == retries - 1:
                raise ApiError(f"Request failed for {url.split('?', 1)[0]}") from exc
            time.sleep(min(2**attempt, 8))

    raise ApiError("Request failed after retries")


def fetch_bills(
    api_key: str,
    *,
    jurisdiction: str,
    session: str | None,
    limit: int,
    per_page: int,
    max_pages: int | None,
) -> list[dict[str, Any]]:
    """Fetch up to limit bills, following Open States pagination."""
    bills: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    page = 1

    while len(bills) < limit and (max_pages is None or page <= max_pages):
        params: dict[str, Any] = {
            "jurisdiction": jurisdiction,
            "page": page,
            "per_page": min(per_page, limit - len(bills)),
            "sort": "updated_desc",
            "include": ["abstracts", "documents", "versions"],
        }
        if session:
            params["session"] = session

        data = request_json(
            f"{OPEN_STATES_BILLS_URL}?{urlencode(params, doseq=True)}",
            headers={"X-API-KEY": api_key},
        )
        page_results = data.get("results", [])
        if not isinstance(page_results, list) or not page_results:
            break

        for bill in page_results:
            if not isinstance(bill, dict):
                continue
            bill_id = str(bill.get("id") or bill.get("identifier") or "")
            if bill_id and bill_id not in seen_ids:
                bills.append(bill)
                seen_ids.add(bill_id)
                if len(bills) >= limit:
                    break

        pagination = data.get("pagination", {})
        max_page = pagination.get("max_page") if isinstance(pagination, dict) else None
        if max_page is not None and page >= int(max_page):
            break
        page += 1

    return bills


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", help="Open States session identifier, such as 89")
    parser.add_argument("--limit", type=int, default=15, help="Maximum bills to fetch (default: 15)")
    parser.add_argument("--per-page", type=int, default=20, help="Open States page size (default: 20)")
    parser.add_argument("--max-pages", type=int, help="Optional cap on Open States pages")
    parser.add_argument("--jurisdiction", default=DEFAULT_JURISDICTION, help="Open States jurisdiction (default: Texas)")
    parser.add_argument("--output", type=Path, default=Path(DEFAULT_OUTPUT), help=f"Aggregate JSON path (default: {DEFAULT_OUTPUT})")
    parser.add_argument(
        "--bill-dir",
        type=Path,
        default=Path(DEFAULT_BILL_DIR),
        help=f"Directory for one JSON file per bill (default: {DEFAULT_BILL_DIR})",
    )
    return parser.parse_args()


def bill_filename(bill: dict[str, Any], index: int) -> str:
    """Create a filesystem-safe, collision-resistant filename for a bill."""
    identifier = str(bill.get("identifier") or bill.get("id") or f"bill_{index}")
    safe_identifier = re.sub(r"[^A-Za-z0-9]+", "_", identifier).strip("_").lower()
    return f"{index:03d}_{safe_identifier or f'bill_{index}'}.json"


def write_bill_files(
    bills: list[dict[str, Any]],
    *,
    output_path: Path,
    bill_dir: Path,
    jurisdiction: str,
    session: str | None,
) -> None:
    """Write one aggregate JSON file and one JSON file for each bill."""
    generated_at = datetime.now(timezone.utc).isoformat()
    aggregate = {
        "generated_at": generated_at,
        "jurisdiction": jurisdiction,
        "session": session,
        "bill_count": len(bills),
        "bills": bills,
    }

    if output_path.resolve().parent == bill_dir.resolve():
        raise ValueError("--output must not be in the same directory as --bill-dir")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(aggregate, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    bill_dir.mkdir(parents=True, exist_ok=True)
    for old_file in bill_dir.glob("*.json"):
        old_file.unlink()
    for index, bill in enumerate(bills, start=1):
        bill_path = bill_dir / bill_filename(bill, index)
        bill_path.write_text(json.dumps(bill, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    load_dotenv(Path(__file__).resolve().parent / ".env")
    args = parse_args()
    if (args.limit < 1 or args.limit > 1000
            or args.per_page < 1 or args.per_page > 100
            or (args.max_pages is not None and (args.max_pages < 1 or args.max_pages > 100))):
        print("--limit must be 1-1000; --per-page must be 1-100; --max-pages must be 1-100", file=sys.stderr)
        return 2

    open_states_key = os.getenv("OPEN_STATES_API_KEY")
    if not open_states_key:
        print("Missing OPEN_STATES_API_KEY in .env", file=sys.stderr)
        return 2

    try:
        bills = fetch_bills(
            open_states_key,
            jurisdiction=args.jurisdiction,
            session=args.session,
            limit=args.limit,
            per_page=args.per_page,
            max_pages=args.max_pages,
        )
    except ApiError as exc:
        print(f"Could not fetch bills: {exc}", file=sys.stderr)
        return 1

    try:
        write_bill_files(
            bills,
            output_path=args.output,
            bill_dir=args.bill_dir,
            jurisdiction=args.jurisdiction,
            session=args.session,
        )
    except OSError as exc:
        print(f"Could not write JSON files: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(f"Saved {len(bills)} bills to {args.output} and {args.bill_dir}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
