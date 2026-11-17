#!/usr/bin/env python3
"""Validate bill-feed display titles.

Hard violations (empty title, ellipsis cut, raw "Relating to" caption) must
never reach the site: they exit 1. Soft violations (more than 6 words or over
70 characters) are usually OpenRouter rate-limit leftovers; they exit 2 so CI
runs the automatic title repair, then re-validates with --allow-soft, which
tolerates leftovers as a ::warning:: while the feed still publishes.

Exit codes:
  0 - clean (or soft leftovers tolerated under --allow-soft)
  1 - hard violations, unreadable feed, or failed self-test
  2 - soft violations only (repairable with --fix-titles-only)

Usage:
  python3 validate_feed.py texas_bill_summaries.json [--allow-soft]
  python3 validate_feed.py --self-test
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from summarize_bills import needs_short_title, sanitize_display_title

ELLIPSIS_ENDINGS = ("…", "...")


def hard_violations(records: list) -> list[str]:
    """Violations that are deterministically fixable and must never publish."""
    problems: list[str] = []
    for record in records:
        identifier = str(record.get("identifier") or "?") if isinstance(record, dict) else "?"
        title = record.get("title") if isinstance(record, dict) else None
        text = str(title).strip() if title is not None else ""
        if not text:
            problems.append(f"{identifier}: empty title")
        elif text.endswith(ELLIPSIS_ENDINGS):
            problems.append(f"{identifier}: title ends with ellipsis: {text[:70]}")
        elif text.lower().startswith("relating to "):
            problems.append(f"{identifier}: raw caption prefix: {text[:70]}")
        elif sanitize_display_title(text) != text:
            problems.append(f"{identifier}: title fails sanitize_display_title: {text[:70]}")
    return problems


def soft_violations(records: list) -> list[str]:
    """Titles the AI short-title pass should improve (rate-limit leftovers)."""
    problems: list[str] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        title = record.get("title")
        text = str(title or "").strip()
        if not text or hard_violations([record]):
            continue  # empty/hard problems are reported by hard_violations
        if needs_short_title(title):
            identifier = str(record.get("identifier") or "?")
            problems.append(f"{identifier}: title not a clean 2-6 word name: {text[:70]}")
    return problems


def run_self_test() -> int:
    """Offline regression checks - no network, no API key (CI L6 guard)."""
    failures: list[str] = []

    good = ["Campground and Youth Camp Safety", "Data Centers", "Emissions Opacity Monitoring"]
    bad_hard = [
        "Relating to campground and youth camp safety",
        "The conversion of all or a portion of a municipal sales and use…",
        "Proposing a constitutional amendment relating to the...",
        "",
        "   ",
    ]
    bad_soft = [
        "The establishment of the Task Force on Concrete Plants",
        "Proposing a constitutional amendment requiring the state to expand eligibility for Medicaid to certain individuals under the federal Patient Protection and Affordable Care Act",
    ]

    records = [{"identifier": f"B{i}", "title": t} for i, t in enumerate(good + bad_hard + bad_soft)]

    hard = hard_violations(records)
    hard_ids = {p.split(":")[0] for p in hard}
    expected_hard_ids = {f"B{i}" for i in range(len(good), len(good) + len(bad_hard))}
    if hard_ids != expected_hard_ids:
        failures.append(f"hard_violations ids: expected {expected_hard_ids}, got {hard_ids}")

    soft = soft_violations(records)
    soft_ids = {p.split(":")[0] for p in soft}
    expected_soft_ids = {f"B{i}" for i in range(len(good) + len(bad_hard), len(records))}
    if soft_ids != expected_soft_ids:
        failures.append(f"soft_violations ids: expected {expected_soft_ids}, got {soft_ids}")

    if hard_violations([{"identifier": "G", "title": t} for t in good]):
        failures.append("clean titles flagged as hard violations")
    if soft_violations([{"identifier": "G", "title": t} for t in good]):
        failures.append("clean titles flagged as soft violations")

    # L1 invariant: sanitize_display_title must deterministically remove
    # ellipsis cuts and raw "Relating to" prefixes from any input.
    sanitize_cases = {
        "Relating to youth camp safety.": "Youth camp safety.",
        "Municipal sales and use…": "Municipal sales and use",
        "The monitoring of emissions from certain...": "The monitoring of emissions from certain",
        "Honoring Bobby Gene Roberts Sr.": "Honoring Bobby Gene Roberts Sr.",
        "Data Centers": "Data Centers",
        "": "",
    }
    for raw, expected in sanitize_cases.items():
        got = sanitize_display_title(raw)
        if got != expected:
            failures.append(f"sanitize_display_title({raw!r}) = {got!r}, expected {expected!r}")

    if failures:
        print("SELF-TEST FAILED:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    print(f"Self-test passed: {len(good)} clean, {len(bad_hard)} hard, {len(bad_soft)} soft fixtures.")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()

    allow_soft = "--allow-soft" in argv
    paths = [arg for arg in argv if not arg.startswith("--")]
    if len(paths) != 1:
        print("Usage: validate_feed.py <feed.json> [--allow-soft] | --self-test", file=sys.stderr)
        return 1
    path = Path(paths[0])
    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"::error::Cannot read feed {path}: {exc}", file=sys.stderr)
        return 1
    if not isinstance(records, list) or not records or not all(isinstance(record, dict) for record in records):
        print(f"::error::{path} is not a non-empty list of records", file=sys.stderr)
        return 1

    hard = hard_violations(records)
    soft = soft_violations(records)
    for problem in hard:
        print(f"::error::HARD title violation - {problem}", file=sys.stderr)
    for problem in soft:
        print(f"::warning::SOFT title violation - {problem}", file=sys.stderr)
    print(f"Validated {len(records)} records: {len(hard)} hard, {len(soft)} soft violations.")

    if hard:
        return 1
    if soft:
        return 0 if allow_soft else 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
