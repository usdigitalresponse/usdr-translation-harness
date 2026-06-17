import csv
import io
import json
import os
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


def load_doc(env_var):
    doc_id = os.environ.get(env_var)
    if not doc_id:
        raise ValueError(f"{env_var} not set in .env")

    url = f"https://docs.google.com/document/d/{doc_id}/export?format=txt"
    with urllib.request.urlopen(url) as resp:
        return resp.read().decode("utf-8")


def load_sheet(env_var, *, sheet=0):
    sheet_id = os.environ.get(env_var)
    if not sheet_id:
        raise ValueError(f"{env_var} not set in .env")

    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={sheet}"
    with urllib.request.urlopen(url) as resp:
        text = resp.read().decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))
    return list(reader)


# Config is private — loads from local fixture file for local dev.
def load_config():
    fixture_path = FIXTURES_DIR / "config.json"
    return json.loads(fixture_path.read_text())


# Write results to local CSV for local dev testing.
def write_local_csv(filename, rows):
    out_dir = FIXTURES_DIR / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / filename, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
