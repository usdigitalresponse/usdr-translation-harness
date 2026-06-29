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
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import pdfplumber

from llm import call_llm
from loaders import load_config, load_doc, write_output, DRIVE_API_VERSION

EXTRACT_ROLE = "extract"
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


def save_extraction_results(file_name, model, raw_response):
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

    parsed_filename = build_output_filename(file_name, model, "extraction.json")
    write_output(parsed_filename, parsed)
    logger.info("Saved parsed extraction: %s", parsed_filename)
    return parsed


def run_extraction(file_id, file_name):
    """Background extraction pipeline (runs after 202 response)."""
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

    for model_config in active_models:
        provider = model_config["provider"]
        model = model_config["model"]
        logger.info("Calling %s/%s for extraction", provider, model)
        try:
            raw_response = call_llm(provider, model, prompt, pdf_base64)
            logger.info("Received response from %s/%s (%d characters)", provider, model, len(raw_response))
        except Exception:
            logger.exception("LLM call failed for %s/%s", provider, model)
            continue

        save_extraction_results(file_name, model, raw_response)

    # TODO: Publish completion message to PUBSUB_TOPIC_EXTRACTION_COMPLETE


@functions_framework.http
def extract(request):
    body = request.get_json(silent=True) or {}
    file_id = body.get("fileId")
    file_name = body.get("fileName")

    if not file_id:
        return json.dumps({"error": "Provide fileId"}), HTTPStatus.BAD_REQUEST

    thread = threading.Thread(target=run_extraction, args=(file_id, file_name))
    thread.start()

    return json.dumps({
        "status": "accepted",
        "fileId": file_id,
        "fileName": file_name,
    }), HTTPStatus.ACCEPTED
