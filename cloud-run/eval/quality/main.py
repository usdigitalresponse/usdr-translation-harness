import json
import logging
import re
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


def build_result_filename(translation_file_id, model):
    safe_model = model.replace("/", "_")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{translation_file_id}_{safe_model}_{timestamp}_eval.json"


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


def evaluate_with_model(translation_file_id, model_config, prompt):
    provider = model_config["provider"]
    model = model_config["model"]

    logger.info("Calling %s/%s for quality eval", provider, model)
    raw_response = call_llm(provider, model, prompt)
    logger.info("Received response from %s/%s (%d characters)", provider, model, len(raw_response))

    scores = parse_eval_response(raw_response)
    try:
        validate_eval(scores)
        logger.info("Eval result validated against schema")
    except jsonschema.ValidationError as e:
        logger.warning("Schema validation failed: %s", e.message)

    result = {
        "translationFileId": translation_file_id,
        "provider": provider,
        "model": model,
        "evaluatedAt": datetime.now().isoformat(),
        "scores": scores,
    }
    filename = build_result_filename(translation_file_id, model)
    result_file_id = write_eval_result(filename, result)
    logger.info("Saved eval result: %s", filename)

    try:
        append_result_row(
            build_result_row(translation_file_id, provider, model, scores, result_file_id)
        )
    except Exception:
        logger.exception("Failed to append result row for %s/%s", provider, model)

    return {
        "provider": provider,
        "model": model,
        "weightedOverallScore": scores["weighted_overall_score"],
        "overallPriorityRating": scores["overall_priority_rating"],
        "resultFileId": result_file_id,
        "resultFileName": filename,
    }


def run_quality_eval(translation_file_id):
    config = load_config()
    active_models = get_active_models(config, EVAL_ROLE)
    if not active_models:
        raise RuntimeError(f"No active models configured for role '{EVAL_ROLE}'")
    logger.info("Active eval models: %s", [m["model"] for m in active_models])

    translation_json = load_translation_json(translation_file_id)
    rubric = load_doc(RUBRIC_DOC_ENV_VAR, RUBRIC_LOCAL_PATH_ENV_VAR)
    prompt = build_eval_prompt(rubric, translation_json)
    logger.info("Eval prompt assembled (%d characters)", len(prompt))

    evaluations = []
    for model_config in active_models:
        try:
            evaluations.append(evaluate_with_model(translation_file_id, model_config, prompt))
        except Exception as e:
            logger.exception(
                "Quality eval failed for %s/%s",
                model_config["provider"], model_config["model"],
            )
            evaluations.append({
                "provider": model_config["provider"],
                "model": model_config["model"],
                "error": str(e),
            })

    return evaluations


@functions_framework.http
def eval_quality(request):
    """Evaluate translation quality using LLM-as-judge."""
    body = request.get_json(silent=True) or {}
    translation_json_url = body.get("translationJsonUrl")

    if not translation_json_url:
        return json.dumps({"error": "Provide translationJsonUrl"}), HTTPStatus.BAD_REQUEST

    try:
        translation_file_id = parse_drive_file_id(translation_json_url)
    except ValueError as e:
        return json.dumps({"error": str(e)}), HTTPStatus.BAD_REQUEST

    try:
        evaluations = run_quality_eval(translation_file_id)
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

    status = "partial" if len(succeeded) < len(evaluations) else "ok"
    return json.dumps({
        "status": status,
        "translationFileId": translation_file_id,
        "evaluations": evaluations,
    }), HTTPStatus.OK
