# Plain Language Eval

Evaluates source documents for readability and plain language compliance using an LLM-as-judge. Runs alongside extraction when a document is submitted — it evaluates the *source* content, not the translation.

## How it works

1. Receives a document reference from the Orchestrator (same trigger as Extract)
2. Downloads and reads the source document from Google Drive
3. Sends the content to an LLM for plain language evaluation
4. Validates the output against a JSON schema
5. Writes the evaluation JSON to a dedicated Drive folder, tagged with a `plainLanguageEvalSourceFileId` Drive property set to the source file's ID

The Editor Add-on's plain language eval sidebar finds the result by querying for that property, using the `sourceFileId` from the translation JSON. Because it's a property query, not a folder search, results are still found after the archive sweep moves them. If the LLM returns invalid JSON, the raw output is still saved for debugging but is not tagged, so the sidebar never loads it.

## HTTP interface

```
POST { fileId, fileName, mimeType? }
→ 202 Accepted
```

Fire-and-forget: returns immediately and runs the evaluation on a background thread.

## Files

| File | Purpose |
|---|---|
| `index.js` | HTTP entrypoint, orchestration |
| `llm.js` | LLM provider calls (Claude, Gemini) via Vertex AI or the direct APIs |
| `loaders.js` | Google Drive and config I/O |
| `plain-language-schema-*.json` | JSON schemas for validating LLM output |

## LLM backends (Vertex AI migration in progress)

`callLlm` in `llm.js` can reach each provider two ways:

- **Vertex AI** — authenticates as the Cloud Run service account (`roles/aiplatform.user`); no API keys. Claude uses `AnthropicVertex` from `@anthropic-ai/vertex-sdk`; Gemini uses `@google/genai` with `vertexai: true`.
- **Direct** — the Anthropic API and Gemini Developer API, using `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`.

| Env var | Default | Meaning |
|---|---|---|
| `LLM_BACKEND` | `vertex-first` | `vertex-first` (fall back to direct), `vertex-only`, or `direct-only` |
| `VERTEX_PROJECT_ID` | — | GCP project for Vertex calls. If unset, `vertex-first` goes straight to direct |
| `VERTEX_LOCATION` | `us` | Vertex location (`us`, `global`, or a region) |

With `vertex-first`, a Vertex failure falls back to direct **only** for errors raised before generation: 401/403 (auth), 404 (model not enabled or not offered in the location), 429 (quota), missing default credentials, or missing `VERTEX_PROJECT_ID`. Timeouts, 5xx, and invalid output are raised as-is. Every successful call logs `llm_backend` (`vertex` / `direct`) and, after a fallback, `llm_fallback_reason` in the structured log entry. Tests: `cloud-run/tests/test_llm_backends.js`.

Model IDs in the Model Config sheet are the same for both backends.

## Dependencies

- **@anthropic-ai/sdk** / **@anthropic-ai/vertex-sdk** / **@google/genai** — LLM provider SDKs (the Vertex SDK adds Claude-on-Vertex auth)
- **googleapis** — Google Drive API access
- **http-status-codes** — standard HTTP status constants
