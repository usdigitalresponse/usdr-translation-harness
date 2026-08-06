import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from http import HTTPStatus

import functions_framework
import jsonschema

from quality_llm import call_llm, load_eval_schema, PROVIDER_ANTHROPIC
from quality_loaders import (
    append_result_row,
    load_config,
    load_doc,
    load_translation_json,
    parse_drive_file_id,
    write_eval_result,
)

EVAL_ROLE = "eval"
RUBRIC_DOC_ENV_VAR = "EVALUATION_RUBRIC_DOC_ID"
RUBRIC_LOCAL_PATH_ENV_VAR = "LOCAL_RUBRIC_PATH"

# Structured-log fields shared with the other pipeline stages (see extract's
# log_structured) so dashboards can query across stages by pipeline_stage.
PIPELINE_STAGE = "eval_quality"
STATUS_OK = "ok"
STATUS_FAILED = "failed"

# Rubric criteria, in the order they appear in the eval schema and in the
# results sheet columns.
CRITERIA = (
    "accuracy_and_relevance",
    "clarity_and_simplicity",
    "cultural_sensitivity",
    "active_voice_and_tone",
    "consistency_and_style",
)

MARKDOWN_JSON_PATTERN = re.compile(r"```(?:json)?\s*\n(.*?)\n\s*```", re.DOTALL)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def get_active_models(config, role):
    return [m for m in config["models"] if m["role"] == role and m["active"]]


def format_translation_for_review(translation_json):
    """Render translation blocks as source/target pairs for the judge."""
    lines = []
    for block in translation_json.get("blocks", []):
        lines.append(
            f"[{block['id']}]\n"
            f"Source: {block['original_text']}\n"
            f"Translation: {block['translated_text']}"
        )

    metadata = translation_json.get("metadata", {})
    notes = metadata.get("overall_notes")
    if notes:
        lines.append(f"[translator notes]\n{notes}")

    return "\n\n".join(lines)


def build_eval_prompt(rubric, translation_json):
    metadata = translation_json.get("metadata", {})
    source_language = metadata.get("source_language", "unknown")
    target_language = metadata.get("target_language", "unknown")
    body = format_translation_for_review(translation_json)

    return (
        f"{rubric.rstrip()}\n\n"
        f"Score the following {source_language} to {target_language} translation "
        f"against every criterion in the rubric above.\n\n"
        f"<translation>\n{body}\n</translation>"
    )


def parse_eval_response(raw_response):
    match = MARKDOWN_JSON_PATTERN.search(raw_response)
    text = match.group(1) if match else raw_response
    return json.loads(text)


def validate_eval(data):
    schema = load_eval_schema(PROVIDER_ANTHROPIC)
    jsonschema.validate(instance=data, schema=schema)


def build_result_row(translation_file_id, provider, model, scores, result_file_id):
    # Column order must match EVAL_RESULTS_SHEET_RANGE (A–L).
    return [
        datetime.now().strftime("%m/%d/%Y %H:%M"),
        translation_file_id,
        provider,
        model,
        scores["weighted_overall_score"],
        scores["overall_priority_rating"],
        *[scores[criterion]["score"] for criterion in CRITERIA],
        result_file_id or "",
    ]


def log_structured(status, provider, model, translation_file_id, *, document_id="",
                   result_location_id="", scores=None, usage=None, duration_ms=None, error=""):
    """Emit one JSON log line per model so dashboards can aggregate on fields.

    logger.info/exception lines land in Cloud Logging as free text; this prints
    a structured object (mirroring extract's log_structured) with the metrics
    worth charting — pass/fail, latency, token usage, and the headline scores.
    """
    entry = {
        "severity": "ERROR" if status == STATUS_FAILED else "INFO",
        "message": f"quality eval {status} for {provider}/{model}",
        "pipeline_stage": PIPELINE_STAGE,
        "status": status,
        "provider": provider,
        "model": model,
        "translationFileId": translation_file_id,
    }
    if document_id:
        entry["documentId"] = document_id
    if result_location_id:
        entry["resultLocationId"] = result_location_id
    if scores:
        entry["weightedOverallScore"] = scores.get("weighted_overall_score")
        entry["overallPriorityRating"] = scores.get("overall_priority_rating")
    if usage:
        entry["input_tokens"] = usage.get("input_tokens")
        entry["output_tokens"] = usage.get("output_tokens")
    if duration_ms is not None:
        entry["duration_ms"] = duration_ms
    if error:
        entry["error"] = error
    print(json.dumps(entry), flush=True)


def evaluate_with_model(model_config, prompt, context=None):
    context = context or {}
    provider = model_config["provider"]
    model = model_config["model"]

    logger.info("Calling %s/%s for quality eval", provider, model)
    start = time.perf_counter()
    raw_response, usage = call_llm(provider, model, prompt)
    duration_ms = int((time.perf_counter() - start) * 1000)
    logger.info("Received response from %s/%s (%d characters)", provider, model, len(raw_response))

    scores = parse_eval_response(raw_response)
    try:
        validate_eval(scores)
        logger.info("Eval result validated against schema")
    except jsonschema.ValidationError as e:
        logger.warning("Schema validation failed: %s", e.message)

    log_structured(
        STATUS_OK, provider, model, context.get("translationFileId", ""),
        document_id=context.get("documentId", ""),
        scores=scores, usage=usage, duration_ms=duration_ms,
    )

    return {
        "provider": provider,
        "model": model,
        "weightedOverallScore": scores["weighted_overall_score"],
        "overallPriorityRating": scores["overall_priority_rating"],
        # Full per-criterion detail — the editor add-on sidebar renders
        # strengths/issues/recommendations from this, and the combined file
        # and results rows are built from it once every model has finished.
        "scores": scores,
    }


def append_result_rows(translation_file_id, evaluations, result_location_id):
    """Append one results-sheet row per model, each linking the combined file.

    Runs after the combined file is written, so every row for a run points at
    the single combined result rather than a per-model file.
    """
    for e in evaluations:
        try:
            append_result_row(build_result_row(
                translation_file_id, e["provider"], e["model"], e["scores"], result_location_id
            ))
        except Exception:
            logger.exception("Failed to append result row for %s/%s", e["provider"], e["model"])


def build_combined_filename(translation_file_id):
    safe = translation_file_id.replace("/", "_")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{safe}_{timestamp}_combined_eval.json"


def write_combined_result(translation_file_id, document_id, content_hash, evaluations):
    """Write one file holding every model's full result, for the add-on to load.

    Stores content_hash (a fingerprint of the evaluated text, supplied by the
    caller) rather than the translation itself, so the add-on can detect a
    changed doc without the result file duplicating the whole translation.

    Returns the storage location id (Drive file id), or None when results are
    written locally (no Drive). The evaluations are returned inline in the
    response either way; the persisted file is what lets a later sidebar reopen
    reload this run from Drive without re-evaluating.
    """
    evaluated_at = datetime.now().isoformat()
    payload = {
        "translationFileId": translation_file_id,
        "documentId": document_id,
        "evaluatedAt": evaluated_at,
        "contentHash": content_hash,
        "evaluations": evaluations,
    }
    # Tag with the source doc so the add-on can query Drive for a doc's latest
    # result. Only set when there is a documentId (the add-on/inline path).
    properties = {"documentId": document_id, "evaluatedAt": evaluated_at} if document_id else None
    return write_eval_result(build_combined_filename(translation_file_id), payload, properties)


def normalize_inline_blocks(blocks, metadata=None):
    """Build a translation-JSON-shaped dict from inline blocks.

    Callers that already hold the text — e.g. the editor add-on sending the
    reviewer's current doc content — skip the Drive fetch entirely.
    """
    normalized = []
    for i, block in enumerate(blocks):
        original = (block.get("original_text") or "").strip()
        translated = (block.get("translated_text") or "").strip()
        if not original and not translated:
            continue
        normalized.append({
            "id": block.get("id") or f"b{i + 1:02d}",
            "original_text": original,
            "translated_text": translated,
        })

    if not normalized:
        raise ValueError("No non-empty blocks provided")

    return {"blocks": normalized, "metadata": metadata or {}}


def run_quality_eval(translation_file_id, translation_json=None, document_id=None):
    config = load_config()
    active_models = get_active_models(config, EVAL_ROLE)
    if not active_models:
        raise RuntimeError(f"No active models configured for role '{EVAL_ROLE}'")
    logger.info("Active eval models: %s", [m["model"] for m in active_models])

    if translation_json is None:
        translation_json = load_translation_json(translation_file_id)
    else:
        logger.info("Evaluating %d inline blocks", len(translation_json["blocks"]))

    rubric = load_doc(RUBRIC_DOC_ENV_VAR, RUBRIC_LOCAL_PATH_ENV_VAR)
    prompt = build_eval_prompt(rubric, translation_json)
    logger.info("Eval prompt assembled (%d characters)", len(prompt))

    # Run the models concurrently — each is a blocking LLM request, so the total
    # wait is the slowest model, not the sum. This matters: the editor add-on
    # blocks on this response. Results stay in active_models order regardless of
    # which model finishes first.
    context = {"translationFileId": translation_file_id, "documentId": document_id or ""}
    evaluations = [None] * len(active_models)
    with ThreadPoolExecutor(max_workers=len(active_models)) as executor:
        future_to_index = {
            executor.submit(evaluate_with_model, model_config, prompt, context): i
            for i, model_config in enumerate(active_models)
        }
        for future in as_completed(future_to_index):
            i = future_to_index[future]
            model_config = active_models[i]
            try:
                evaluations[i] = future.result()
            except Exception as e:
                logger.exception(
                    "Quality eval failed for %s/%s",
                    model_config["provider"], model_config["model"],
                )
                log_structured(
                    STATUS_FAILED, model_config["provider"], model_config["model"],
                    translation_file_id, document_id=document_id or "", error=str(e),
                )
                evaluations[i] = {
                    "provider": model_config["provider"],
                    "model": model_config["model"],
                    "error": str(e),
                }

    return evaluations


@functions_framework.http
def eval_quality(request):
    """Evaluate translation quality using LLM-as-judge.

    Accepts either:
      - {"translationJsonUrl": <Drive URL or file ID>} — scores the stored
        translation JSON, or
      - {"blocks": [{"id", "original_text", "translated_text"}, ...]} — scores
        the supplied text directly, used by the editor add-on to evaluate the
        reviewer's current doc content. Optional "documentId" and "metadata".
    """
    body = request.get_json(silent=True) or {}
    translation_json_url = body.get("translationJsonUrl")
    blocks = body.get("blocks")

    if not translation_json_url and not blocks:
        return json.dumps({
            "error": "Provide translationJsonUrl or blocks"
        }), HTTPStatus.BAD_REQUEST

    translation_json = None
    if blocks:
        # Label results by the source doc when there's no translation file.
        translation_file_id = body.get("documentId") or "inline"
        try:
            translation_json = normalize_inline_blocks(blocks, body.get("metadata"))
        except (ValueError, AttributeError, TypeError) as e:
            return json.dumps({"error": f"Invalid blocks: {e}"}), HTTPStatus.BAD_REQUEST
    else:
        try:
            translation_file_id = parse_drive_file_id(translation_json_url)
        except ValueError as e:
            return json.dumps({"error": str(e)}), HTTPStatus.BAD_REQUEST

    try:
        evaluations = run_quality_eval(translation_file_id, translation_json, body.get("documentId"))
    except Exception as e:
        logger.exception("Quality eval run failed")
        return json.dumps({"error": str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

    succeeded = [e for e in evaluations if "error" not in e]
    if not succeeded:
        return json.dumps({
            "error": "All eval models failed",
            "translationFileId": translation_file_id,
            "evaluations": evaluations,
        }), HTTPStatus.INTERNAL_SERVER_ERROR

    # Persist one combined file, tagged with the documentId, so a later sidebar
    # reopen can reload this run from Drive instead of re-evaluating. The
    # evaluations are also returned inline below for the immediate render.
    # None when written locally (no Drive) — reload-on-reopen is then unavailable.
    result_location_id = None
    try:
        result_location_id = write_combined_result(
            translation_file_id, body.get("documentId"), body.get("contentHash"), evaluations
        )
    except Exception:
        logger.exception("Failed to write combined result file")

    append_result_rows(translation_file_id, succeeded, result_location_id)

    status = "partial" if len(succeeded) < len(evaluations) else "ok"
    return json.dumps({
        "status": status,
        "translationFileId": translation_file_id,
        "resultLocationId": result_location_id,
        "evaluations": evaluations,
    }), HTTPStatus.OK
