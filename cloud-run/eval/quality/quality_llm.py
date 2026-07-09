"""LLM clients for the quality eval function.

Module names in this package are prefixed with `quality_` so they stay
distinct from the identically-purposed modules in other function directories
(e.g. `extract/llm.py`), which pytest places on the same flat `pythonpath`.
"""

import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent.parent / ".env")

import anthropic
from google import genai

PROVIDER_ANTHROPIC = "anthropic"
PROVIDER_GOOGLE = "google"

DEFAULT_MAX_TOKENS = 16384

SCHEMA_DIR = Path(__file__).resolve().parent
SCHEMA_PATHS = {
    PROVIDER_ANTHROPIC: SCHEMA_DIR / "eval-schema-claude.json",
    PROVIDER_GOOGLE: SCHEMA_DIR / "eval-schema-gemini.json",
}


def call_claude(prompt, *, model="claude-opus-4-8", max_tokens=DEFAULT_MAX_TOKENS, output_schema=None):
    client = anthropic.Anthropic()

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
    return response.content[0].text


def call_gemini(prompt, *, model="gemini-3.5-flash", output_schema=None):
    client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

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
    return response.text


def load_eval_schema(provider):
    path = SCHEMA_PATHS.get(provider)
    if not path:
        raise ValueError(f"No eval schema for provider: {provider}")
    return json.loads(path.read_text())


def call_llm(provider, model, prompt):
    output_schema = load_eval_schema(provider)
    if provider == PROVIDER_ANTHROPIC:
        return call_claude(prompt, model=model, output_schema=output_schema)
    if provider == PROVIDER_GOOGLE:
        return call_gemini(prompt, model=model, output_schema=output_schema)
    raise ValueError(f"Unknown provider: {provider}")
