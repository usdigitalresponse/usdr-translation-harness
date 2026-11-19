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
import pdfplumber

from document_text import GDOC_GET_PARAMS, docx_paragraphs, gdoc_paragraphs
from failure_reasons import (
    REASON_HANDOFF_FAILED, REASON_INVALID_OUTPUT, REASON_NO_ACTIVE_MODELS, REASON_SAVING_FAILED,
    REASON_UNSUPPORTED_TYPE,
    model_failure_reason, input_failure_reason, text_fetch_failure_reason, combine_reasons,
)
from llm import call_llm
from loaders import (
    load_config, load_doc, load_settings, write_output, DOCS_API_VERSION, DRIVE_API_VERSION, SHEETS_API_VERSION,
)
from notifier import notify_extraction_failed, notify_larger_than_designed, notify_not_processed
from size_limits import (
    GREEN, RED, YELLOW, block_category, estimated_pages, page_category, pdf_page_count, red_reason,
    size_info, translatable_block_count, worse, yellow_reason,
)

EXTRACT_ROLE = "extract"
PUBSUB_TOPIC_ENV_VAR = "PUBSUB_TOPIC_EXTRACTION_COMPLETE"
PROCESSING_LOG_SHEET_NAME = "ProcessingLog"
PROCESSING_LOG_COLUMNS = "A:J"
STATUS_EXTRACTED = "extracted"
STATUS_FAILED = "failed"
# Over the pilot size limits (red): not processed. Not a failure: nothing broke
STATUS_REJECTED = "rejected"
MIME_PDF_EXPORT = "application/pdf"

MIME_PDF = "application/pdf"
MIME_GOOGLE_DOCS = "application/vnd.google-apps.document"
MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
TEXT_MIME_TYPES = {MIME_GOOGLE_DOCS, MIME_DOCX}

# Processing Log error cells: the error class and message, cut to this length
MAX_ERROR_DETAIL_CHARS = 500

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


def fetch_paragraphs_from_drive(file_id, mime_type):
    """Paragraphs of a Google Doc or Word file, each to become a block. What's
    read and what isn't: see document_text.py."""
    credentials, _ = google.auth.default()

    if mime_type == MIME_GOOGLE_DOCS:
        # The Docs API, not Drive's plain-text export: the export includes
        # comments, headers, footers, footnotes and [1]/[a] markers
        service = build("docs", DOCS_API_VERSION, credentials=credentials)
        return gdoc_paragraphs(service.documents().get(documentId=file_id, **GDOC_GET_PARAMS).execute())

    service = build("drive", DRIVE_API_VERSION, credentials=credentials)
    request = service.files().get_media(fileId=file_id)
    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return docx_paragraphs(buffer.getvalue())


def text_to_extraction_json(paragraphs, source_file_id):
    """Extraction JSON for the text passthrough: one block per paragraph."""
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


def compute_content_metrics(parsed, extraction_method):
    blocks = parsed.get("blocks", [])
    source_text = " ".join(b.get("text", "") for b in blocks)
    return {
        "extraction_method": extraction_method,
        "block_count": len(blocks),
        "source_word_count": len(source_text.split()),
        "source_char_count": len(source_text),
    }


def build_output_filename(file_name, model, suffix):
    stem = Path(file_name or "unknown").stem
    safe_model = model.replace("/", "_")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{stem}_{safe_model}_{timestamp}_{suffix}"


def save_extraction_results(file_name, model, raw_response, source_file_id, size_for=None):
    """Save the raw response and the parsed extraction. size_for(parsed), if
    given, returns the extraction's "size" (size_limits.size_info), saved with it."""
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
    if size_for:
        parsed["size"] = size_for(parsed)

    parsed_filename = build_output_filename(file_name, model, "extraction.json")
    drive_file_id = write_output(parsed_filename, parsed)
    logger.info("Saved parsed extraction: %s", parsed_filename)
    return {"parsed": parsed, "driveFileId": drive_file_id, "fileName": parsed_filename}


def log_structured(status, provider, model, source_file_id, source_file_name,
                    drive_file_id="", error="", usage=None, content_metrics=None,
                    submitted_by_email=""):
    entry = {
        "severity": {STATUS_FAILED: "ERROR", STATUS_REJECTED: "WARNING"}.get(status, "INFO"),
        "message": f"extraction {status} for {provider}/{model}",
        "pipeline_stage": "extract",
        "status": status,
        "provider": provider,
        "model": model,
        "sourceFileId": source_file_id,
        "sourceFileName": source_file_name,
    }
    if submitted_by_email:
        # Who dropped the file in the input folder (Drive lastModifyingUser,
        # passed from the Orchestrator)
        entry["submittedByEmail"] = submitted_by_email
    if drive_file_id:
        entry["driveFileId"] = drive_file_id
    if error:
        entry["error"] = error
    if usage:
        entry["input_tokens"] = usage.get("input_tokens")
        entry["output_tokens"] = usage.get("output_tokens")
        if usage.get("duration_ms") is not None:
            entry["duration_ms"] = usage["duration_ms"]
        # Which backend served the call (vertex/direct), why Vertex was skipped if
        # it fell back, and how many fast-failure retries it took — see llm.call_llm.
        for key in ("llm_backend", "llm_fallback_reason", "model_retries"):
            if usage.get(key):
                entry[key] = usage[key]
    if content_metrics:
        entry.update(content_metrics)
    print(json.dumps(entry), flush=True)


def _get_sheets_service():
    credentials, _ = google.auth.default()
    return build("sheets", SHEETS_API_VERSION, credentials=credentials)


def _append_processing_log_row(row):
    """Append one row to the processing log. Append-only: never edits an
    existing row (concurrent writers — Orchestrator, Translate, PL eval — all
    append, and in-place edits caused race conditions)."""
    sheet_id = os.environ.get("PROCESSING_LOG_SHEET_ID")
    if not sheet_id:
        logger.info("No PROCESSING_LOG_SHEET_ID set — skipping log update")
        return False

    service = _get_sheets_service()
    service.spreadsheets().values().append(
        spreadsheetId=sheet_id,
        range=f"{PROCESSING_LOG_SHEET_NAME}!{PROCESSING_LOG_COLUMNS}",
        valueInputOption="RAW",
        body={"values": [row]},
    ).execute()
    return True


def _processing_log_row(file_id, file_name, status, provider, model,
                        duration_ms="", error="", output_file_id="", submitted_by_email=""):
    """Processing log columns A–J: File ID, File Name, Processed At, Status,
    Duration (ms), Error Detail, Output File ID, Provider, Model, Submitted By."""
    completed_at = datetime.now().strftime("%m/%d/%Y %H:%M")
    return [file_id, file_name, completed_at, status, duration_ms, error,
            output_file_id, provider, model, submitted_by_email]


def log_extraction_result(file_id, file_name, extraction_result, usage=None, submitted_by_email=""):
    """Append an `extracted` row. Duration is the LLM call time from `usage`
    (blank for text passthrough, which makes no LLM call)."""
    duration_ms = (usage or {}).get("duration_ms", "")
    row = _processing_log_row(
        file_id, file_name, STATUS_EXTRACTED,
        extraction_result["provider"], extraction_result["model"],
        duration_ms=duration_ms, output_file_id=extraction_result["driveFileId"],
        submitted_by_email=submitted_by_email,
    )
    if _append_processing_log_row(row):
        logger.info(
            "Logged extraction result for %s/%s to processing log",
            extraction_result["provider"], extraction_result["model"],
        )


def log_extraction_failure(file_id, file_name, provider, model, error, usage=None,
                           submitted_by_email=""):
    """Append a `failed` row with the error in Error Detail."""
    duration_ms = (usage or {}).get("duration_ms", "")
    row = _processing_log_row(file_id, file_name, STATUS_FAILED, provider, model,
                              duration_ms=duration_ms, error=error,
                              submitted_by_email=submitted_by_email)
    if _append_processing_log_row(row):
        logger.info("Logged extraction failure for %s/%s to processing log", provider, model)


def record_rejection(provider, model, file_id, file_name, size, settings, submitted_by_email=""):
    """A file over the pilot's size limits: a `rejected` Processing Log row with
    the numbers and a structured log entry. The caller sends the Chat notice."""
    pages = "unknown" if size["pages"] is None else f"{size['pages']}{' (estimated)' if size['pagesEstimated'] else ''}"
    blocks = "not counted yet" if size["blocks"] is None else size["blocks"]
    detail = (f"Over the pilot size limits: {pages} pages, {blocks} blocks "
              f"(limits: {settings['yellow_max_pages']} pages, {settings['yellow_max_blocks']} blocks)")
    log_structured(STATUS_REJECTED, provider, model, file_id, file_name, error=detail,
                   content_metrics={"size_category": size["category"], "page_count": size["pages"],
                                    "pages_estimated": size["pagesEstimated"], "block_count": size["blocks"]},
                   submitted_by_email=submitted_by_email)
    try:
        if _append_processing_log_row(_processing_log_row(file_id, file_name, STATUS_REJECTED, provider, model,
                                                          error=detail, submitted_by_email=submitted_by_email)):
            logger.info("Logged size rejection for %s to processing log", file_name)
    except Exception:
        logger.exception("Failed to log size rejection to processing sheet")


def size_category_of(result):
    """An extraction result's size category (green if it has none)."""
    return (result["parsed"].get("size") or {}).get("category", GREEN)


def export_gdoc_pdf(file_id):
    """A Google Doc rendered as PDF (all tabs, each starting on a new page), read-only."""
    credentials, _ = google.auth.default()
    service = build("drive", DRIVE_API_VERSION, credentials=credentials)
    request = service.files().export_media(fileId=file_id, mimeType=MIME_PDF_EXPORT)
    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buffer.getvalue()


def count_text_pages(file_id, mime_type, paragraphs, settings):
    """(pages, estimated) for a Google Doc (exact, from its PDF export) or Word
    file (estimated from the word count). (None, False) if a Google Doc's
    export fails: the page check is then skipped, and blocks still apply."""
    if mime_type == MIME_GOOGLE_DOCS:
        try:
            return pdf_page_count(export_gdoc_pdf(file_id)), False
        except Exception:
            logger.exception("Couldn't count pages of %s (PDF export failed); skipping the page check", file_id)
            return None, False
    return estimated_pages(paragraphs, settings["words_per_page"]), True


def describe_error(err):
    """The error's class and message for the Processing Log, e.g.
    "APITimeoutError: Request timed out." (cut to MAX_ERROR_DETAIL_CHARS)."""
    return f"{type(err).__name__}: {err}"[:MAX_ERROR_DETAIL_CHARS]


def record_failure(provider, model, file_id, file_name, error, usage=None, submitted_by_email=""):
    """Log a failure to Cloud Run logs and the processing log sheet. A sheet
    write failure is logged but never raised, so it can't mask the original error."""
    log_structured(STATUS_FAILED, provider, model, file_id, file_name,
                   error=error, usage=usage, submitted_by_email=submitted_by_email)
    try:
        log_extraction_failure(file_id, file_name, provider, model, error, usage=usage,
                               submitted_by_email=submitted_by_email)
    except Exception:
        logger.exception("Failed to log extraction failure to processing sheet")


def publish_extraction_complete(file_id, file_name, extraction_results, content_type="public_flyer", submitted_by_email="",
                                submitted_by_name=""):
    """Publish one extraction-complete message per extraction, for Translate.

    Returns:
        list of (extraction result, error) for each message that failed to publish
    """
    topic_name = os.environ.get(PUBSUB_TOPIC_ENV_VAR)
    if not topic_name:
        logger.info("No %s set — skipping Pub/Sub publish", PUBSUB_TOPIC_ENV_VAR)
        return []

    publisher = pubsub_v1.PublisherClient()
    failures = []
    for result in extraction_results:
        message = {
            "sourceFileId": file_id,
            "sourceFileName": file_name,
            "extractionFileId": result["driveFileId"],
            "extractionFileName": result["fileName"],
            "model": result["model"],
            "provider": result["provider"],
            "contentType": content_type,
            "submittedByEmail": submitted_by_email,
            "submittedByName": submitted_by_name,
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
        except Exception as err:
            logger.exception(
                "Failed to publish extraction-complete for %s/%s",
                result["provider"], result["model"],
            )
            failures.append((result, err))
    return failures


def hand_off_to_translate(file_id, file_name, extraction_results, content_type, submitted_by_email,
                          submitted_by_name):
    """Publish the extractions for Translate. Only called with at least one
    successful extraction (if every model failed, run_pdf_extraction has already
    told the submitter). A failed publish gets a failed row; if every publish
    failed, the extractions are saved but Translate never hears about them, so
    the submitter is told. Returns whether at least one extraction was handed off."""
    failures = publish_extraction_complete(file_id, file_name, extraction_results, content_type,
                                           submitted_by_email, submitted_by_name)
    for result, err in failures:
        record_failure(result["provider"], result["model"], file_id, file_name,
                       f"Hand-off to Translate (Pub/Sub publish) failed: {describe_error(err)}",
                       submitted_by_email=submitted_by_email)
    none_published = bool(failures) and len(failures) == len(extraction_results)
    if none_published:
        notify_extraction_failed(file_name, [REASON_HANDOFF_FAILED], submitted_by_email, submitted_by_name)
    return not none_published


def run_text_extraction(file_id, file_name, mime_type, content_type="public_flyer", submitted_by_email="",
                        submitted_by_name=""):
    """Text passthrough path for Google Docs and DOCX files."""
    logger.info("Text extraction for %s (MIME: %s)", file_name, mime_type)

    try:
        paragraphs = fetch_paragraphs_from_drive(file_id, mime_type)
        logger.info("Fetched %d paragraphs", len(paragraphs))
    except Exception as e:
        logger.exception("Failed to fetch text for %s", file_name)
        record_failure(PASSTHROUGH_PROVIDER, PASSTHROUGH_MODEL,
                       file_id, file_name, f"Text fetch failed: {describe_error(e)}",
                       submitted_by_email=submitted_by_email)
        notify_extraction_failed(file_name, [text_fetch_failure_reason(e)], submitted_by_email, submitted_by_name)
        return

    settings = load_settings()
    pages, pages_estimated = count_text_pages(file_id, mime_type, paragraphs, settings)
    page_cat = page_category(pages, settings) if pages is not None else GREEN
    size = size_info(worse(page_cat, block_category(len(paragraphs), settings)),
                     pages, pages_estimated, len(paragraphs))
    if size["category"] == RED:
        record_rejection(PASSTHROUGH_PROVIDER, PASSTHROUGH_MODEL, file_id, file_name, size, settings,
                         submitted_by_email)
        notify_not_processed(file_name, red_reason(page_cat == RED, pages, pages_estimated, settings),
                             submitted_by_email, submitted_by_name)
        return

    try:
        parsed = text_to_extraction_json(paragraphs, file_id)
        parsed["size"] = size
        parsed_filename = build_output_filename(file_name, PASSTHROUGH_MODEL, "extraction.json")
        drive_file_id = write_output(parsed_filename, parsed)
        logger.info("Saved text extraction: %s", parsed_filename)
    except Exception as e:
        logger.exception("Failed to save text extraction for %s", file_name)
        record_failure(PASSTHROUGH_PROVIDER, PASSTHROUGH_MODEL,
                       file_id, file_name, f"Text extraction save failed: {describe_error(e)}",
                       submitted_by_email=submitted_by_email)
        notify_extraction_failed(file_name, [REASON_SAVING_FAILED], submitted_by_email, submitted_by_name)
        return

    enriched = {
        "parsed": parsed,
        "driveFileId": drive_file_id,
        "fileName": parsed_filename,
        "model": PASSTHROUGH_MODEL,
        "provider": PASSTHROUGH_PROVIDER,
    }

    metrics = compute_content_metrics(parsed, "text_passthrough")
    log_structured(STATUS_EXTRACTED, PASSTHROUGH_PROVIDER, PASSTHROUGH_MODEL,
                   file_id, file_name, drive_file_id=drive_file_id,
                   content_metrics=metrics, submitted_by_email=submitted_by_email)
    try:
        log_extraction_result(file_id, file_name, enriched, submitted_by_email=submitted_by_email)
    except Exception:
        logger.exception("Failed to log extraction result to processing sheet")

    handed_off = hand_off_to_translate(file_id, file_name, [enriched], content_type, submitted_by_email,
                                       submitted_by_name)
    if handed_off and size["category"] == YELLOW:
        notify_larger_than_designed(file_name, yellow_reason(page_cat == YELLOW, pages, pages_estimated),
                                    submitted_by_email, submitted_by_name)


def run_pdf_extraction(file_id, file_name, content_type="public_flyer", submitted_by_email="", submitted_by_name=""):
    """LLM-based extraction pipeline for PDF files."""
    config = load_config()
    active_models = get_active_models(config, EXTRACT_ROLE)
    if not active_models:
        logger.error("No active models configured for role '%s'", EXTRACT_ROLE)
        record_failure("", "", file_id, file_name, "No active extract models in Model Config",
                       submitted_by_email=submitted_by_email)
        notify_extraction_failed(file_name, [REASON_NO_ACTIVE_MODELS], submitted_by_email, submitted_by_name)
        return
    logger.info("Active extract models: %s", [m["model"] for m in active_models])

    pdf_bytes = load_pdf_bytes(file_id)
    logger.info("PDF loaded: %d bytes", len(pdf_bytes))

    # Pages before any model call; blocks once each model's extraction is parsed
    settings = load_settings()
    pages = pdf_page_count(pdf_bytes)
    page_cat = page_category(pages, settings)
    if page_cat == RED:
        record_rejection("", "", file_id, file_name, size_info(RED, pages, False, None), settings,
                         submitted_by_email)
        notify_not_processed(file_name, red_reason(True, pages, False, settings), submitted_by_email,
                             submitted_by_name)
        return

    def size_for(parsed):
        blocks = translatable_block_count(parsed)
        return size_info(worse(page_cat, block_category(blocks, settings)), pages, False, blocks)

    pdf_base64 = base64.b64encode(pdf_bytes).decode()
    extracted_text = extract_text_with_pdfplumber(io.BytesIO(pdf_bytes))
    if extracted_text:
        extraction_method = "pdfplumber_plus_vision"
        logger.info("pdfplumber extracted %d characters of text", len(extracted_text))
    else:
        extraction_method = "vision_only"
        logger.info("No embedded text layer found (image-based/scanned PDF)")

    base_prompt = load_doc("EXTRACTION_PROMPT_DOC_ID")
    prompt = build_extraction_prompt(base_prompt, extracted_text)
    logger.info("Extraction prompt assembled (%d characters)", len(prompt))

    extraction_results = []
    failures = []  # (provider, model, plain-language reason) for the Chat notice
    size_rejected = False
    for model_config in active_models:
        provider = model_config["provider"]
        model = model_config["model"]
        logger.info("Calling %s/%s for extraction", provider, model)
        try:
            raw_response, usage = call_llm(provider, model, prompt, pdf_base64)
            logger.info("Received response from %s/%s (%d characters, %d in / %d out tokens)",
                        provider, model, len(raw_response),
                        usage.get("input_tokens", 0), usage.get("output_tokens", 0))
        except Exception as e:
            logger.exception("LLM call failed for %s/%s", provider, model)
            record_failure(provider, model, file_id, file_name, f"LLM call failed: {describe_error(e)}",
                           submitted_by_email=submitted_by_email)
            failures.append((provider, model, model_failure_reason(e)))
            continue

        try:
            result = save_extraction_results(file_name, model, raw_response, source_file_id=file_id,
                                             size_for=size_for)
        except Exception as e:
            # The model call is paid for; record it and go on to the next model
            logger.exception("Saving the extraction failed for %s/%s", provider, model)
            record_failure(provider, model, file_id, file_name,
                           f"Saving the extraction failed: {describe_error(e)}",
                           usage=usage, submitted_by_email=submitted_by_email)
            failures.append((provider, model, REASON_SAVING_FAILED))
            continue

        if result and size_category_of(result) == RED:
            # Saved (for a look later), but too large to translate
            record_rejection(provider, model, file_id, file_name, result["parsed"]["size"], settings,
                             submitted_by_email)
            size_rejected = True
        elif result:
            enriched = {**result, "model": model, "provider": provider}
            extraction_results.append(enriched)
            metrics = compute_content_metrics(result["parsed"], extraction_method)
            log_structured(STATUS_EXTRACTED, provider, model, file_id, file_name,
                           drive_file_id=result["driveFileId"], usage=usage,
                           content_metrics=metrics, submitted_by_email=submitted_by_email)
            try:
                log_extraction_result(file_id, file_name, enriched, usage=usage,
                                      submitted_by_email=submitted_by_email)
            except Exception:
                logger.exception("Failed to log extraction result to processing sheet")
        else:
            record_failure(provider, model, file_id, file_name,
                           "Extraction parse/validation failed", usage=usage, submitted_by_email=submitted_by_email)
            failures.append((provider, model, REASON_INVALID_OUTPUT))

    if not extraction_results:
        # Nothing goes on to Translate, so the submitter would hear nothing
        if size_rejected:
            notify_not_processed(file_name, red_reason(False, pages, False, settings), submitted_by_email,
                                 submitted_by_name)
        else:
            notify_extraction_failed(file_name, combine_reasons(failures), submitted_by_email, submitted_by_name)
        return

    handed_off = hand_off_to_translate(file_id, file_name, extraction_results, content_type, submitted_by_email,
                                       submitted_by_name)
    yellow = any(size_category_of(r) == YELLOW for r in extraction_results)
    if handed_off and yellow:
        notify_larger_than_designed(file_name, yellow_reason(page_cat == YELLOW, pages, False),
                                    submitted_by_email, submitted_by_name)


SUPPORTED_MIME_TYPES = {MIME_PDF} | TEXT_MIME_TYPES


def run_extraction(file_id, file_name, mime_type, content_type="public_flyer", submitted_by_email="",
                   submitted_by_name=""):
    if mime_type not in SUPPORTED_MIME_TYPES:
        logger.error("Unsupported MIME type '%s' for %s", mime_type, file_name)
        record_failure(PASSTHROUGH_PROVIDER, PASSTHROUGH_MODEL,
                       file_id, file_name, f"Unsupported MIME type: {mime_type}", submitted_by_email=submitted_by_email)
        notify_extraction_failed(file_name, [REASON_UNSUPPORTED_TYPE], submitted_by_email, submitted_by_name)
        return

    try:
        if mime_type in TEXT_MIME_TYPES:
            run_text_extraction(file_id, file_name, mime_type, content_type, submitted_by_email, submitted_by_name)
        else:
            run_pdf_extraction(file_id, file_name, content_type, submitted_by_email, submitted_by_name)
    except Exception as e:
        # Uncaught errors outside the per-model loop (config, PDF download,
        # prompt doc, Pub/Sub publish). Without this the background thread dies
        # with no sheet row.
        logger.exception("Extraction failed for %s", file_name)
        record_failure("", "", file_id, file_name, f"Extraction failed: {describe_error(e)}",
                       submitted_by_email=submitted_by_email)
        notify_extraction_failed(file_name, [input_failure_reason(e)], submitted_by_email, submitted_by_name)


@functions_framework.http
def extract(request):
    body = request.get_json(silent=True) or {}
    file_id = body.get("fileId")
    file_name = body.get("fileName")
    mime_type = body.get("mimeType", MIME_PDF)
    content_type = body.get("contentType", "public_flyer")
    submitted_by_email = body.get("submittedByEmail", "")
    submitted_by_name = body.get("submittedByName", "")

    logger.info("Received request: fileId=%s, fileName=%s, mimeType=%s", file_id, file_name, mime_type)

    if not file_id:
        return json.dumps({"error": "Provide fileId"}), HTTPStatus.BAD_REQUEST

    thread = threading.Thread(target=run_extraction, args=(file_id, file_name, mime_type, content_type, submitted_by_email,
                                                           submitted_by_name))
    thread.start()

    return json.dumps({
        "status": "accepted",
        "fileId": file_id,
        "fileName": file_name,
    }), HTTPStatus.ACCEPTED
