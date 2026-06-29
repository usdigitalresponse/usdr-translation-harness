import io
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
import google.auth
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
MODEL_CONFIG_SHEET_RANGE = "Config!A:E"
ACTIVE_YES = "YES"

# https://developers.google.com/docs/api/reference/rest
DOCS_API_VERSION = "v1"
# https://developers.google.com/sheets/api/reference/rest
SHEETS_API_VERSION = "v4"
# https://developers.google.com/drive/api/reference/rest/v3
DRIVE_API_VERSION = "v3"

logger = logging.getLogger(__name__)


def load_doc(env_var):
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
    fixture_path = FIXTURES_DIR / "config.json"
    return json.loads(fixture_path.read_text())


def load_config():
    sheet_id = os.environ.get("MODEL_CONFIG_SHEET_ID")
    if sheet_id:
        return _load_config_from_sheet(sheet_id)
    return _load_config_from_fixture()


def _write_to_drive(folder_id, filename, data):
    credentials, _ = google.auth.default()
    service = build("drive", DRIVE_API_VERSION, credentials=credentials)
    content = data if isinstance(data, str) else json.dumps(data, indent=2)
    media = MediaIoBaseUpload(
        io.BytesIO(content.encode("utf-8")), mimetype="application/json"
    )
    file_metadata = {"name": filename, "parents": [folder_id]}
    created = service.files().create(
        body=file_metadata, media_body=media, fields="id",
        supportsAllDrives=True
    ).execute()
    logger.info("Wrote %s to Drive folder %s (fileId: %s)", filename, folder_id, created["id"])
    return created["id"]


def _write_to_local(filename, data):
    out_dir = FIXTURES_DIR / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / filename
    content = data if isinstance(data, str) else json.dumps(data, indent=2)
    path.write_text(content)


def write_output(filename, data):
    folder_id = os.environ.get("DRIVE_EXTRACTION_JSON_FOLDER_ID")
    if folder_id:
        return _write_to_drive(folder_id, filename, data)
    _write_to_local(filename, data)
    return None
