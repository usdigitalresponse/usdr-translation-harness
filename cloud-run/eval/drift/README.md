# Eval: Drift

Regression detection for translation quality. Compares new translations against a golden translation set using NLP metrics (BLEU, ROUGE) and LLM-as-judge evaluation to flag quality drift.

## How it works

1. Triggered via HTTP POST
2. Loads the golden translation set from Google Drive
3. Computes BLEU and ROUGE scores comparing current translations against the golden set
4. Runs an LLM-as-judge evaluation on segments where metric scores indicate potential drift
5. Validates the output against a JSON schema
6. Returns drift analysis results

## HTTP interface

```
POST { trigger? }
→ 202 Accepted
```

Fire-and-forget: runs the drift analysis on a background thread.

## Files

| File | Purpose |
|---|---|
| `main.py` | HTTP entrypoint, metric computation, LLM judging |
| `drift_llm.py` | LLM provider calls (Anthropic, Google AI) |
| `drift_loaders.py` | Golden translation set and config I/O |
| `drift-schema-*.json` | JSON schemas for validating LLM output |
| `requirements.txt` | Python dependencies |

## Model call retries

The SDKs' own retries are off (Claude's default is 2 retries, including on timeouts, and each retry of a timed-out call is billed). Instead, every model call goes through `call_with_model_retry` in `drift_llm.py`:

- **Retried** (up to 2 times, waiting 5 s then 15 s): rate limit (429), overloaded (529), 502 / 503, and network errors, **only if the attempt failed within 30 s**. A slower failure may have happened mid-generation, which is already billed.
- **Not retried:** timeouts, other HTTP errors (400, 500…), and bad output.
- When a call needed retries, its log entry includes `model_retries`. `duration_ms` covers the whole call: fallback, retries and the waits between them.

The same rule is in each model-calling service's `llm` module.

## Dependencies

- **sacrebleu** — BLEU score computation
- **rouge-score** — ROUGE score computation
- **anthropic** / **google-genai** — LLM provider SDKs
- **jsonschema** — validates LLM output structure
