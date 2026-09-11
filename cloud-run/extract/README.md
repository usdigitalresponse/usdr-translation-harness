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
POST { fileId, fileName, mimeType?, contentType?, submittedByEmail? }
→ 202 Accepted
```

Fire-and-forget: the function returns immediately and runs extraction on a background thread. The Pub/Sub message is the downstream signal that extraction is complete.

## Files

| File | Purpose |
|---|---|
| `main.py` | HTTP entrypoint, orchestration, Pub/Sub publishing |
| `llm.py` | LLM provider calls (Anthropic, Google AI) |
| `loaders.py` | Google Drive and config I/O, output writing |
| `extraction-schema-claude.json` | JSON schema for validating Claude extraction output |
| `extraction-schema-gemini.json` | JSON schema for validating Gemini extraction output |
| `requirements.txt` | Python dependencies |

## Dependencies

- **pdfplumber** — PDF text pre-extraction
- **python-docx** — DOCX text extraction
- **google-cloud-pubsub** — publishes extraction-complete messages
- **jsonschema** — validates LLM output structure
- **anthropic** / **google-generativeai** — LLM provider SDKs
