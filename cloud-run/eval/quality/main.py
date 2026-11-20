import hashlib
import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from http import HTTPStatus

import os

import functions_framework
import jsonschema

from quality_llm import call_llm, load_eval_schema, PROVIDER_ANTHROPIC
from quality_loaders import (
    EVAL_RESULT_DOCUMENT_PROPERTY,
    append_result_row,
    find_latest_eval_result,
    load_settings,
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

# Runs allowed on unchanged input (same text, models and rubric) per document:
# a high cap that protects against overuse; reviewers should rarely hit it.
# Editing the translation (or a rubric / model change) starts a new count.
# Set by eval_rerun_limit in the Settings tab; the env var overrides it (testing).
RERUN_LIMIT_ENV_VAR = "EVAL_RERUN_LIMIT"
DEFAULT_RERUN_LIMIT = 100
LIMIT_REACHED_MESSAGE = "Evaluation limit reached. Update the translation or rubric to run again."
# Over the pilot's block limit (yellow_max_blocks in the Settings tab): not evaluated
TOO_LARGE_MESSAGE = ("This translation has too many separate pieces of text to evaluate ({blocks}; the pilot "
                     "supports up to {limit}).")

MARKDOWN_JSON_PATTERN = re.compile(r"```(?:json)?\s*\n(.*?)\n\s*```", re.DOTALL)

if os.environ.get("K_SERVICE"):
    import google.cloud.logging
    google.cloud.logging.Client().setup_logging(log_level=logging.INFO)
else:
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
        # Which backend served the call (vertex/direct), and why Vertex was
        # skipped if it fell back — see quality_llm.call_llm.
        for key in ("llm_backend", "llm_fallback_reason", "model_retries"):
            if usage.get(key):
                entry[key] = usage[key]
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


def eval_key(content_hash, active_models, rubric):
    """What an evaluation depends on: the text (the add-on's content hash), the
    active eval models and the rubric. A saved result with the same key would
    get the same scores, so it's reused instead of calling the models again."""
    return {
        "contentHash": content_hash,
        "modelSet": sorted(f'{m["provider"]}/{m["model"]}' for m in active_models),
        "rubricHash": hashlib.sha256(rubric.encode("utf-8")).hexdigest(),
    }


def load_eval_inputs():
    """The active eval models and the rubric text."""
    config = load_config()
    active_models = get_active_models(config, EVAL_ROLE)
    if not active_models:
        raise RuntimeError(f"No active models configured for role '{EVAL_ROLE}'")
    return active_models, load_doc(RUBRIC_DOC_ENV_VAR, RUBRIC_LOCAL_PATH_ENV_VAR)


def rerun_limit(settings=None):
    """The rerun limit: EVAL_RERUN_LIMIT if set to a positive number (an
    override, e.g. for testing), else the Settings tab's eval_rerun_limit, else
    DEFAULT_RERUN_LIMIT."""
    raw = os.environ.get(RERUN_LIMIT_ENV_VAR)
    if raw:
        try:
            if int(raw) > 0:
                return int(raw)
        except ValueError:
            pass
        logger.warning("%s=%r isn't a positive number; ignoring it", RERUN_LIMIT_ENV_VAR, raw)
    return (settings or {}).get("eval_rerun_limit", DEFAULT_RERUN_LIMIT)


def latest_result(document_id):
    """The document's latest saved result, as (payload, file id), or None. Only
    the latest counts, since that's what the add-on shows. A lookup failure is
    logged and treated as no result, so the evaluation runs."""
    try:
        return find_latest_eval_result(document_id)
    except Exception:
        logger.exception("Couldn't look up the latest evaluation for %s; running it", document_id)
        return None


def runs_with_key(latest, key):
    """How many times this exact input (key) has been evaluated, per the latest
    result: its runsWithThisKey if the key matches (1 for a result saved before
    counts existed), else 0."""
    if not latest:
        return 0
    payload = latest[0]
    if any(payload.get(field) != value for field, value in key.items()):
        return 0
    return payload.get("runsWithThisKey", 1)


def all_models_succeeded(payload):
    evaluations = payload.get("evaluations") or []
    return bool(evaluations) and not any("error" in e for e in evaluations)


def write_combined_result(translation_file_id, document_id, content_hash, evaluations, key=None,
                          runs=1):
    """Write one file holding every model's full result, for the add-on to load.

    Stores content_hash (a fingerprint of the evaluated text, supplied by the
    caller) rather than the translation itself, so the add-on can detect a
    changed doc without the result file duplicating the whole translation.
    With key (see eval_key), also stores the model set and rubric hash, so a
    repeat request with the same key can reuse this result, and runs: how many
    times this key has been evaluated, counting this run (see RERUN_LIMIT).

    Returns the storage location id (Drive file id), or None when results are
    written locally (no Drive). The evaluations are returned inline in the
    response either way; the persisted file is what lets a later sidebar reopen
    reload this run from Drive without re-evaluating.
    """
    # With its UTC offset ("+00:00"): the add-on shows it in the viewer's time zone
    evaluated_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "translationFileId": translation_file_id,
        "documentId": document_id,
        "evaluatedAt": evaluated_at,
        "contentHash": content_hash,
        **({"modelSet": key["modelSet"], "rubricHash": key["rubricHash"], "runsWithThisKey": runs} if key else {}),
        "evaluations": evaluations,
    }
    # Tag with the source doc so the add-on can query Drive for a doc's latest
    # result. Only set when there is a documentId (the add-on/inline path).
    properties = {EVAL_RESULT_DOCUMENT_PROPERTY: document_id, "evaluatedAt": evaluated_at} if document_id else None
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


def run_quality_eval(translation_file_id, translation_json=None, document_id=None,
                     active_models=None, rubric=None):
    """Evaluate with every active model. active_models and rubric: already
    loaded by the caller (load_eval_inputs), or loaded here."""
    if active_models is None or rubric is None:
        active_models, rubric = load_eval_inputs()
    logger.info("Active eval models: %s", [m["model"] for m in active_models])

    if translation_json is None:
        translation_json = load_translation_json(translation_file_id)
    else:
        logger.info("Evaluating %d inline blocks", len(translation_json["blocks"]))

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
        reviewer's current doc content. Optional "documentId", "contentHash"
        and "metadata".

    With documentId and contentHash, each result records how many times the
    same input (text, active eval models, rubric) has been evaluated. With
    "skipIfUnchanged": true, unchanged input is answered from the latest saved
    result without calling the models ("cached": true, plus the saved
    "evaluatedAt"); without it, the models run. Either way, once the same
    input has run EVAL_RERUN_LIMIT times (default 100), the models aren't
    called again: the saved result comes back with "limitReached": true (or a
    429 if no model succeeded last time) until the input changes.
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
        settings = load_settings()
        # Rows with Spanish text: the same count as Translate's (translatable blocks),
        # so a document Translate accepted can always be evaluated
        block_count = sum(1 for b in translation_json["blocks"] if b["translated_text"])
        if block_count > settings["yellow_max_blocks"]:
            logger.warning("Not evaluating %s: %d blocks, over the limit of %d",
                           body.get("documentId"), block_count, settings["yellow_max_blocks"])
            return json.dumps({
                "error": TOO_LARGE_MESSAGE.format(blocks=block_count, limit=settings["yellow_max_blocks"]),
                "tooLarge": True,
            }), HTTPStatus.REQUEST_ENTITY_TOO_LARGE
    else:
        try:
            translation_file_id = parse_drive_file_id(translation_json_url)
        except ValueError as e:
            return json.dumps({"error": str(e)}), HTTPStatus.BAD_REQUEST

    document_id = body.get("documentId")
    content_hash = body.get("contentHash")
    active_models = rubric = key = None
    prior_runs = 0
    if blocks and document_id and content_hash:
        try:
            active_models, rubric = load_eval_inputs()
        except Exception as e:
            logger.exception("Quality eval setup failed")
            return json.dumps({"error": str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR
        key = eval_key(content_hash, active_models, rubric)
        latest = latest_result(document_id)
        prior_runs = runs_with_key(latest, key)
        if prior_runs:
            payload, location_id = latest
            limit_reached = prior_runs >= rerun_limit(settings)
            saved_scores = [e for e in payload.get("evaluations") or [] if "error" not in e]
            if limit_reached and not saved_scores:
                logger.warning("Evaluation limit reached for %s (%d runs); not calling the models",
                               document_id, prior_runs)
                return json.dumps({"error": LIMIT_REACHED_MESSAGE, "limitReached": True}), \
                    HTTPStatus.TOO_MANY_REQUESTS
            if limit_reached or (body.get("skipIfUnchanged") is True and all_models_succeeded(payload)):
                if limit_reached:
                    logger.warning("Evaluation limit reached for %s (%d runs); returning the saved result",
                                   document_id, prior_runs)
                else:
                    logger.info("Nothing changed since the evaluation of %s at %s; returning it without "
                                "calling the models", document_id, payload.get("evaluatedAt"))
                return json.dumps({
                    "status": "ok",
                    "cached": True,
                    "limitReached": limit_reached,
                    "evaluatedAt": payload.get("evaluatedAt"),
                    "translationFileId": translation_file_id,
                    "resultLocationId": location_id,
                    "evaluations": payload["evaluations"],
                }), HTTPStatus.OK

    try:
        evaluations = run_quality_eval(translation_file_id, translation_json, document_id,
                                       active_models=active_models, rubric=rubric)
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
            translation_file_id, document_id, content_hash, evaluations, key,
            runs=(prior_runs + 1) if key else 1,
        )
    except Exception:
        logger.exception("Failed to write combined result file")

    append_result_rows(translation_file_id, succeeded, result_location_id)

    status = "partial" if len(succeeded) < len(evaluations) else "ok"
    return json.dumps({
        "status": status,
        "cached": False,
        "limitReached": False,
        "translationFileId": translation_file_id,
        "resultLocationId": result_location_id,
        "evaluations": evaluations,
    }), HTTPStatus.OK
