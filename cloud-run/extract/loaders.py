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
# The whole Config tab: columns are matched by header name, so their order
# (and any added columns) doesn't matter
MODEL_CONFIG_SHEET_RANGE = "Config"
ACTIVE_YES = "YES"
# Columns every service needs to pick its models; a missing one means no model
# matches, or a model is called with a blank name or provider
REQUIRED_CONFIG_COLUMNS = ("role", "provider", "model", "active")

# Every input problem shares this message prefix and the input_problem field,
# so one log-based alert can catch them all. No pipeline_stage field: the
# pipeline_stage_status metric counts every entry that has one as a stage run.
INPUT_PROBLEM_PREFIX = "Extraction input problem"
INPUT_MODEL_CONFIG = "model_config"
INPUT_SETTINGS = "settings"

# The Settings tab of the Model Config sheet: admin-adjustable limits, one per
# row ("setting", "value"; extra columns such as "notes" are ignored). Each
# service uses some of them. A missing tab or a missing / invalid value falls
# back to the default here (logged as an input problem, so the daily health
# check reports it): a settings problem never stops the pipeline.
# Keep in sync with translate/loaders.js, eval/quality and health-check/rules.js.
SETTINGS_SHEET_RANGE = "Settings"
SETTING_NAME_COLUMN = "setting"
SETTING_VALUE_COLUMN = "value"
SETTING_DEFAULTS = {
    "green_max_pages": 2,
    "yellow_max_pages": 5,
    "green_max_blocks": 120,
    "yellow_max_blocks": 200,
    "words_per_page": 500,
    "eval_rerun_limit": 100,
}

# https://developers.google.com/docs/api/reference/rest
DOCS_API_VERSION = "v1"
# https://developers.google.com/sheets/api/reference/rest
SHEETS_API_VERSION = "v4"
# https://developers.google.com/drive/api/reference/rest/v3
DRIVE_API_VERSION = "v3"

logger = logging.getLogger(__name__)


class ModelConfigError(ValueError):
    """A Model Config sheet problem (missing columns, no rows, sheet ID unset)."""


class MissingSettingError(ValueError):
    """A required environment variable isn't set on the service."""


def load_doc(env_var):
    doc_id = os.environ.get(env_var)
    if not doc_id:
        raise MissingSettingError(f"{env_var} not set in .env")

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


def log_input_problem(input_name, detail, **fields):
    """Log a problem with an input the pipeline depends on as a structured ERROR."""
    entry = {
        "severity": "ERROR",
        "message": f"{INPUT_PROBLEM_PREFIX} ({input_name}): {detail}",
        "input_problem": input_name,
        **fields,
    }
    print(json.dumps(entry), flush=True)


def _config_problem(detail, **fields):
    """Log a Model Config problem and return a ModelConfigError for the caller to raise.
    Config problems stop the run (there's no model to call)."""
    log_input_problem(INPUT_MODEL_CONFIG, detail, **fields)
    return ModelConfigError(f"Model Config problem: {detail}")


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
    found_headers = [h.strip() for h in rows[0]] if rows else []
    missing_columns = [
        c for c in REQUIRED_CONFIG_COLUMNS if c not in [h.lower() for h in found_headers]
    ]
    if missing_columns:
        raise _config_problem(
            f"the {MODEL_CONFIG_SHEET_RANGE} tab is missing expected columns: "
            f"{', '.join(missing_columns)}. Row 1 must be the header row, with these exact column names.",
            missing_columns=missing_columns,
            found_headers=found_headers,
        )
    if len(rows) < 2:
        raise _config_problem(f"the {MODEL_CONFIG_SHEET_RANGE} tab has no data rows")

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


def _settings_from_rows(rows):
    """Settings from the tab's rows (row 1 = headers), defaults where missing or invalid."""
    settings = dict(SETTING_DEFAULTS)
    headers = [h.strip().lower() for h in rows[0]] if rows else []
    if SETTING_NAME_COLUMN not in headers or SETTING_VALUE_COLUMN not in headers:
        log_input_problem(INPUT_SETTINGS, f"the {SETTINGS_SHEET_RANGE} tab needs '{SETTING_NAME_COLUMN}' and "
                          f"'{SETTING_VALUE_COLUMN}' columns in row 1; using the defaults", found_headers=headers)
        return settings
    name_col, value_col = headers.index(SETTING_NAME_COLUMN), headers.index(SETTING_VALUE_COLUMN)
    for row in rows[1:]:
        name = row[name_col].strip().lower() if name_col < len(row) else ""
        if name not in SETTING_DEFAULTS:
            continue
        raw = row[value_col].strip() if value_col < len(row) else ""
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            settings[name] = value
        else:
            log_input_problem(INPUT_SETTINGS, f"{name} = {raw!r} isn't a positive whole number; using the "
                              f"default, {SETTING_DEFAULTS[name]}", setting=name)
    return settings


def load_settings():
    """The Settings tab as {setting: int}, with defaults for anything missing or
    invalid. Never raises. Without a Model Config sheet (local development),
    the defaults."""
    sheet_id = os.environ.get("MODEL_CONFIG_SHEET_ID")
    if not sheet_id:
        return dict(SETTING_DEFAULTS)
    try:
        credentials, _ = google.auth.default()
        service = build("sheets", SHEETS_API_VERSION, credentials=credentials)
        rows = service.spreadsheets().values().get(
            spreadsheetId=sheet_id, range=SETTINGS_SHEET_RANGE).execute().get("values", [])
    except Exception as e:
        log_input_problem(INPUT_SETTINGS, f"couldn't read the {SETTINGS_SHEET_RANGE} tab ({e}); using the defaults")
        return dict(SETTING_DEFAULTS)
    return _settings_from_rows(rows)


def _load_config_from_fixture():
    fixture_path = FIXTURES_DIR / "config.json"
    return json.loads(fixture_path.read_text())


def load_config():
    """Load model config from the Model Config sheet, or the local fixture.

    The fixture is for local development only: on Cloud Run (K_SERVICE is set)
    a missing MODEL_CONFIG_SHEET_ID is an error, so a deploy that loses its env
    vars can't quietly run on test models.

    Raises:
        ValueError: the sheet ID is missing on Cloud Run, or the Config tab has
            no data rows or is missing a required column.
    """
    sheet_id = os.environ.get("MODEL_CONFIG_SHEET_ID")
    if sheet_id:
        return _load_config_from_sheet(sheet_id)
    if os.environ.get("K_SERVICE"):
        raise _config_problem(
            "MODEL_CONFIG_SHEET_ID is not set. Restore the env var on this service "
            "(use --update-env-vars, not --set-env-vars)."
        )
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
