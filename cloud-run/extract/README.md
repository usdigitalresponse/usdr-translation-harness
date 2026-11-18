# Extract

Extracts structured text blocks from source documents (PDF, Google Docs, DOCX) for downstream translation.

## How it works

1. Receives a document reference from the Orchestrator
2. Downloads the file from Google Drive
3. For PDFs: pre-extracts text with pdfplumber, then sends pages + pre-extracted text to an LLM for structured block extraction. Scanned/image-based PDFs without an embedded text layer fall back to vision-only extraction.
4. For Google Docs / DOCX: reads the text directly (no LLM call needed), one block per paragraph. See "What's read from Google Docs and Word files" below
5. Validates the output against a JSON schema
6. Writes the extraction JSON to Google Drive
7. Publishes a Pub/Sub message so the Translate function picks it up

## What's read from Google Docs and Word files

Both formats read the same parts (`document_text.py`), so a document gives the same blocks either way. Google Docs are read through the Docs API (`documents.get` with every tab and without pending suggestions), not Drive's plain-text export, which includes comments and footnote markers.

**Read**
- Body paragraphs, in order, one block each. A line break inside a paragraph (Shift+Enter) stays inside its block, so lines like an address are translated together
- Tables: row by row, each cell's paragraphs in order (a block each); a merged cell once; tables inside cells
- Google Docs: every tab, in order (child tabs after their parent)
- Google Docs smart chips, as displayed: people (name, or email if no name is shown), file and link chips (title), dates, dropdowns (the selected option)
- Word: content controls (dropdowns, date pickers, text controls) as displayed, field results (e.g. an inserted date), hyperlink text
- The document **as it currently stands**: pending suggestions (Google Docs) and tracked changes (Word) are ignored, so suggested insertions are left out and suggested deletions are kept. Accept or reject them before submitting

**Not read**
- Comments
- Headers, footers, footnotes (and footnote markers)
- Text boxes, drawings, equations, images
- Table of contents (it repeats the headings), Google Docs tab titles

A Google Doc element the reader doesn't recognize is logged as a warning ("Google Doc paragraph element not read"), so a new kind of chip shows up in the logs instead of disappearing silently.

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
| `document_text.py` | Text of Google Docs (Docs API) and Word files: what's read and what isn't |
| `failure_reasons.py` | Plain-language failure reasons for the Chat notice |
| `notifier.py` | Google Chat notice when nothing goes on to Translate |
| `extraction-schema-claude.json` | JSON schema for validating Claude extraction output |
| `extraction-schema-gemini.json` | JSON schema for validating Gemini extraction output |
| `requirements.txt` | Python dependencies |

## Model Config sheet

Models come from the `Config` tab of the Model Config sheet (all columns, matched by header name) (`MODEL_CONFIG_SHEET_ID`). **Row 1 must be the header row** and include `Role`, `Provider`, `Model`, and `Active` (case-insensitive). Without `MODEL_CONFIG_SHEET_ID`, the service uses `fixtures/config.json` for local development, but **on Cloud Run a missing `MODEL_CONFIG_SHEET_ID` is an error** so a deploy that loses its env vars can't run on test models.

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

## Failures

Extract runs after it has already replied 202, so the Orchestrator never sees
these failures. Each one is recorded and none is retried:

- **Processing Log:** a `failed` row with the real error, e.g. `LLM call failed:
  APITimeoutError: Request timed out.` (cut to 500 characters). Also written for
  no active extract models and for a failed Pub/Sub hand-off to Translate.
- **Chat**, only when nothing goes on to Translate (so the submitter would
  otherwise hear nothing): every model failed, a Google Doc / Word file couldn't
  be read or saved, a setup problem (config, prompt doc, PDF download), no active
  models, an unsupported file type, or every hand-off failed. If one model
  succeeds, no notice. The message gives a plain-language reason (one line per
  model if they failed differently), worked out from the error's type or status
  in `failure_reasons.py`:

  ```
  ⚠️ Translation failed for *flyer.pdf* while reading the document. It won't be retried automatically.
  *Reason:* The extraction model in Model Config wasn't found. Check the model name.
  Contact your workflow owner. Full details are in the Processing Log.
  ```

  Posted to `GOOGLE_CHAT_WEBHOOK_URL` (the same translators' space and secret as
  Translate). If it's unset, Extract logs a warning and skips the notice.

## Model call retries

The SDKs' own retries are off (Claude's default is 2 retries, including on timeouts, and each retry of a timed-out call is billed). Instead, every model call goes through `call_with_model_retry` in `llm.py`:

- **Retried** (up to 2 times, waiting 5 s then 15 s): rate limit (429), overloaded (529), 502 / 503, and network errors, **only if the attempt failed within 30 s**. A slower failure may have happened mid-generation, which is already billed.
- **Not retried:** timeouts, other HTTP errors (400, 500…), and bad output.
- When a call needed retries, its log entry includes `model_retries`. `duration_ms` covers the whole call: fallback, retries and the waits between them.

The same rule is in each model-calling service's `llm` module.

## Dependencies

- **pdfplumber** — PDF text pre-extraction
- **python-docx** — DOCX text extraction
- **google-cloud-pubsub** — publishes extraction-complete messages
- **jsonschema** — validates LLM output structure
- **anthropic[vertex]** / **google-genai** — LLM provider SDKs (the `vertex` extra adds Claude-on-Vertex auth)
