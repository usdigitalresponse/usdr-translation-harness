# Eval: Quality

LLM-as-judge quality evaluation of translations. Scores translations against a five-dimension rubric and returns per-block evaluations with strengths, issues, and recommendations.

## How it works

1. Receives either a translation JSON URL or inline blocks
2. Builds an evaluation prompt using the rubric (dimensions and weights are defined in the prompt Google Doc)
3. Calls the LLM for evaluation
4. Validates the output against a JSON schema
5. Returns scored evaluations

## HTTP interface

Two input modes:

```
POST { translationJsonUrl }
→ 200 with evaluations (scores the stored translation JSON)

POST { blocks, documentId?, metadata? }
→ 200 with evaluations (scores the provided blocks directly)
```

The Editor Add-on uses the second mode to evaluate the reviewer's current doc content (post-edits), not the stored JSON.

## Files

| File | Purpose |
|---|---|
| `main.py` | HTTP entrypoint, prompt building, response parsing |
| `quality_llm.py` | LLM provider calls (Claude, Gemini) via Vertex AI or the direct APIs |
| `quality_loaders.py` | Google Drive and config I/O |
| `eval-schema-*.json` | JSON schemas for validating LLM output |
| `requirements.txt` | Python dependencies |

## Results sheet

Each model's scores are appended to the `EvalQuality` tab of `EVAL_QUALITY_RESULTS_SHEET_ID` (columns A–L). Column B, **Document ID**, is the output Google Doc's ID for evaluations run from the add-on (almost all of them). For runs started with a `translationJsonUrl`, it holds the translation JSON's ID instead. To find a doc's scores, search column B for the ID in the doc's URL.

## Model Config sheet

Models come from the `Config!A:E` range of the Model Config sheet (`MODEL_CONFIG_SHEET_ID`). **Row 1 must be the header row** and include `Role`, `Provider`, `Model`, and `Active` (case-insensitive). Without `MODEL_CONFIG_SHEET_ID`, the service uses `fixtures/config.json` for local development, but **on Cloud Run a missing `MODEL_CONFIG_SHEET_ID` is an error** so a deploy that loses its env vars can't run on test models.

Config problems (missing env var on Cloud Run, missing columns, no data rows) stop the run and log a structured **ERROR** with `input_problem: "model_config"` and a message starting `Quality eval input problem (model_config):`. Missing columns are listed in `missing_columns`, with the headers found in `found_headers`.

## LLM backends (Vertex AI migration in progress)

`quality_llm.call_llm` can reach each provider two ways:

- **Vertex AI** — authenticates as the Cloud Run service account (`roles/aiplatform.user`); no API keys. Claude uses `anthropic.AnthropicVertex`; Gemini uses `google-genai` with `vertexai=True`.
- **Direct** — the Anthropic API and Gemini Developer API, using `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`.

| Env var | Default | Meaning |
|---|---|---|
| `LLM_BACKEND` | `vertex-first` | `vertex-first` (fall back to direct), `vertex-only`, or `direct-only` |
| `VERTEX_PROJECT_ID` | — | GCP project for Vertex calls. If unset, `vertex-first` goes straight to direct |
| `VERTEX_LOCATION` | `us` | Vertex location (`us`, `global`, or a region) |

With `vertex-first`, a Vertex failure falls back to direct **only** for errors raised before generation: 401/403 (auth), 404 (model not enabled or not offered in the location), 429 (quota), credential errors, or missing `VERTEX_PROJECT_ID`. Timeouts, 5xx, and invalid output are raised as-is. Every successful call logs `llm_backend` (`vertex` / `direct`) and, after a fallback, `llm_fallback_reason` in the structured log entry.

## Dependencies

- **anthropic[vertex]** / **google-genai** — LLM provider SDKs (the `vertex` extra adds Claude-on-Vertex auth)
- **jsonschema** — validates LLM output structure
- **google-cloud-logging** — structured logging to Cloud Logging
- **googleapis / google-auth** — Google Drive API access
