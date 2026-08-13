import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from http import HTTPStatus

import functions_framework
import jsonschema

from sacrebleu.metrics import BLEU
from rouge_score import rouge_scorer

from drift_llm import call_llm, load_judge_schema, PROVIDER_ANTHROPIC
from drift_loaders import (
    append_result_row,
    load_config,
    load_doc,
    load_golden_set,
    write_eval_result,
)

# The translation model under test generates candidates; the eval model judges
# them against the golden reference.
TRANSLATE_ROLE = "translate"
EVAL_ROLE = "eval"

TRANSLATION_PROMPT_DOC_ENV_VAR = "TRANSLATION_PROMPT_DOC_ID"
TRANSLATION_PROMPT_LOCAL_PATH_ENV_VAR = "LOCAL_TRANSLATION_PROMPT_PATH"
RUBRIC_DOC_ENV_VAR = "EVALUATION_RUBRIC_DOC_ID"
RUBRIC_LOCAL_PATH_ENV_VAR = "LOCAL_RUBRIC_PATH"

# Structured-log fields shared with the other pipeline stages (see extract's
# log_structured) so dashboards can query across stages by pipeline_stage.
PIPELINE_STAGE = "eval_drift"
STATUS_OK = "ok"
STATUS_FAILED = "failed"

# Regression thresholds. A golden example is flagged when the current model's
# candidate falls below any of these against the known-good reference. Override
# per-metric via env without a code change.
DEFAULT_BLEU_BASELINE = 30.0        # sacrebleu corpus BLEU, 0–100
DEFAULT_ROUGE_L_BASELINE = 0.40     # ROUGE-L F-measure, 0–1
DEFAULT_JUDGE_BASELINE = 3.0        # LLM-judge weighted overall, 0–5

# Golden examples within a model are scored concurrently — each is a couple of
# blocking LLM calls, so bounded parallelism keeps a weekly run to minutes, not
# tens of minutes, without hammering the provider rate limits.
DEFAULT_MAX_WORKERS = 4

# Rubric criteria, in the order they appear in the judge schema.
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


def get_baselines():
    """Regression thresholds, each overridable via a DRIFT_* env var."""
    return {
        "bleu": float(os.environ.get("DRIFT_BLEU_BASELINE", DEFAULT_BLEU_BASELINE)),
        "rougeL": float(os.environ.get("DRIFT_ROUGE_L_BASELINE", DEFAULT_ROUGE_L_BASELINE)),
        "judgeOverall": float(os.environ.get("DRIFT_JUDGE_BASELINE", DEFAULT_JUDGE_BASELINE)),
    }


def compute_bleu(hypotheses, references):
    """Compute BLEU score for a list of translations against references."""
    bleu = BLEU()
    result = bleu.corpus_score(hypotheses, [references])
    return {"score": result.score, "detail": str(result)}


def compute_rouge(hypothesis, reference):
    """Compute ROUGE scores for a single translation against a reference."""
    scorer = rouge_scorer.RougeScorer(["rouge1", "rouge2", "rougeL"], use_stemmer=True)
    scores = scorer.score(reference, hypothesis)
    return {key: {"precision": s.precision, "recall": s.recall, "fmeasure": s.fmeasure}
            for key, s in scores.items()}


def build_translation_prompt(base_prompt, source_language, target_language, source_text):
    """Ask the model under test to translate one golden source block.

    The production translation prompt is used as guidance so the candidate
    reflects the pipeline's intent, but we request a bare translation (no block
    JSON, no glossary injection) since drift scores a single source/reference
    pair at a time.
    """
    return (
        f"{base_prompt.rstrip()}\n\n"
        f"Translate the following text from {source_language} to {target_language}. "
        f"Return only the translated text, with no preamble, notes, or explanation.\n\n"
        f"<source>\n{source_text}\n</source>"
    )


def build_judge_prompt(rubric, example, candidate):
    """Reference-aware judge prompt: score the candidate, using the golden
    reference as the known-good comparison point."""
    source_language = example.get("source_language", "unknown")
    target_language = example.get("target_language", "unknown")
    return (
        f"{rubric.rstrip()}\n\n"
        f"Evaluate the CANDIDATE {source_language} to {target_language} translation below "
        f"against every criterion in the rubric above. A known-good REFERENCE translation "
        f"is provided for comparison — treat meaningful divergence from the reference's "
        f"meaning, accuracy, or quality as an issue.\n\n"
        f"<source>\n{example['source_text']}\n</source>\n\n"
        f"<reference_translation>\n{example['reference_translation']}\n</reference_translation>\n\n"
        f"<candidate_translation>\n{candidate}\n</candidate_translation>"
    )


def parse_eval_response(raw_response):
    match = MARKDOWN_JSON_PATTERN.search(raw_response)
    text = match.group(1) if match else raw_response
    return json.loads(text)


def validate_judge(data):
    schema = load_judge_schema(PROVIDER_ANTHROPIC)
    jsonschema.validate(instance=data, schema=schema)


def generate_candidate(model_config, base_prompt, example):
    """Run the model under test against a golden source, returning the candidate
    translation plus token usage and wall-clock duration."""
    provider = model_config["provider"]
    model = model_config["model"]
    prompt = build_translation_prompt(
        base_prompt, example.get("source_language", "unknown"),
        example.get("target_language", "unknown"), example["source_text"],
    )
    start = time.perf_counter()
    text, usage = call_llm(provider, model, prompt)
    duration_ms = int((time.perf_counter() - start) * 1000)
    return text.strip(), usage, duration_ms


def judge_candidate(model_config, rubric, example, candidate):
    """LLM-as-judge over the candidate vs the golden reference. Returns the
    same summary shape the quality eval uses, plus full per-criterion scores."""
    provider = model_config["provider"]
    model = model_config["model"]
    prompt = build_judge_prompt(rubric, example, candidate)
    schema = load_judge_schema(provider)
    raw_response, _usage = call_llm(provider, model, prompt, output_schema=schema)

    scores = parse_eval_response(raw_response)
    try:
        validate_judge(scores)
    except jsonschema.ValidationError as e:
        logger.warning("Judge result failed schema validation: %s", e.message)

    return {
        "provider": provider,
        "model": model,
        "weightedOverallScore": scores["weighted_overall_score"],
        "overallPriorityRating": scores["overall_priority_rating"],
        "scores": scores,
    }


def flag_regression(bleu_score, rouge_l_fmeasure, judge_overall, baselines):
    """Return (regressed, reasons) by comparing metrics to the baselines.

    judge_overall may be None when no eval model is active or the judge failed;
    the judge threshold is simply skipped in that case.
    """
    reasons = []
    if bleu_score < baselines["bleu"]:
        reasons.append(f"BLEU {bleu_score:.1f} < {baselines['bleu']}")
    if rouge_l_fmeasure < baselines["rougeL"]:
        reasons.append(f"ROUGE-L {rouge_l_fmeasure:.2f} < {baselines['rougeL']}")
    if judge_overall is not None and judge_overall < baselines["judgeOverall"]:
        reasons.append(f"Judge {judge_overall:.1f} < {baselines['judgeOverall']}")
    return bool(reasons), reasons


def log_structured(status, provider, model, example_id, *, bleu=None, rouge_l=None,
                   judge_overall=None, regressed=None, usage=None, duration_ms=None, error=""):
    """Emit one JSON log line per golden example so dashboards can trend metrics
    over time (mirrors extract/quality's log_structured)."""
    entry = {
        "severity": "ERROR" if status == STATUS_FAILED else "INFO",
        "message": f"drift eval {status} for {provider}/{model} on {example_id}",
        "pipeline_stage": PIPELINE_STAGE,
        "status": status,
        "provider": provider,
        "model": model,
        "goldenExampleId": example_id,
    }
    if bleu is not None:
        entry["bleu"] = round(bleu, 2)
    if rouge_l is not None:
        entry["rougeL"] = round(rouge_l, 4)
    if judge_overall is not None:
        entry["judgeWeightedOverall"] = judge_overall
    if regressed is not None:
        entry["regression"] = regressed
    if usage:
        entry["input_tokens"] = usage.get("input_tokens")
        entry["output_tokens"] = usage.get("output_tokens")
    if duration_ms is not None:
        entry["duration_ms"] = duration_ms
    if error:
        entry["error"] = error
    print(json.dumps(entry), flush=True)


def evaluate_example(translate_model, judge_model, base_prompt, rubric, example, baselines):
    """Full drift evaluation of one golden example against one model: generate a
    candidate, score it with BLEU/ROUGE and (optionally) the judge, and flag
    regressions. Raises on candidate-generation failure so the caller records it."""
    candidate, usage, duration_ms = generate_candidate(translate_model, base_prompt, example)

    bleu = compute_bleu([candidate], [example["reference_translation"]])
    rouge = compute_rouge(candidate, example["reference_translation"])
    rouge_f = {key: rouge[key]["fmeasure"] for key in rouge}

    judge = None
    if judge_model:
        try:
            judge = judge_candidate(judge_model, rubric, example, candidate)
        except Exception as e:
            logger.exception("Judge failed for example %s", example["id"])
            judge = {"error": str(e)}

    judge_overall = judge.get("weightedOverallScore") if judge and "error" not in judge else None
    regressed, reasons = flag_regression(bleu["score"], rouge_f["rougeL"], judge_overall, baselines)

    log_structured(
        STATUS_OK, translate_model["provider"], translate_model["model"], example["id"],
        bleu=bleu["score"], rouge_l=rouge_f["rougeL"], judge_overall=judge_overall,
        regressed=regressed, usage=usage, duration_ms=duration_ms,
    )

    return {
        "provider": translate_model["provider"],
        "model": translate_model["model"],
        "exampleId": example["id"],
        "sourceLanguage": example.get("source_language", "unknown"),
        "targetLanguage": example.get("target_language", "unknown"),
        "candidate": candidate,
        "bleu": bleu["score"],
        "rouge": rouge_f,
        "judge": judge,
        "regression": regressed,
        "regressionReasons": reasons,
    }


def _mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def aggregate_model(examples):
    """Summarize a model's per-example results into means and a regression count."""
    scored = [e for e in examples if "error" not in e]
    judge_overalls = [
        e["judge"]["weightedOverallScore"]
        for e in scored if e.get("judge") and "error" not in e["judge"]
    ]
    regressions = sum(1 for e in scored if e.get("regression"))
    return {
        "exampleCount": len(examples),
        "scoredCount": len(scored),
        "meanBleu": _mean([e["bleu"] for e in scored]),
        "meanRougeL": _mean([e["rouge"]["rougeL"] for e in scored]),
        "meanJudgeOverall": _mean(judge_overalls),
        "regressionCount": regressions,
        "regressed": regressions > 0,
    }


def run_drift_eval(trigger="manual"):
    """Run the golden set through every active translation model. Returns a
    payload dict (models + aggregates + baselines) ready to persist."""
    config = load_config()
    translate_models = get_active_models(config, TRANSLATE_ROLE)
    if not translate_models:
        raise RuntimeError(f"No active models configured for role '{TRANSLATE_ROLE}'")

    judge_models = get_active_models(config, EVAL_ROLE)
    judge_model = judge_models[0] if judge_models else None
    logger.info(
        "Drift eval: translate models=%s, judge=%s",
        [m["model"] for m in translate_models],
        judge_model["model"] if judge_model else None,
    )

    golden = load_golden_set()
    base_prompt = load_doc(TRANSLATION_PROMPT_DOC_ENV_VAR, TRANSLATION_PROMPT_LOCAL_PATH_ENV_VAR)
    rubric = load_doc(RUBRIC_DOC_ENV_VAR, RUBRIC_LOCAL_PATH_ENV_VAR) if judge_model else ""
    baselines = get_baselines()

    max_workers = int(os.environ.get("DRIFT_MAX_WORKERS", DEFAULT_MAX_WORKERS))
    model_results = []
    for translate_model in translate_models:
        examples_out = [None] * len(golden)
        with ThreadPoolExecutor(max_workers=min(max_workers, len(golden))) as pool:
            future_to_index = {
                pool.submit(evaluate_example, translate_model, judge_model,
                            base_prompt, rubric, example, baselines): i
                for i, example in enumerate(golden)
            }
            for future in as_completed(future_to_index):
                i = future_to_index[future]
                try:
                    examples_out[i] = future.result()
                except Exception as e:
                    logger.exception(
                        "Drift eval failed for %s/%s on example %s",
                        translate_model["provider"], translate_model["model"], golden[i]["id"],
                    )
                    log_structured(
                        STATUS_FAILED, translate_model["provider"], translate_model["model"],
                        golden[i]["id"], error=str(e),
                    )
                    examples_out[i] = {
                        "provider": translate_model["provider"],
                        "model": translate_model["model"],
                        "exampleId": golden[i]["id"],
                        "error": str(e),
                    }

        model_results.append({
            "provider": translate_model["provider"],
            "model": translate_model["model"],
            "aggregate": aggregate_model(examples_out),
            "examples": examples_out,
        })

    return {
        "trigger": trigger,
        "goldenSetSize": len(golden),
        "baselines": baselines,
        "models": model_results,
    }


def build_combined_filename():
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"drift_{timestamp}_eval.json"


def write_drift_result(payload):
    """Persist the full run (every model, every example) for the team to review.

    Returns the storage location id (Drive file id), or None when written
    locally (no Drive configured)."""
    stored = {"evaluatedAt": datetime.now().isoformat(), **payload}
    return write_eval_result(build_combined_filename(), stored)


def build_result_row(example_result, result_file_id):
    # Column order must match EVAL_RESULTS_SHEET_RANGE (A–N) in drift_loaders.
    judge = example_result.get("judge") or {}
    has_judge = "error" not in judge and "weightedOverallScore" in judge
    rouge = example_result["rouge"]
    return [
        datetime.now().strftime("%m/%d/%Y %H:%M"),
        example_result["exampleId"],
        example_result["provider"],
        example_result["model"],
        example_result.get("sourceLanguage", ""),
        example_result.get("targetLanguage", ""),
        round(example_result["bleu"], 2),
        round(rouge["rouge1"], 4),
        round(rouge["rouge2"], 4),
        round(rouge["rougeL"], 4),
        judge["weightedOverallScore"] if has_judge else "",
        judge["overallPriorityRating"] if has_judge else "",
        "YES" if example_result.get("regression") else "NO",
        result_file_id or "",
    ]


def append_result_rows(model_results, result_location_id):
    """Append one results-sheet row per scored golden example."""
    for model_result in model_results:
        for example_result in model_result["examples"]:
            if "error" in example_result:
                continue
            try:
                append_result_row(build_result_row(example_result, result_location_id))
            except Exception:
                logger.exception(
                    "Failed to append drift result row for %s/%s on %s",
                    example_result["provider"], example_result["model"],
                    example_result["exampleId"],
                )


def run_and_store(trigger):
    """Run the full drift eval and persist results (Drive file + sheet rows).

    Invoked on a background thread so the HTTP handler can return immediately —
    a golden-set run is many blocking LLM calls (minutes), which would otherwise
    time out the caller (Cloud Scheduler, or the Apps Script model-change trigger
    whose UrlFetchApp caps out well under a full run).
    """
    try:
        payload = run_drift_eval(trigger)
    except Exception:
        logger.exception("Drift eval run failed")
        return

    result_location_id = None
    try:
        result_location_id = write_drift_result(payload)
    except Exception:
        logger.exception("Failed to write drift result file")

    append_result_rows(payload["models"], result_location_id)
    logger.info(
        "Drift eval complete (trigger=%s): %d models over %d golden examples",
        trigger, len(payload["models"]), payload["goldenSetSize"],
    )


@functions_framework.http
def eval_drift(request):
    """Detect translation quality drift using NLP metrics and LLM-as-judge.

    Runs the golden set (GOLDEN_SET_SHEET_ID) through the active translation
    model(s), scores each candidate against its reference with BLEU/ROUGE and a
    reference-aware LLM judge, flags regressions against baseline thresholds, and
    stores results to Drive + the drift results sheet. Meant to be invoked on a
    cadence or on model-config change; the optional body {"trigger": "..."} just
    labels the run in logs and the stored result.

    Fire-and-forget: the eval runs on a background thread and the request returns
    202 immediately, so slow runs don't time out the caller. Deploy with CPU
    always allocated so the thread survives past the response (see Procfile).
    """
    body = request.get_json(silent=True) or {}
    trigger = body.get("trigger", "manual")

    thread = threading.Thread(target=run_and_store, args=(trigger,))
    thread.start()

    return json.dumps({"status": "accepted", "trigger": trigger}), HTTPStatus.ACCEPTED
