"""LLM clients for the quality eval function.

Module names in this package are prefixed with `quality_` so they stay
distinct from the identically-purposed modules in other function directories
(e.g. `extract/llm.py`), which pytest places on the same flat `pythonpath`.
"""

import json
import logging
import os
from http import HTTPStatus
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent.parent / ".env")

import anthropic
import google.auth.exceptions
from google import genai
from google.genai import errors as genai_errors

logger = logging.getLogger(__name__)

PROVIDER_ANTHROPIC = "anthropic"
PROVIDER_GOOGLE = "google"

# Backends: Vertex AI (service account auth, no API keys) or the direct
# provider APIs (API keys from Secret Manager). LLM_BACKEND picks the order;
# vertex-first falls back to direct while the Vertex migration is verified.
BACKEND_VERTEX = "vertex"
BACKEND_DIRECT = "direct"
LLM_BACKEND_ENV_VAR = "LLM_BACKEND"
BACKEND_MODE_VERTEX_FIRST = "vertex-first"
BACKEND_ORDER = {
    BACKEND_MODE_VERTEX_FIRST: [BACKEND_VERTEX, BACKEND_DIRECT],
    "vertex-only": [BACKEND_VERTEX],
    "direct-only": [BACKEND_DIRECT],
}
VERTEX_PROJECT_ENV_VAR = "VERTEX_PROJECT_ID"
VERTEX_LOCATION_ENV_VAR = "VERTEX_LOCATION"
DEFAULT_VERTEX_LOCATION = "us"

# Fall back only on errors raised before any generation work (auth, model not
# enabled/available, quota). Timeouts, 5xx, and bad output are not retried on
# the other backend: they can come after minutes of work and would double
# cost and latency while hiding the real failure.
FALLBACK_STATUS_CODES = {
    HTTPStatus.UNAUTHORIZED,
    HTTPStatus.FORBIDDEN,
    HTTPStatus.NOT_FOUND,
    HTTPStatus.TOO_MANY_REQUESTS,
}

DEFAULT_MAX_TOKENS = 16384
# Cap each request so a stalled LLM call surfaces as an error the eval run can
# record, rather than hanging the (add-on-blocking) pipeline indefinitely.
LLM_TIMEOUT_SECONDS = 240

SCHEMA_DIR = Path(__file__).resolve().parent
SCHEMA_PATHS = {
    PROVIDER_ANTHROPIC: SCHEMA_DIR / "eval-schema-claude.json",
    PROVIDER_GOOGLE: SCHEMA_DIR / "eval-schema-gemini.json",
}


class VertexNotConfiguredError(RuntimeError):
    """VERTEX_PROJECT_ID is unset, so there's no Vertex project to call."""


def _vertex_settings():
    project = os.environ.get(VERTEX_PROJECT_ENV_VAR)
    if not project:
        raise VertexNotConfiguredError(f"{VERTEX_PROJECT_ENV_VAR} is not set")
    return project, os.environ.get(VERTEX_LOCATION_ENV_VAR, DEFAULT_VERTEX_LOCATION)


def make_claude_client(backend):
    if backend == BACKEND_VERTEX:
        project, location = _vertex_settings()
        return anthropic.AnthropicVertex(project_id=project, region=location, timeout=LLM_TIMEOUT_SECONDS)
    return anthropic.Anthropic(timeout=LLM_TIMEOUT_SECONDS)


def make_gemini_client(backend):
    # google-genai HttpOptions.timeout is in milliseconds.
    http_options = genai.types.HttpOptions(timeout=LLM_TIMEOUT_SECONDS * 1000)
    if backend == BACKEND_VERTEX:
        project, location = _vertex_settings()
        return genai.Client(vertexai=True, project=project, location=location, http_options=http_options)
    return genai.Client(api_key=os.environ.get("GEMINI_API_KEY"), http_options=http_options)


def fallback_reason(err):
    """Why this error justifies retrying on the direct API, or None if it doesn't."""
    if isinstance(err, VertexNotConfiguredError):
        return "vertex not configured"
    if isinstance(err, google.auth.exceptions.GoogleAuthError):
        return f"credentials: {type(err).__name__}"
    if isinstance(err, anthropic.APIStatusError) and err.status_code in FALLBACK_STATUS_CODES:
        return f"HTTP {err.status_code}: {type(err).__name__}"
    if isinstance(err, genai_errors.APIError) and err.code in FALLBACK_STATUS_CODES:
        return f"HTTP {err.code}: {err.status}"
    return None


def backend_order():
    mode = os.environ.get(LLM_BACKEND_ENV_VAR, BACKEND_MODE_VERTEX_FIRST)
    if mode not in BACKEND_ORDER:
        raise ValueError(f"Unknown {LLM_BACKEND_ENV_VAR}: {mode}")
    return BACKEND_ORDER[mode]


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


def call_claude(client, prompt, *, model="claude-opus-4-8", max_tokens=DEFAULT_MAX_TOKENS, output_schema=None):
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


def call_gemini(client, prompt, *, model="gemini-3.5-flash", output_schema=None):
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


def load_eval_schema(provider):
    path = SCHEMA_PATHS.get(provider)
    if not path:
        raise ValueError(f"No eval schema for provider: {provider}")
    return json.loads(path.read_text(encoding="utf-8"))


def call_llm(provider, model, prompt):
    """Call the provider, trying backends in LLM_BACKEND order; returns (text, usage).

    usage has input_tokens/output_tokens when the response carries them, plus
    llm_backend ("vertex" or "direct") and llm_fallback_reason when Vertex
    failed and the direct API answered.
    """
    output_schema = load_eval_schema(provider)
    # Built per call (not at import) so tests can patch the functions.
    provider_calls = {
        PROVIDER_ANTHROPIC: (make_claude_client, call_claude),
        PROVIDER_GOOGLE: (make_gemini_client, call_gemini),
    }
    if provider not in provider_calls:
        raise ValueError(f"Unknown provider: {provider}")
    make_client, call = provider_calls[provider]

    backends = backend_order()
    reason = None
    for i, backend in enumerate(backends):
        try:
            text, usage = call(make_client(backend), prompt, model=model, output_schema=output_schema)
        except Exception as err:
            reason = fallback_reason(err)
            is_last = i == len(backends) - 1
            if reason is None or is_last:
                raise
            logger.warning("%s via %s failed (%s); falling back to %s",
                           provider, backend, reason, backends[i + 1])
            continue
        usage["llm_backend"] = backend
        if reason:
            usage["llm_fallback_reason"] = reason
        return text, usage
