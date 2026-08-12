"""Config, golden-set, prompt, and result I/O for the drift eval function.

Module names in this package are prefixed with `drift_` so they stay distinct
from the identically-purposed modules in other function directories (e.g.
`quality/quality_loaders.py`, `extract/loaders.py`), which pytest places on the
same flat `pythonpath`.
"""

import csv
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

# The golden set lives on the first sheet of GOLDEN_SET_SHEET_ID. Leaving the
# range unqualified (no tab name) targets that first sheet regardless of its
# title, so the seed sheet doesn't have to be named a specific thing.
GOLDEN_SET_SHEET_RANGE = "A:Z"

# Accepted header spellings (normalized to lower_snake_case) → canonical field.
GOLDEN_FIELD_ALIASES = {
    "id": {"id", "example_id", "example"},
    "source_language": {"source_language", "source_lang"},
    "target_language": {"target_language", "target_lang"},
    "source_text": {"source_text", "source", "source_content"},
    "reference_translation": {
        "reference_translation", "reference", "reference_text", "target_text",
    },
}

EVAL_RESULTS_SHEET_NAME = "EvalDrift"
EVAL_RESULTS_SHEET_RANGE = f"{EVAL_RESULTS_SHEET_NAME}!A:N"
EVAL_RESULTS_HEADER_RANGE = f"{EVAL_RESULTS_SHEET_NAME}!A1:N1"

# Column order must match build_result_row() in main.py.
EVAL_RESULTS_HEADERS = [
    "Timestamp",
    "Golden Example ID",
    "Provider",
    "Model",
    "Source Language",
    "Target Language",
    "BLEU",
    "ROUGE-1 F",
    "ROUGE-2 F",
    "ROUGE-L F",
    "Judge Weighted Overall",
    "Judge Priority",
    "Regression",
    "Result File ID",
]

# https://developers.google.com/docs/api/reference/rest
DOCS_API_VERSION = "v1"
# https://developers.google.com/sheets/api/reference/rest
SHEETS_API_VERSION = "v4"
# https://developers.google.com/drive/api/reference/rest/v3
DRIVE_API_VERSION = "v3"

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
    credentials, the same way GOLDEN_SET_LOCAL_PATH skips the Sheet fetch.
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
    return _extract_structural_text(doc.get("body", {}).get("content", []))


def _extract_structural_text(elements):
    """Concatenate text from a Docs API structural-element list.

    Handles paragraphs and tables (recursing into cells), so rubric scales and
    other content authored in tables aren't silently dropped.
    """
    text = ""
    for element in elements:
        paragraph = element.get("paragraph")
        if paragraph:
            for run in paragraph.get("elements", []):
                text_run = run.get("textRun")
                if text_run:
                    text += text_run["content"]
            continue
        table = element.get("table")
        if table:
            for row in table.get("tableRows", []):
                for cell in row.get("tableCells", []):
                    text += _extract_structural_text(cell.get("content", []))
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


def _normalize_header(header):
    return re.sub(r"\s+", "_", str(header).strip().lower())


def _golden_column_overrides():
    """Explicit source/reference column names from env, for golden sets whose
    columns are named by language (e.g. "English"/"Spanish") rather than
    "Source Text"/"Reference Translation".

    The column names double as the default source/target language labels.
    """
    src = os.environ.get("GOLDEN_SOURCE_COLUMN")
    ref = os.environ.get("GOLDEN_REFERENCE_COLUMN")
    return {
        "source_header": _normalize_header(src) if src else None,
        "reference_header": _normalize_header(ref) if ref else None,
        "source_language": src.strip() if src else None,
        "target_language": ref.strip() if ref else None,
    }


def _map_golden_headers(headers, overrides=None):
    """Map each column index to a canonical golden-set field, if recognized.

    An explicit GOLDEN_SOURCE_COLUMN / GOLDEN_REFERENCE_COLUMN override wins over
    the built-in alias matching, so language-named columns can be pointed at the
    source-text and reference-translation fields.
    """
    overrides = overrides or _golden_column_overrides()
    index_to_field = {}
    for i, header in enumerate(headers):
        normalized = _normalize_header(header)
        if overrides["source_header"] and normalized == overrides["source_header"]:
            index_to_field[i] = "source_text"
            continue
        if overrides["reference_header"] and normalized == overrides["reference_header"]:
            index_to_field[i] = "reference_translation"
            continue
        for field, aliases in GOLDEN_FIELD_ALIASES.items():
            if normalized in aliases:
                index_to_field[i] = field
                break
    return index_to_field


def _rows_to_golden_examples(rows):
    """Turn a header row + data rows into golden-example dicts.

    Rows missing a source text or reference translation are skipped — they
    can't produce a BLEU/ROUGE comparison.
    """
    overrides = _golden_column_overrides()
    index_to_field = _map_golden_headers(rows[0], overrides)
    fields = set(index_to_field.values())
    if "source_text" not in fields or "reference_translation" not in fields:
        raise ValueError(
            "Golden set is missing a source-text or reference-translation column "
            "(set GOLDEN_SOURCE_COLUMN / GOLDEN_REFERENCE_COLUMN for language-named columns)"
        )

    default_source_lang = overrides["source_language"] or "unknown"
    default_target_lang = overrides["target_language"] or "unknown"

    examples = []
    for row_num, row in enumerate(rows[1:], start=1):
        record = {}
        for i, field in index_to_field.items():
            value = row[i] if i < len(row) and row[i] is not None else ""
            record[field] = str(value).strip()
        if not record.get("source_text") or not record.get("reference_translation"):
            continue
        examples.append({
            "id": record.get("id") or f"golden-{row_num:02d}",
            "source_language": record.get("source_language") or default_source_lang,
            "target_language": record.get("target_language") or default_target_lang,
            "source_text": record["source_text"],
            "reference_translation": record["reference_translation"],
        })

    if not examples:
        raise ValueError("Golden set has no usable rows")
    return examples


def _read_xlsx_rows(path):
    """Read the active worksheet of an .xlsx as a list of string-cell rows.

    openpyxl is imported lazily: it's a local-dev convenience for reading a
    spreadsheet export, not a dependency of the deployed function (which reads
    the golden set from the Google Sheet).
    """
    try:
        import openpyxl
    except ImportError as e:
        raise RuntimeError(
            "Reading an .xlsx golden set requires openpyxl (pip install openpyxl), "
            "or export it to .csv"
        ) from e
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    worksheet = workbook.active
    rows = []
    for row in worksheet.iter_rows(values_only=True):
        if any(cell is not None for cell in row):
            rows.append(["" if cell is None else str(cell) for cell in row])
    return rows


def _read_csv_rows(path):
    with path.open(encoding="utf-8-sig", newline="") as f:
        return [row for row in csv.reader(f) if any(str(c).strip() for c in row)]


def _load_local_golden_set(path):
    suffix = path.suffix.lower()
    if suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        examples = data.get("examples", data) if isinstance(data, dict) else data
        if not examples:
            raise ValueError("Local golden set is empty")
        return examples
    if suffix in (".xlsx", ".xlsm"):
        rows = _read_xlsx_rows(path)
    elif suffix == ".csv":
        rows = _read_csv_rows(path)
    else:
        raise ValueError(f"Unsupported GOLDEN_SET_LOCAL_PATH type '{suffix}' (use .xlsx, .csv, or .json)")
    if len(rows) < 2:
        raise ValueError(f"Local golden set '{path}' has no data rows")
    return _rows_to_golden_examples(rows)


def load_golden_set():
    """Load source/reference pairs from the golden-set Sheet, or a local file.

    Set GOLDEN_SET_LOCAL_PATH to a .xlsx, .csv, or .json export to run without
    Google credentials. For spreadsheets whose columns are named by language,
    set GOLDEN_SOURCE_COLUMN / GOLDEN_REFERENCE_COLUMN (they also supply the
    source/target language labels).
    """
    local_path = os.environ.get("GOLDEN_SET_LOCAL_PATH")
    if local_path:
        path = Path(local_path)
        if not path.exists():
            raise FileNotFoundError(f"GOLDEN_SET_LOCAL_PATH not found: {local_path}")
        logger.info("Loading golden set from local path: %s", local_path)
        examples = _load_local_golden_set(path)
        logger.info("Loaded %d golden examples", len(examples))
        return examples

    sheet_id = os.environ.get("GOLDEN_SET_SHEET_ID")
    if not sheet_id:
        raise ValueError("GOLDEN_SET_SHEET_ID not set in .env")

    credentials, _ = google.auth.default()
    service = build("sheets", SHEETS_API_VERSION, credentials=credentials)
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=sheet_id, range=GOLDEN_SET_SHEET_RANGE)
        .execute()
    )
    rows = result.get("values", [])
    if len(rows) < 2:
        raise ValueError(f"Golden set sheet '{sheet_id}' has no data rows")

    examples = _rows_to_golden_examples(rows)
    logger.info("Loaded %d golden examples", len(examples))
    return examples


def _write_to_drive(folder_id, filename, data, properties=None):
    credentials, _ = google.auth.default()
    service = build("drive", DRIVE_API_VERSION, credentials=credentials)
    content = data if isinstance(data, str) else json.dumps(data, indent=2, ensure_ascii=False)
    media = MediaIoBaseUpload(
        io.BytesIO(content.encode("utf-8")), mimetype="application/json"
    )
    body = {"name": filename, "parents": [folder_id]}
    if properties:
        body["properties"] = properties
    created = service.files().create(
        body=body,
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


def write_eval_result(filename, data, properties=None):
    folder_id = os.environ.get("DRIVE_EVAL_RESULTS_FOLDER_ID")
    if folder_id:
        return _write_to_drive(folder_id, filename, data, properties)
    _write_to_local(filename, data)
    return None


def _ensure_results_sheet(service, sheet_id):
    """Create the results tab and header row if they aren't there yet."""
    metadata = service.spreadsheets().get(
        spreadsheetId=sheet_id, fields="sheets.properties.title"
    ).execute()
    titles = [s["properties"]["title"] for s in metadata.get("sheets", [])]

    if EVAL_RESULTS_SHEET_NAME not in titles:
        service.spreadsheets().batchUpdate(
            spreadsheetId=sheet_id,
            body={"requests": [
                {"addSheet": {"properties": {"title": EVAL_RESULTS_SHEET_NAME}}}
            ]},
        ).execute()
        logger.info("Created '%s' tab in results sheet", EVAL_RESULTS_SHEET_NAME)

    header = service.spreadsheets().values().get(
        spreadsheetId=sheet_id, range=EVAL_RESULTS_HEADER_RANGE
    ).execute().get("values", [])

    if not header:
        service.spreadsheets().values().update(
            spreadsheetId=sheet_id,
            range=EVAL_RESULTS_HEADER_RANGE,
            valueInputOption="RAW",
            body={"values": [EVAL_RESULTS_HEADERS]},
        ).execute()
        logger.info("Wrote header row to results sheet")


def _append_to_csv(path_str, row):
    """Append one row to a local CSV, writing the header if the file is new."""
    path = Path(path_str)
    write_header = not path.exists() or path.stat().st_size == 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(EVAL_RESULTS_HEADERS)
        writer.writerow(row)
    logger.info("Appended drift eval result row to %s", path)


def append_result_row(row):
    """Append one summary row to the results sheet, or a local CSV for dev."""
    local_csv = os.environ.get("LOCAL_DRIFT_RESULTS_CSV")
    if local_csv:
        _append_to_csv(local_csv, row)
        return

    sheet_id = os.environ.get("EVAL_DRIFT_RESULTS_SHEET_ID")
    if not sheet_id:
        logger.info("No EVAL_DRIFT_RESULTS_SHEET_ID set — skipping results sheet update")
        return

    credentials, _ = google.auth.default()
    service = build("sheets", SHEETS_API_VERSION, credentials=credentials)

    _ensure_results_sheet(service, sheet_id)

    service.spreadsheets().values().append(
        spreadsheetId=sheet_id,
        range=EVAL_RESULTS_SHEET_RANGE,
        valueInputOption="RAW",
        insertDataOption="INSERT_ROWS",
        body={"values": [row]},
    ).execute()
    logger.info("Appended drift eval result row to results sheet")
