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


def load_config():
    fixture_path = FIXTURES_DIR / "config.json"
    return json.loads(fixture_path.read_text())


def write_local_json(filename, data):
    out_dir = FIXTURES_DIR / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / filename
    if isinstance(data, str):
        path.write_text(data)
    else:
        path.write_text(json.dumps(data, indent=2))
