#!/usr/bin/env python3
"""Load the glossary tab from a downloaded Google Sheet.

    python load_glossary.py <download> "<tab name>"             # writes glossary.json, prints a summary
    python load_glossary.py <download> "<tab name>" --out g.json

<download> is either:
  - the JSON file the Google Drive connector saves when a download is too large
    to show (it has a base64 "content" field), or
  - an .xlsx file (downloaded by the user, or already decoded).

Writes the tab's entries as JSON (one object per row, keyed by header; empty
rows and "N/A" values dropped) and prints: entry count, entries with forbidden
terms, missing expected columns, and the "last updated" date if the sheet has
a tab for it. Needs openpyxl (pip install openpyxl).
"""

import argparse
import base64
import io
import json
import sys
from pathlib import Path

ZIP_MAGIC = b"PK"   # .xlsx files are zip archives
EMPTY_VALUES = {"", "n/a", "na"}
ENGLISH_TERM = "english term"
FORBIDDEN_TERMS = "forbidden terms"
EXPECTED_COLUMNS = [
    "english term", "acronym or abbreviation", "approved spanish", "forbidden terms",
    "definition/context", "example english", "example spanish", "notes",
]
LAST_UPDATED_MARKERS = ("last upd", "last updated")


def read_workbook_bytes(path):
    raw = Path(path).read_bytes()
    if raw[:2] == ZIP_MAGIC:
        return raw
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        sys.exit(f"{path} is neither an .xlsx file nor the Drive connector's JSON download.")
    content = data.get("content") if isinstance(data, dict) else None
    if not content:
        sys.exit(f"{path} has no 'content' field. Was it downloaded with exportMimeType "
                 "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet?")
    return base64.b64decode(content)


def clean(value):
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in EMPTY_VALUES else text


def last_updated(wb, glossary_tab):
    """Date from a tab like '<glossary tab> Last Upd', if there is one."""
    for name in wb.sheetnames:
        lowered = name.lower()
        if any(m in lowered for m in LAST_UPDATED_MARKERS) and (
                glossary_tab.lower() in lowered or len(wb.sheetnames) <= 2):
            values = [clean(c) for row in wb[name].iter_rows(values_only=True) for c in row]
            dates = [v for v in values if v and not any(m in v.lower() for m in LAST_UPDATED_MARKERS)]
            if dates:
                return name, dates[0]
    return None, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("download")
    parser.add_argument("tab")
    parser.add_argument("--out", default="glossary.json")
    args = parser.parse_args()

    try:
        import openpyxl
    except ImportError:
        sys.exit("openpyxl isn't installed. Run: pip install openpyxl")

    wb = openpyxl.load_workbook(io.BytesIO(read_workbook_bytes(args.download)),
                                read_only=True, data_only=True)
    if args.tab not in wb.sheetnames:
        sys.exit(f"No tab named '{args.tab}'. Tabs in this sheet: {', '.join(wb.sheetnames)}")

    rows = [r for r in wb[args.tab].iter_rows(values_only=True) if any(clean(c) for c in r)]
    if not rows:
        sys.exit(f"The '{args.tab}' tab is empty.")
    header = [clean(h) for h in rows[0]]
    keys = [h.lower() for h in header]
    entries = []
    for row in rows[1:]:
        entry = {header[i]: clean(v) for i, v in enumerate(row) if i < len(header) and header[i] and clean(v)}
        if any(k.lower() == ENGLISH_TERM for k in entry):
            entries.append(entry)

    Path(args.out).write_text(json.dumps(entries, ensure_ascii=False, indent=1))
    forbidden_key = next((h for h in header if h.lower() == FORBIDDEN_TERMS), None)
    updated_tab, updated = last_updated(wb, args.tab)
    summary = {
        "tab": args.tab,
        "entries": len(entries),
        "entries_with_forbidden_terms": sum(1 for e in entries if forbidden_key and e.get(forbidden_key)),
        "columns": [h for h in header if h],
        "missing_expected_columns": [c for c in EXPECTED_COLUMNS if c not in keys],
        "last_updated": updated,
        "last_updated_tab": updated_tab,
        "other_tabs": [n for n in wb.sheetnames if n != args.tab],
        "written_to": args.out,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
