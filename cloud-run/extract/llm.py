import base64
import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

import anthropic
from google import genai

PROVIDER_ANTHROPIC = "anthropic"
PROVIDER_GOOGLE = "google"
LLM_TIMEOUT_SECONDS = 240

SCHEMA_DIR = Path(__file__).resolve().parent
SCHEMA_PATHS = {
    PROVIDER_ANTHROPIC: SCHEMA_DIR / "extraction-schema-claude.json",
    PROVIDER_GOOGLE: SCHEMA_DIR / "extraction-schema-gemini.json",
}


def call_claude(prompt, *, model="claude-sonnet-4-6", max_tokens=16384, system=None, pdf_base64=None, output_schema=None):
    client = anthropic.Anthropic(timeout=LLM_TIMEOUT_SECONDS)
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
    return response.content[0].text


def call_gemini(prompt, *, model="gemini-3.5-flash", pdf_base64=None, output_schema=None):
    client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
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
    return response.text


def load_extraction_schema(provider):
    path = SCHEMA_PATHS.get(provider)
    if not path:
        raise ValueError(f"No extraction schema for provider: {provider}")
    return json.loads(path.read_text())


def call_llm(provider, model, prompt, pdf_base64):
    output_schema = load_extraction_schema(provider)
    if provider == PROVIDER_ANTHROPIC:
        return call_claude(prompt, model=model, pdf_base64=pdf_base64, output_schema=output_schema)
    if provider == PROVIDER_GOOGLE:
        return call_gemini(prompt, model=model, pdf_base64=pdf_base64, output_schema=output_schema)
    raise ValueError(f"Unknown provider: {provider}")
