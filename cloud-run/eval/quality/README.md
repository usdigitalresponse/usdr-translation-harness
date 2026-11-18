# Eval: Quality

LLM-as-judge quality evaluation of translations. Scores translations against a five-dimension rubric and returns per-block evaluations with strengths, issues, and recommendations.

## How it works

1. Receives either a translation JSON URL or inline blocks
   - With inline blocks, a `documentId` and a `contentHash`: if nothing has changed since the document's latest saved result, returns that result without calling the models (see "Skipping a repeat evaluation" below)
2. Builds an evaluation prompt using the rubric (dimensions and weights are defined in the prompt Google Doc)
3. Calls the LLM for evaluation
4. Validates the output against a JSON schema
5. Returns scored evaluations

## HTTP interface

Two input modes:

```
POST { translationJsonUrl }
→ 200 with evaluations (scores the stored translation JSON)

POST { blocks, documentId?, contentHash?, metadata?, skipIfUnchanged? }
→ 200 with evaluations (scores the provided blocks directly)
```

The Editor Add-on uses the second mode to evaluate the reviewer's current doc content (post-edits), not the stored JSON.

Responses include `"cached": true|false`. When `true`, the evaluations are the document's saved result (with its original `evaluatedAt`), not a new run.

## Skipping a repeat evaluation

Each evaluation calls every active eval model, so a repeat click on an unchanged document would bill them all again. The result depends on three things, saved with each result file:
- `contentHash`: the add-on's fingerprint of the English/Spanish table text
- `modelSet`: the active eval models (provider/model, sorted)
- `rubricHash`: a SHA-256 of the rubric text

Opt-in: when a blocks request has `"skipIfUnchanged": true` with a `documentId` and `contentHash`, the function looks up the document's **latest** saved result (the same Drive query the add-on uses). If all three match and every model succeeded, it returns that result: no model calls, no new results-sheet rows. Otherwise (text, models or rubric changed, a model failed last time, or a result saved before these fields existed) it runs as usual. Without the flag it always runs. A failed lookup is logged and the evaluation runs.

The add-on sends the flag on ↻ only. A cached response shows "Last updated <date>. No new changes. Running again may yield different results." with a "Run again anyway" link, which re-sends without the flag.

**Rerun limit:** each saved result also records `runsWithThisKey`, how many times that exact input (text, models, rubric) has been evaluated. Once it reaches `EVAL_RERUN_LIMIT` (optional env var, default 100), the models aren't called again for that input, with or without the flag: the saved result comes back with `"limitReached": true` (or a 429 with the same message if no model succeeded last time), and the sidebar shows "Evaluation limit reached. Update the translation or rubric to run again." Any change to the text, models or rubric starts a new count. A high cap to protect against overuse; reviewers shouldn't normally reach it. Runs where every model failed aren't saved, so they don't count.

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

Models come from the `Config` tab of the Model Config sheet (all columns, matched by header name) (`MODEL_CONFIG_SHEET_ID`). **Row 1 must be the header row** and include `Role`, `Provider`, `Model`, and `Active` (case-insensitive). Without `MODEL_CONFIG_SHEET_ID`, the service uses `fixtures/config.json` for local development, but **on Cloud Run a missing `MODEL_CONFIG_SHEET_ID` is an error** so a deploy that loses its env vars can't run on test models.

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

## Model call retries

The SDKs' own retries are off (Claude's default is 2 retries, including on timeouts, and each retry of a timed-out call is billed). Instead, every model call goes through `call_with_model_retry` in `quality_llm.py`:

- **Retried** (up to 2 times, waiting 5 s then 15 s): rate limit (429), overloaded (529), 502 / 503, and network errors, **only if the attempt failed within 30 s**. A slower failure may have happened mid-generation, which is already billed.
- **Not retried:** timeouts, other HTTP errors (400, 500…), and bad output.
- When a call needed retries, its log entry includes `model_retries`. `duration_ms` covers the whole call: fallback, retries and the waits between them.

The same rule is in each model-calling service's `llm` module.

## Dependencies

- **anthropic[vertex]** / **google-genai** — LLM provider SDKs (the `vertex` extra adds Claude-on-Vertex auth)
- **jsonschema** — validates LLM output structure
- **google-cloud-logging** — structured logging to Cloud Logging
- **googleapis / google-auth** — Google Drive API access
