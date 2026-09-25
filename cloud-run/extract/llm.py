import base64
import json
import logging
import os
import time
from http import HTTPStatus
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

import anthropic
import google.auth.exceptions
from google import genai
from google.genai import errors as genai_errors

logging.getLogger("google_genai.models").setLevel(logging.ERROR)
logger = logging.getLogger(__name__)

PROVIDER_ANTHROPIC = "anthropic"
PROVIDER_GOOGLE = "google"
LLM_TIMEOUT_SECONDS = 240

# Backends: Vertex AI (service account auth, no API keys) or the direct
# provider APIs (API keys from Secret Manager). LLM_BACKEND picks the order;
# vertex-first falls back to direct while the Vertex migration is verified.
BACKEND_VERTEX = "vertex"
BACKEND_DIRECT = "direct"
LLM_BACKEND_ENV_VAR = "LLM_BACKEND"
BACKEND_MODE_VERTEX_FIRST = "vertex-first"
BACKEND_MODE_VERTEX_ONLY = "vertex-only"
BACKEND_MODE_DIRECT_ONLY = "direct-only"
BACKEND_ORDER = {
    BACKEND_MODE_VERTEX_FIRST: [BACKEND_VERTEX, BACKEND_DIRECT],
    BACKEND_MODE_VERTEX_ONLY: [BACKEND_VERTEX],
    BACKEND_MODE_DIRECT_ONLY: [BACKEND_DIRECT],
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
    if backend == BACKEND_VERTEX:
        project, location = _vertex_settings()
        return genai.Client(vertexai=True, project=project, location=location)
    return genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))


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

SCHEMA_DIR = Path(__file__).resolve().parent
SCHEMA_PATHS = {
    PROVIDER_ANTHROPIC: SCHEMA_DIR / "extraction-schema-claude.json",
    PROVIDER_GOOGLE: SCHEMA_DIR / "extraction-schema-gemini.json",
}


def call_claude(client, prompt, *, model="claude-sonnet-4-6", max_tokens=65536, system=None, pdf_base64=None, output_schema=None):
    content = []

    if pdf_base64:
        content.append({
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_base64},
        })

    content.append({"type": "text", "text": prompt})

    kwargs = {"model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": content}]}
    if system:
        kwargs["system"] = system
    if output_schema:
        kwargs["output_config"] = {
            "format": {
                "type": "json_schema",
                "schema": output_schema,
            }
        }

    response = client.messages.create(**kwargs)
    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
    }
    text_block = next(b for b in response.content if b.type == "text")
    return text_block.text, usage


def call_gemini(client, prompt, *, model="gemini-3.5-flash", pdf_base64=None, output_schema=None):
    parts = []

    if pdf_base64:
        data = base64.b64decode(pdf_base64) if isinstance(pdf_base64, str) else pdf_base64
        parts.append(genai.types.Part.from_bytes(data=data, mime_type="application/pdf"))

    parts.append(genai.types.Part.from_text(text=prompt))

    kwargs = {"model": model, "contents": [genai.types.Content(role="user", parts=parts)]}
    if output_schema:
        kwargs["config"] = genai.types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=output_schema,
        )

    response = client.models.generate_content(**kwargs)
    usage_meta = response.usage_metadata
    usage = {
        "input_tokens": usage_meta.prompt_token_count,
        "output_tokens": usage_meta.candidates_token_count,
    }
    return response.text, usage


def load_extraction_schema(provider):
    path = SCHEMA_PATHS.get(provider)
    if not path:
        raise ValueError(f"No extraction schema for provider: {provider}")
    return json.loads(path.read_text())


def call_llm(provider, model, prompt, pdf_base64):
    """Call the provider, trying backends in LLM_BACKEND order.

    Returns (text, usage). usage includes duration_ms (total, across any
    fallback), llm_backend ("vertex" or "direct"), and llm_fallback_reason
    when Vertex failed and the direct API answered.
    """
    output_schema = load_extraction_schema(provider)
    # Built per call (not at import) so tests can patch the functions.
    provider_calls = {
        PROVIDER_ANTHROPIC: (make_claude_client, call_claude),
        PROVIDER_GOOGLE: (make_gemini_client, call_gemini),
    }
    if provider not in provider_calls:
        raise ValueError(f"Unknown provider: {provider}")
    make_client, call = provider_calls[provider]

    start = time.monotonic()
    backends = backend_order()
    reason = None
    for i, backend in enumerate(backends):
        try:
            text, usage = call(make_client(backend), prompt, model=model, pdf_base64=pdf_base64, output_schema=output_schema)
        except Exception as err:
            reason = fallback_reason(err)
            is_last = i == len(backends) - 1
            if reason is None or is_last:
                raise
            logger.warning("%s via %s failed (%s); falling back to %s",
                           provider, backend, reason, backends[i + 1])
            continue
        usage["duration_ms"] = round((time.monotonic() - start) * 1000)
        usage["llm_backend"] = backend
        if reason:
            usage["llm_fallback_reason"] = reason
        return text, usage
