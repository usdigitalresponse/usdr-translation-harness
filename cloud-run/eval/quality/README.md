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
