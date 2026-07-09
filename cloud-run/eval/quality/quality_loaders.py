"""Config, prompt, translation, and result I/O for the quality eval function.

Module names in this package are prefixed with `quality_` so they stay
distinct from the identically-purposed modules in other function directories
(e.g. `extract/loaders.py`), which pytest places on the same flat `pythonpath`.
"""

import io
import json
import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv
import google.auth
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

load_dotenv(Path(__file__).resolve().parent.parent.parent.parent / ".env")

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
MODEL_CONFIG_SHEET_RANGE = "Config!A:E"
ACTIVE_YES = "YES"

EVAL_RESULTS_SHEET_NAME = "EvalQuality"
EVAL_RESULTS_SHEET_RANGE = f"{EVAL_RESULTS_SHEET_NAME}!A:L"

# https://developers.google.com/docs/api/reference/rest
DOCS_API_VERSION = "v1"
# https://developers.google.com/sheets/api/reference/rest
SHEETS_API_VERSION = "v4"
# https://developers.google.com/drive/api/reference/rest/v3
DRIVE_API_VERSION = "v3"

# Drive links come in a few shapes: /file/d/<id>/view, /d/<id>/edit, ?id=<id>.
# Anything else is treated as a bare file ID.
DRIVE_ID_PATTERNS = (
    re.compile(r"/d/([a-zA-Z0-9_-]+)"),
    re.compile(r"[?&]id=([a-zA-Z0-9_-]+)"),
)

logger = logging.getLogger(__name__)


def parse_drive_file_id(url_or_id):
    """Accept a Drive URL or a bare file ID and return the file ID."""
    if not url_or_id:
        raise ValueError("No Drive URL or file ID provided")

    if "/" not in url_or_id and "?" not in url_or_id:
        return url_or_id

    for pattern in DRIVE_ID_PATTERNS:
        match = pattern.search(url_or_id)
        if match:
            return match.group(1)

    segments = [s for s in url_or_id.split("?")[0].split("/") if s]
    if not segments:
        raise ValueError(f"Could not parse a Drive file ID from: {url_or_id}")
    return segments[-1]


def load_doc(env_var, local_path_env_var=None):
    """Load a Google Doc's text, or a local file when local_path_env_var is set.

    The local override lets the function run end-to-end without Google
    credentials, the same way LOCAL_TRANSLATION_JSON_PATH skips the Drive fetch.
    """
    if local_path_env_var:
        local_path = os.environ.get(local_path_env_var)
        if local_path:
            path = Path(local_path)
            if not path.exists():
                raise FileNotFoundError(f"{local_path_env_var} not found: {local_path}")
            logger.info("Loading doc from local path: %s", local_path)
            return path.read_text(encoding="utf-8")

    doc_id = os.environ.get(env_var)
    if not doc_id:
        raise ValueError(f"{env_var} not set in .env")

    credentials, _ = google.auth.default()
    service = build("docs", DOCS_API_VERSION, credentials=credentials)
    doc = service.documents().get(documentId=doc_id).execute()
    text = ""
    for element in doc.get("body", {}).get("content", []):
        paragraph = element.get("paragraph")
        if not paragraph:
            continue
        for run in paragraph.get("elements", []):
            text_run = run.get("textRun")
            if text_run:
                text += text_run["content"]
    return text


def _load_config_from_sheet(sheet_id):
    credentials, _ = google.auth.default()
    service = build("sheets", SHEETS_API_VERSION, credentials=credentials)
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range=MODEL_CONFIG_SHEET_RANGE)
        .execute()
    )
    rows = result.get("values", [])
    if len(rows) < 2:
        raise ValueError(f"Config sheet '{sheet_id}' has no data rows")

    headers = [h.strip().lower() for h in rows[0]]
    models = []
    for row in rows[1:]:
        entry = {}
        for i, header in enumerate(headers):
            value = row[i].strip() if i < len(row) else ""
            if header == "active":
                value = value.upper() == ACTIVE_YES
            elif header == "provider":
                value = value.lower()
            entry[header] = value
        models.append(entry)

    logger.info("Loaded %d model entries from config sheet", len(models))
    return {"models": models}


def _load_config_from_fixture():
    return json.loads((FIXTURES_DIR / "config.json").read_text(encoding="utf-8"))


def load_config():
    sheet_id = os.environ.get("MODEL_CONFIG_SHEET_ID")
    if sheet_id:
        return _load_config_from_sheet(sheet_id)
    return _load_config_from_fixture()


def load_translation_json(file_id):
    """Fetch translation JSON from Drive, or from a local path for dev."""
    local_path = os.environ.get("LOCAL_TRANSLATION_JSON_PATH")
    if local_path:
        path = Path(local_path)
        if not path.exists():
            raise FileNotFoundError(f"LOCAL_TRANSLATION_JSON_PATH not found: {local_path}")
        logger.info("Loading translation JSON from local path: %s", local_path)
        return json.loads(path.read_text(encoding="utf-8"))

    logger.info("Fetching translation JSON from Drive: %s", file_id)
    credentials, _ = google.auth.default()
    service = build("drive", DRIVE_API_VERSION, credentials=credentials)
    content = service.files().get_media(fileId=file_id, supportsAllDrives=True).execute()
    if isinstance(content, bytes):
        content = content.decode("utf-8")
    return json.loads(content)


def _write_to_drive(folder_id, filename, data):
    credentials, _ = google.auth.default()
    service = build("drive", DRIVE_API_VERSION, credentials=credentials)
    content = data if isinstance(data, str) else json.dumps(data, indent=2, ensure_ascii=False)
    media = MediaIoBaseUpload(
        io.BytesIO(content.encode("utf-8")), mimetype="application/json"
    )
    created = service.files().create(
        body={"name": filename, "parents": [folder_id]},
        media_body=media,
        fields="id",
        supportsAllDrives=True,
    ).execute()
    logger.info("Wrote %s to Drive folder %s (fileId: %s)", filename, folder_id, created["id"])
    return created["id"]


def _write_to_local(filename, data):
    out_dir = FIXTURES_DIR / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    content = data if isinstance(data, str) else json.dumps(data, indent=2, ensure_ascii=False)
    (out_dir / filename).write_text(content, encoding="utf-8")
    logger.info("Wrote %s to %s", filename, out_dir)


def write_eval_result(filename, data):
    folder_id = os.environ.get("DRIVE_EVAL_RESULTS_FOLDER_ID")
    if folder_id:
        return _write_to_drive(folder_id, filename, data)
    _write_to_local(filename, data)
    return None


def append_result_row(row):
    """Append one summary row to the quality eval results sheet."""
    sheet_id = os.environ.get("EVAL_QUALITY_RESULTS_SHEET_ID")
    if not sheet_id:
        logger.info("No EVAL_QUALITY_RESULTS_SHEET_ID set — skipping results sheet update")
        return

    credentials, _ = google.auth.default()
    service = build("sheets", SHEETS_API_VERSION, credentials=credentials)
    service.spreadsheets().values().append(
        spreadsheetId=sheet_id,
        range=EVAL_RESULTS_SHEET_RANGE,
        valueInputOption="RAW",
        body={"values": [row]},
    ).execute()
    logger.info("Appended quality eval result row to results sheet")
