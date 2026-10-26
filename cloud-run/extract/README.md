# Extract

Extracts structured text blocks from source documents (PDF, Google Docs, DOCX) for downstream translation.

## How it works

1. Receives a document reference from the Orchestrator
2. Downloads the file from Google Drive
3. For PDFs: pre-extracts text with pdfplumber, then sends pages + pre-extracted text to an LLM for structured block extraction. Scanned/image-based PDFs without an embedded text layer fall back to vision-only extraction.
4. For Google Docs / DOCX: extracts text directly (no LLM call needed)
5. Validates the output against a JSON schema
6. Writes the extraction JSON to Google Drive
7. Publishes a Pub/Sub message so the Translate function picks it up

## HTTP interface

```
POST { fileId, fileName, mimeType?, contentType?, submittedByEmail?, submittedByName? }
→ 202 Accepted
```

Fire-and-forget: the function returns immediately and runs extraction on a background thread. The Pub/Sub message is the downstream signal that extraction is complete; it carries `contentType`, `submittedByEmail`, and `submittedByName` through to Translate.

## Files

| File | Purpose |
|---|---|
| `main.py` | HTTP entrypoint, orchestration, Pub/Sub publishing |
| `llm.py` | LLM provider calls (Claude, Gemini) via Vertex AI or the direct APIs |
| `loaders.py` | Google Drive and config I/O, output writing |
| `extraction-schema-claude.json` | JSON schema for validating Claude extraction output |
| `extraction-schema-gemini.json` | JSON schema for validating Gemini extraction output |
| `requirements.txt` | Python dependencies |

## Model Config sheet

Models come from the `Config!A:E` range of the Model Config sheet (`MODEL_CONFIG_SHEET_ID`). **Row 1 must be the header row** and include `Role`, `Provider`, `Model`, and `Active` (case-insensitive). Without `MODEL_CONFIG_SHEET_ID`, the service uses `fixtures/config.json` for local development, but **on Cloud Run a missing `MODEL_CONFIG_SHEET_ID` is an error** so a deploy that loses its env vars can't run on test models.

Config problems (missing env var on Cloud Run, missing columns, no data rows) stop the run and log a structured **ERROR** with `input_problem: "model_config"` and a message starting `Extraction input problem (model_config):`. Missing columns are listed in `missing_columns`, with the headers found in `found_headers`.

## LLM backends (Vertex AI migration in progress)

`llm.call_llm` can reach each provider two ways:

- **Vertex AI** — authenticates as the Cloud Run service account (`roles/aiplatform.user`); no API keys. Claude uses `anthropic.AnthropicVertex`; Gemini uses `google-genai` with `vertexai=True`.
- **Direct** — the Anthropic API and Gemini Developer API, using `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`.

| Env var | Default | Meaning |
|---|---|---|
| `LLM_BACKEND` | `vertex-first` | `vertex-first` (fall back to direct), `vertex-only`, or `direct-only` |
| `VERTEX_PROJECT_ID` | — | GCP project for Vertex calls. If unset, `vertex-first` goes straight to direct |
| `VERTEX_LOCATION` | `us` | Vertex location (`us`, `global`, or a region) |

With `vertex-first`, a Vertex failure falls back to direct **only** for errors raised before generation: 401/403 (auth), 404 (model not enabled or not offered in the location), 429 (quota), credential errors, or missing `VERTEX_PROJECT_ID`. Timeouts, 5xx, and invalid output are raised as-is. Every successful call logs `llm_backend` (`vertex` / `direct`) and, after a fallback, `llm_fallback_reason` in the structured log entry.

Model IDs in the Model Config sheet are the same for both backends.

## Dependencies

- **pdfplumber** — PDF text pre-extraction
- **python-docx** — DOCX text extraction
- **google-cloud-pubsub** — publishes extraction-complete messages
- **jsonschema** — validates LLM output structure
- **anthropic[vertex]** / **google-genai** — LLM provider SDKs (the `vertex` extra adds Claude-on-Vertex auth)
