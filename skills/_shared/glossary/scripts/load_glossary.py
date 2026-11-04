#!/usr/bin/env python3
"""Load the glossary tab from a downloaded Google Sheet.

    python load_glossary.py <download> "<tab name>"             # writes glossary.json, prints a summary
    python load_glossary.py <download> "<tab name>" --out g.json

<download> is one of:
  - the JSON file the Google Drive connector saves when a download is too large
    to show (it has a base64 "content" field);
  - an .xlsx file (downloaded by the user, or already decoded);
  - a .csv export of just the glossary tab (the tab name is then ignored).

Writes the tab's entries as JSON (one object per row, keyed by header; empty
rows and "N/A" values dropped) and prints: entry count, entries with forbidden
terms, missing expected columns, and the "last updated" date if the sheet has
a tab for it. Exits with an error if no entries load, so an empty or
misread glossary is never mistaken for a clean check. Needs openpyxl for
.xlsx (pip install openpyxl).
"""

import argparse
import base64
import csv
import io
import json
import sys
from pathlib import Path

ZIP_MAGIC = b"PK"   # .xlsx files are zip archives
ENCODING = "utf-8"
EMPTY_VALUES = {"", "n/a", "na"}
ENGLISH_TERM = "english term"
FORBIDDEN_TERMS = "forbidden terms"
EXPECTED_COLUMNS = [
    "english term", "acronym or abbreviation", "approved spanish", "forbidden terms",
    "definition/context", "example english", "example spanish", "notes",
]
LAST_UPDATED_MARKERS = ("last upd", "last updated")
MAX_HEADER_SEARCH_ROWS = 10   # a title or notes row may sit above the headers


def clean(value):
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in EMPTY_VALUES else text


def read_download(path):
    """Return ("xlsx", bytes) or ("csv", text) for any supported download."""
    raw = Path(path).read_bytes()
    if raw[:2] == ZIP_MAGIC:
        return "xlsx", raw
    if Path(path).suffix.lower() == ".csv":
        return "csv", raw.decode(ENCODING, errors="replace").lstrip("﻿")
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        sys.exit(f"{path} isn't an .xlsx file, a .csv file, or the Drive connector's JSON download.")
    content = data.get("content") if isinstance(data, dict) else None
    if not content:
        sys.exit(f"{path} has no 'content' field. Was it downloaded with exportMimeType "
                 "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet?")
    return "xlsx", base64.b64decode(content)


def find_tab(wb, wanted):
    """The tab named `wanted`, matching case and surrounding spaces loosely."""
    if wanted in wb.sheetnames:
        return wanted
    loose = [n for n in wb.sheetnames if n.strip().lower() == wanted.strip().lower()]
    if loose:
        return loose[0]
    sys.exit(f"No tab named '{wanted}'. Tabs in this sheet: {', '.join(wb.sheetnames)}")


def last_updated(wb, glossary_tab):
    """Date from a tab like '<glossary tab> Last Upd', if there is one."""
    for name in wb.sheetnames:
        lowered = name.lower()
        if any(m in lowered for m in LAST_UPDATED_MARKERS) and (
                glossary_tab.strip().lower() in lowered or len(wb.sheetnames) <= 2):
            values = [clean(c) for row in wb[name].iter_rows(values_only=True) for c in row]
            dates = [v for v in values if v and not any(m in v.lower() for m in LAST_UPDATED_MARKERS)]
            if dates:
                return name, dates[0]
    return None, None


def to_entries(rows):
    """Header = the first row (within the first few) that has an English Term
    column; entries = the rows after it that have an English Term."""
    for i, row in enumerate(rows[:MAX_HEADER_SEARCH_ROWS]):
        header = [clean(h) for h in row]
        if ENGLISH_TERM in (h.lower() for h in header):
            break
    else:
        sys.exit(f"Couldn't find a header row with an 'English Term' column in the first "
                 f"{MAX_HEADER_SEARCH_ROWS} rows.")
    entries = []
    for row in rows[i + 1:]:
        entry = {header[j]: clean(v) for j, v in enumerate(row) if j < len(header) and header[j] and clean(v)}
        if any(k.lower() == ENGLISH_TERM for k in entry):
            entries.append(entry)
    return header, entries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("download")
    parser.add_argument("tab")
    parser.add_argument("--out", default="glossary.json")
    args = parser.parse_args()

    kind, data = read_download(args.download)
    updated_tab = updated = None
    other_tabs = []
    if kind == "csv":
        tab = f"{args.download} (CSV)"
        rows = [r for r in csv.reader(io.StringIO(data)) if any(clean(c) for c in r)]
    else:
        try:
            import openpyxl
        except ImportError:
            sys.exit("openpyxl isn't installed. Run: pip install openpyxl")
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        tab = find_tab(wb, args.tab)
        rows = [r for r in wb[tab].iter_rows(values_only=True) if any(clean(c) for c in r)]
        updated_tab, updated = last_updated(wb, tab)
        other_tabs = [n for n in wb.sheetnames if n != tab]

    if not rows:
        sys.exit(f"The '{tab}' tab is empty.")
    header, entries = to_entries(rows)
    if not entries:
        sys.exit(f"No glossary entries found in '{tab}' (no rows with an English Term under the header). "
                 "Check the tab and the file before relying on any glossary check.")

    Path(args.out).write_text(json.dumps(entries, ensure_ascii=False, indent=1), encoding=ENCODING)
    keys = [h.lower() for h in header]
    forbidden_key = next((h for h in header if h.lower() == FORBIDDEN_TERMS), None)
    summary = {
        "tab": tab,
        "entries": len(entries),
        "entries_with_forbidden_terms": sum(1 for e in entries if forbidden_key and e.get(forbidden_key)),
        "columns": [h for h in header if h],
        "missing_expected_columns": [c for c in EXPECTED_COLUMNS if c not in keys],
        "last_updated": updated,
        "last_updated_tab": updated_tab,
        "other_tabs": other_tabs,
        "written_to": args.out,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
