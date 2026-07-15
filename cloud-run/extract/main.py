import base64
import io
import json
import jsonschema
import logging
import os
import re
import threading
from datetime import datetime
from http import HTTPStatus
from pathlib import Path

import functions_framework
import google.auth
from google.cloud import pubsub_v1
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import docx
import pdfplumber

from llm import call_llm
from loaders import load_config, load_doc, write_output, DRIVE_API_VERSION, SHEETS_API_VERSION

EXTRACT_ROLE = "extract"
PUBSUB_TOPIC_ENV_VAR = "PUBSUB_TOPIC_EXTRACTION_COMPLETE"
PROCESSING_LOG_SHEET_NAME = "ProcessingLog"
STATUS_EXTRACTED = "extracted"
STATUS_FAILED = "failed"

MIME_PDF = "application/pdf"
MIME_GOOGLE_DOCS = "application/vnd.google-apps.document"
MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
TEXT_MIME_TYPES = {MIME_GOOGLE_DOCS, MIME_DOCX}

PASSTHROUGH_PROVIDER = "passthrough"
PASSTHROUGH_MODEL = "text"
SCHEMA_DIR = Path(__file__).resolve().parent
MARKDOWN_JSON_PATTERN = re.compile(r"```(?:json)?\s*\n(.*?)\n\s*```", re.DOTALL)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def fetch_pdf_from_drive(file_id):
    credentials, _ = google.auth.default()
    service = build("drive", DRIVE_API_VERSION, credentials=credentials)
    request = service.files().get_media(fileId=file_id)
    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buffer.getvalue()


def load_pdf_bytes(file_id):
    # Override when developing locally to get around Drive access
    local_path = os.environ.get("LOCAL_PDF_PATH")
    if local_path:
        path = Path(local_path)
        if not path.exists():
            raise FileNotFoundError(f"LOCAL_PDF_PATH not found: {local_path}")
        logger.info("Loading PDF from local path: %s", local_path)
        return path.read_bytes()

    logger.info("Fetching PDF from Drive: %s", file_id)
    return fetch_pdf_from_drive(file_id)


def build_extraction_prompt(base_prompt, extracted_text):
    if extracted_text:
        return f"{base_prompt}\n\n<extracted_text>\n{extracted_text}\n</extracted_text>"
    return base_prompt


def get_active_models(config, role):
    return [m for m in config["models"] if m["role"] == role and m["active"]]


def extract_text_with_pdfplumber(pdf_bytes):
    """Extract text from PDF bytes using pdfplumber.

    Returns extracted text joined by page, or None if the PDF has no
    embedded text layer (e.g. scanned/image-based documents).
    """
    pages_text = []
    with pdfplumber.open(pdf_bytes) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                pages_text.append(text)

    if not pages_text:
        return None

    return "\n\n".join(pages_text)


def fetch_text_from_drive(file_id, mime_type):
    credentials, _ = google.auth.default()
    service = build("drive", DRIVE_API_VERSION, credentials=credentials)

    if mime_type == MIME_GOOGLE_DOCS:
        request = service.files().export_media(fileId=file_id, mimeType="text/plain")
    else:
        request = service.files().get_media(fileId=file_id)

    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()

    raw_bytes = buffer.getvalue()

    if mime_type == MIME_DOCX:
        doc = docx.Document(io.BytesIO(raw_bytes))
        return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())

    return raw_bytes.decode("utf-8-sig")


def text_to_extraction_json(text, source_file_id):
    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    blocks = []
    for i, paragraph in enumerate(paragraphs):
        blocks.append({
            "id": f"block-{i + 1}",
            "role": "body",
            "text": paragraph,
            "translate": True,
        })

    return {
        "sourceType": "text",
        "sourceFileId": source_file_id,
        "blocks": blocks,
    }


def parse_extraction_response(raw_response):
    match = MARKDOWN_JSON_PATTERN.search(raw_response)
    text = match.group(1) if match else raw_response
    return json.loads(text)


def validate_extraction(data):
    schema = json.loads((SCHEMA_DIR / "extraction-schema-claude.json").read_text())
    jsonschema.validate(instance=data, schema=schema)


def build_output_filename(file_name, model, suffix):
    stem = Path(file_name or "unknown").stem
    safe_model = model.replace("/", "_")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{stem}_{safe_model}_{timestamp}_{suffix}"


def save_extraction_results(file_name, model, raw_response, source_file_id):
    raw_filename = build_output_filename(file_name, model, "raw.txt")
    write_output(raw_filename, raw_response)
    logger.info("Saved raw response: %s", raw_filename)

    try:
        parsed = parse_extraction_response(raw_response)
    except json.JSONDecodeError:
        logger.error("Failed to parse JSON from %s/%s response", model, raw_filename)
        return None

    try:
        validate_extraction(parsed)
        logger.info("Extraction validated against schema")
    except jsonschema.ValidationError as e:
        logger.warning("Schema validation failed: %s", e.message)

    parsed["sourceFileId"] = source_file_id
    parsed["sourceType"] = "pdf"

    parsed_filename = build_output_filename(file_name, model, "extraction.json")
    drive_file_id = write_output(parsed_filename, parsed)
    logger.info("Saved parsed extraction: %s", parsed_filename)
    return {"parsed": parsed, "driveFileId": drive_file_id, "fileName": parsed_filename}


def log_structured(status, provider, model, source_file_id, source_file_name,
                    drive_file_id="", error=""):
    entry = {
        "severity": "ERROR" if status == STATUS_FAILED else "INFO",
        "message": f"extraction {status} for {provider}/{model}",
        "pipeline_stage": "extract",
        "status": status,
        "provider": provider,
        "model": model,
        "sourceFileId": source_file_id,
        "sourceFileName": source_file_name,
    }
    if drive_file_id:
        entry["driveFileId"] = drive_file_id
    if error:
        entry["error"] = error
    print(json.dumps(entry), flush=True)


def _get_sheets_service():
    credentials, _ = google.auth.default()
    return build("sheets", SHEETS_API_VERSION, credentials=credentials)


def log_extraction_result(file_id, file_name, extraction_result):
    sheet_id = os.environ.get("PROCESSING_LOG_SHEET_ID")
    if not sheet_id:
        logger.info("No PROCESSING_LOG_SHEET_ID set — skipping log update")
        return

    service = _get_sheets_service()

    completed_at = datetime.now().strftime("%m/%d/%Y %H:%M")
    row = [
        file_id,
        file_name,
        completed_at,
        STATUS_EXTRACTED,
        "",
        "",
        extraction_result["driveFileId"],
        extraction_result["provider"],
        extraction_result["model"],
    ]

    service.spreadsheets().values().append(
        spreadsheetId=sheet_id,
        range=f"{PROCESSING_LOG_SHEET_NAME}!A:I",
        valueInputOption="RAW",
        body={"values": [row]},
    ).execute()
    logger.info(
        "Logged extraction result for %s/%s to processing log",
        extraction_result["provider"], extraction_result["model"],
    )


def publish_extraction_complete(file_id, file_name, extraction_results):
    topic_name = os.environ.get(PUBSUB_TOPIC_ENV_VAR)
    if not topic_name:
        logger.info("No %s set — skipping Pub/Sub publish", PUBSUB_TOPIC_ENV_VAR)
        return

    publisher = pubsub_v1.PublisherClient()
    for result in extraction_results:
        message = {
            "sourceFileId": file_id,
            "sourceFileName": file_name,
            "extractionFileId": result["driveFileId"],
            "extractionFileName": result["fileName"],
            "model": result["model"],
            "provider": result["provider"],
        }
        data = json.dumps(message).encode("utf-8")
        try:
            future = publisher.publish(topic_name, data)
            PUBLISH_TIMEOUT_SECONDS = 60
            message_id = future.result(timeout=PUBLISH_TIMEOUT_SECONDS)
            logger.info(
                "Published extraction-complete for %s/%s (message %s)",
                result["provider"], result["model"], message_id,
            )
        except Exception:
            logger.exception(
                "Failed to publish extraction-complete for %s/%s",
                result["provider"], result["model"],
            )


def run_text_extraction(file_id, file_name, mime_type):
    """Text passthrough path for Google Docs and DOCX files."""
    logger.info("Text extraction for %s (MIME: %s)", file_name, mime_type)

    try:
        text = fetch_text_from_drive(file_id, mime_type)
        logger.info("Fetched text: %d characters", len(text))
    except Exception:
        logger.exception("Failed to fetch text for %s", file_name)
        log_structured(STATUS_FAILED, PASSTHROUGH_PROVIDER, PASSTHROUGH_MODEL,
                       file_id, file_name, error="Text fetch failed")
        return

    try:
        parsed = text_to_extraction_json(text, file_id)
        parsed_filename = build_output_filename(file_name, PASSTHROUGH_MODEL, "extraction.json")
        drive_file_id = write_output(parsed_filename, parsed)
        logger.info("Saved text extraction: %s", parsed_filename)
    except Exception:
        logger.exception("Failed to save text extraction for %s", file_name)
        log_structured(STATUS_FAILED, PASSTHROUGH_PROVIDER, PASSTHROUGH_MODEL,
                       file_id, file_name, error="Text extraction save failed")
        return

    enriched = {
        "parsed": parsed,
        "driveFileId": drive_file_id,
        "fileName": parsed_filename,
        "model": PASSTHROUGH_MODEL,
        "provider": PASSTHROUGH_PROVIDER,
    }

    log_structured(STATUS_EXTRACTED, PASSTHROUGH_PROVIDER, PASSTHROUGH_MODEL,
                   file_id, file_name, drive_file_id=drive_file_id)
    try:
        log_extraction_result(file_id, file_name, enriched)
    except Exception:
        logger.exception("Failed to log extraction result to processing sheet")

    publish_extraction_complete(file_id, file_name, [enriched])


def run_pdf_extraction(file_id, file_name):
    """LLM-based extraction pipeline for PDF files."""
    config = load_config()
    active_models = get_active_models(config, EXTRACT_ROLE)
    if not active_models:
        logger.error("No active models configured for role '%s'", EXTRACT_ROLE)
        return
    logger.info("Active extract models: %s", [m["model"] for m in active_models])

    pdf_bytes = load_pdf_bytes(file_id)
    logger.info("PDF loaded: %d bytes", len(pdf_bytes))

    pdf_base64 = base64.b64encode(pdf_bytes).decode()
    extracted_text = extract_text_with_pdfplumber(io.BytesIO(pdf_bytes))
    if extracted_text:
        logger.info("pdfplumber extracted %d characters of text", len(extracted_text))
    else:
        logger.info("No embedded text layer found (image-based/scanned PDF)")

    base_prompt = load_doc("EXTRACTION_PROMPT_DOC_ID")
    prompt = build_extraction_prompt(base_prompt, extracted_text)
    logger.info("Extraction prompt assembled (%d characters)", len(prompt))

    extraction_results = []
    for model_config in active_models:
        provider = model_config["provider"]
        model = model_config["model"]
        logger.info("Calling %s/%s for extraction", provider, model)
        try:
            raw_response = call_llm(provider, model, prompt, pdf_base64)
            logger.info("Received response from %s/%s (%d characters)", provider, model, len(raw_response))
        except Exception:
            logger.exception("LLM call failed for %s/%s", provider, model)
            log_structured(STATUS_FAILED, provider, model, file_id, file_name,
                           error="LLM call failed")
            continue

        result = save_extraction_results(file_name, model, raw_response, source_file_id=file_id)
        if result:
            enriched = {**result, "model": model, "provider": provider}
            extraction_results.append(enriched)
            log_structured(STATUS_EXTRACTED, provider, model, file_id, file_name,
                           drive_file_id=result["driveFileId"])
            try:
                log_extraction_result(file_id, file_name, enriched)
            except Exception:
                logger.exception("Failed to log extraction result to processing sheet")
        else:
            log_structured(STATUS_FAILED, provider, model, file_id, file_name,
                           error="Extraction parse/validation failed")

    publish_extraction_complete(file_id, file_name, extraction_results)


SUPPORTED_MIME_TYPES = {MIME_PDF} | TEXT_MIME_TYPES


def run_extraction(file_id, file_name, mime_type):
    if mime_type not in SUPPORTED_MIME_TYPES:
        logger.error("Unsupported MIME type '%s' for %s", mime_type, file_name)
        log_structured(STATUS_FAILED, PASSTHROUGH_PROVIDER, PASSTHROUGH_MODEL,
                       file_id, file_name, error=f"Unsupported MIME type: {mime_type}")
        return

    if mime_type in TEXT_MIME_TYPES:
        run_text_extraction(file_id, file_name, mime_type)
    else:
        run_pdf_extraction(file_id, file_name)


@functions_framework.http
def extract(request):
    body = request.get_json(silent=True) or {}
    file_id = body.get("fileId")
    file_name = body.get("fileName")
    mime_type = body.get("mimeType", MIME_PDF)

    logger.info("Received request: fileId=%s, fileName=%s, mimeType=%s", file_id, file_name, mime_type)

    if not file_id:
        return json.dumps({"error": "Provide fileId"}), HTTPStatus.BAD_REQUEST

    thread = threading.Thread(target=run_extraction, args=(file_id, file_name, mime_type))
    thread.start()

    return json.dumps({
        "status": "accepted",
        "fileId": file_id,
        "fileName": file_name,
    }), HTTPStatus.ACCEPTED
