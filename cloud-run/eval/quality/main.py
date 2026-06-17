import functions_framework
import json


@functions_framework.http
def eval_quality(request):
    """Evaluate translation quality using LLM-as-judge."""
    body = request.get_json(silent=True) or {}
    translation_json_url = body.get("translationJsonUrl")

    if not translation_json_url:
        return json.dumps({"error": "Provide translationJsonUrl"}), 400

    # TODO: Load translation JSON from DRIVE_TRANSLATION_JSON_FOLDER_ID
    # TODO: Load evaluation rubric via load_doc("EVALUATION_RUBRIC_DOC_ID")
    # TODO: Read model config via load_config()
    # TODO: Call LLM with rubric for qualitative scoring
    # TODO: Store eval results to EVAL_QUALITY_RESULTS_SHEET_ID

    return json.dumps({
        "status": "ok",
        "message": "Eval Quality function placeholder",
        "scores": [],
    })
