# Plain Language Eval

Evaluates source documents for readability and plain language compliance using an LLM-as-judge. Runs alongside extraction when a document is submitted — it evaluates the *source* content, not the translation.

## How it works

1. Receives a document reference from the Orchestrator (same trigger as Extract)
2. Downloads and reads the source document from Google Drive
3. Sends the content to an LLM for plain language evaluation
4. Validates the output against a JSON schema
5. Writes the evaluation JSON to a dedicated Drive folder

The Editor Add-on's plain language eval sidebar looks up the result by matching the source filename in the eval output folder.

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
| `llm.js` | LLM provider calls (Anthropic, Google AI) |
| `loaders.js` | Google Drive and config I/O |
| `plain-language-schema-*.json` | JSON schemas for validating LLM output |

## Dependencies

- **@anthropic-ai/sdk** / **@google/genai** — LLM provider SDKs
- **googleapis** — Google Drive API access
- **http-status-codes** — standard HTTP status constants
