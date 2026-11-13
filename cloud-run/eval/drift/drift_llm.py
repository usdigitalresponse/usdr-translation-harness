"""LLM clients for the drift eval function.

Module names in this package are prefixed with `drift_` so they stay distinct
from the identically-purposed modules in other function directories (e.g.
`quality/quality_llm.py`, `extract/llm.py`), which pytest places on the same
flat `pythonpath`.

Drift makes two kinds of call: a plain-text *translation* to generate a
candidate from a golden source (no schema), and a schema-constrained
*judge* call that scores the candidate against the reference translation.
"""

import json
import logging
import os
import time
from http import HTTPStatus
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent.parent / ".env")

import anthropic
import httpx  # used by both model SDKs (a dependency of each)
from google import genai
from google.genai import errors as genai_errors

logger = logging.getLogger(__name__)

PROVIDER_ANTHROPIC = "anthropic"
PROVIDER_GOOGLE = "google"

DEFAULT_MAX_TOKENS = 16384
# Cap each request so a stalled LLM call surfaces as an error the drift run can
# record, rather than hanging a scheduled job indefinitely.
LLM_TIMEOUT_SECONDS = 240


# ── Retrying model calls ──────────────────────────────────────────────────
# The SDKs' own retries are off (Claude's default is 2, including timeouts;
# google-genai doesn't retry unless configured). Instead, one rule for every
# model call: retry only temporary errors that fail fast (rate limit, overload,
# connection refused), when the model hasn't generated anything yet. Never retry
# a timeout or anything slow: that call has already been billed and would just
# run out of time again.
CLAUDE_MAX_RETRIES = 0
MODEL_RETRIES = 2
MODEL_RETRY_BASE_DELAY_SECONDS = 5   # 5 s, then 15 s
MODEL_RETRY_BACKOFF = 3
# A failure slower than this may have happened mid-generation (billed), so it isn't retried
MODEL_RETRY_FAST_FAILURE_SECONDS = 30
ANTHROPIC_OVERLOADED = 529  # no HTTPStatus name
MODEL_RETRY_STATUS_CODES = {
    HTTPStatus.TOO_MANY_REQUESTS,
    HTTPStatus.BAD_GATEWAY,
    HTTPStatus.SERVICE_UNAVAILABLE,
    ANTHROPIC_OVERLOADED,
}


def model_retry_reason(err):
    """Why a failed model call is worth retrying, or None if it isn't.

    Timeouts are checked first: anthropic.APITimeoutError is a subclass of
    APIConnectionError, and httpx's connect timeout is a TimeoutException.
    """
    if isinstance(err, (anthropic.APITimeoutError, httpx.TimeoutException)):
        return None
    status = getattr(err, "status_code", None) if isinstance(err, anthropic.APIStatusError) else None
    if isinstance(err, genai_errors.APIError):
        status = err.code
    if status in MODEL_RETRY_STATUS_CODES:
        return f"HTTP {status}"
    if isinstance(err, (anthropic.APIConnectionError, httpx.NetworkError, httpx.RemoteProtocolError)):
        return f"connection error ({type(err).__name__})"
    return None


def call_with_model_retry(fn, *, retries=MODEL_RETRIES, base_delay=MODEL_RETRY_BASE_DELAY_SECONDS,
                          sleep=None, clock=None):
    """Run a model call, retrying (up to `retries` times, with backoff) only
    when it fails fast with a temporary error. Anything else is raised as is.
    sleep and clock are parameters for tests (default: time.sleep, time.monotonic)."""
    sleep = sleep or time.sleep
    clock = clock or time.monotonic
    attempt = 0
    while True:
        started = clock()
        try:
            return fn()
        except Exception as err:
            reason = model_retry_reason(err)
            fast = clock() - started < MODEL_RETRY_FAST_FAILURE_SECONDS
            if reason is None or not fast or attempt >= retries:
                raise
            delay = base_delay * MODEL_RETRY_BACKOFF ** attempt
            logger.warning("Model call failed (%s); retry %d of %d in %ds", reason, attempt + 1, retries, delay)
            sleep(delay)
            attempt += 1

SCHEMA_DIR = Path(__file__).resolve().parent
SCHEMA_PATHS = {
    PROVIDER_ANTHROPIC: SCHEMA_DIR / "drift-schema-claude.json",
    PROVIDER_GOOGLE: SCHEMA_DIR / "drift-schema-gemini.json",
}


def _claude_usage(response):
    usage = getattr(response, "usage", None)
    if not usage:
        return {}
    return {
        "input_tokens": getattr(usage, "input_tokens", None),
        "output_tokens": getattr(usage, "output_tokens", None),
    }


def _gemini_usage(response):
    meta = getattr(response, "usage_metadata", None)
    if not meta:
        return {}
    return {
        "input_tokens": getattr(meta, "prompt_token_count", None),
        "output_tokens": getattr(meta, "candidates_token_count", None),
    }


def call_claude(prompt, *, model="claude-opus-4-8", max_tokens=DEFAULT_MAX_TOKENS, output_schema=None):
    client = anthropic.Anthropic(timeout=LLM_TIMEOUT_SECONDS, max_retries=CLAUDE_MAX_RETRIES)

    kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if output_schema:
        kwargs["output_config"] = {
            "format": {
                "type": "json_schema",
                "schema": output_schema,
            }
        }

    response = client.messages.create(**kwargs)
    text_block = next(b for b in response.content if b.type == "text")
    return text_block.text, _claude_usage(response)


def call_gemini(prompt, *, model="gemini-3.5-flash", output_schema=None):
    # google-genai HttpOptions.timeout is in milliseconds.
    client = genai.Client(
        api_key=os.environ.get("GEMINI_API_KEY"),
        http_options=genai.types.HttpOptions(timeout=LLM_TIMEOUT_SECONDS * 1000),
    )

    kwargs = {
        "model": model,
        "contents": [genai.types.Content(role="user", parts=[genai.types.Part.from_text(text=prompt)])],
    }
    if output_schema:
        kwargs["config"] = genai.types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=output_schema,
        )

    response = client.models.generate_content(**kwargs)
    return response.text, _gemini_usage(response)


def load_judge_schema(provider):
    path = SCHEMA_PATHS.get(provider)
    if not path:
        raise ValueError(f"No judge schema for provider: {provider}")
    return json.loads(path.read_text(encoding="utf-8"))


def _call_llm_once(provider, model, prompt, output_schema=None):
    """Dispatch to the provider client, returning (text, usage).

    Pass output_schema to constrain the response to the judge schema; omit it
    (the default) for the plain-text candidate translation. usage is a dict
    with input_tokens/output_tokens (or empty when the response carries none).
    """
    if provider == PROVIDER_ANTHROPIC:
        return call_claude(prompt, model=model, output_schema=output_schema)
    if provider == PROVIDER_GOOGLE:
        return call_gemini(prompt, model=model, output_schema=output_schema)
    raise ValueError(f"Unknown provider: {provider}")


def call_llm(provider, model, prompt, output_schema=None):
    """Dispatch to the provider client, retrying fast, temporary failures.
    Returns (text, usage); see _call_llm_once."""
    return call_with_model_retry(lambda: _call_llm_once(provider, model, prompt, output_schema))
