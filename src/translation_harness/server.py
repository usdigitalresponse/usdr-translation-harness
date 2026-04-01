import os
import sys
import anthropic
from dotenv import load_dotenv
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
from opentelemetry.sdk.resources import Resource, SERVICE_NAME
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from fastmcp import FastMCP
from fastmcp.server.middleware import Middleware

load_dotenv()


def setup_observability():
    """Configure OpenTelemetry tracing.

    Ships traces to Honeycomb if HONEYCOMB_API_KEY is set, otherwise prints to stderr.
    To view local traces: tail -f ~/Library/Logs/Claude/mcp-server-translation-harness.log
    Or go to Claude Desktop > Settings > Developer > click the server > "View logs"
    """
    honeycomb_api_key = os.getenv("HONEYCOMB_API_KEY")
    if honeycomb_api_key:
        exporter = OTLPSpanExporter(
            endpoint="https://api.honeycomb.io/v1/traces",
            headers={
                "x-honeycomb-team": honeycomb_api_key,
                "x-honeycomb-dataset": "translation-harness",
            },
        )
    else:
        exporter = ConsoleSpanExporter(out=sys.stderr)

    provider = TracerProvider(resource=Resource({SERVICE_NAME: "translation-harness"}))
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)


setup_observability()
mcp = FastMCP("translation-harness")


class TokenEstimationMiddleware(Middleware):
    """Estimates token usage per tool call and attaches counts to OTel spans.

    Enable by setting ENABLE_TOKEN_ESTIMATION=true in your environment.
    Estimates are approximate — they only count the tool arguments and result,
    not the full conversation context Claude sees.
    """

    def __init__(self):
        self.client = anthropic.Anthropic()

    async def on_call_tool(self, context, call_next):
        # Claude models all use the same tokenizer, so the model param doesn't
        # affect the count — any current Claude model ID works here.
        model = "claude-sonnet-4-6"

        input_tokens = self.client.messages.count_tokens(
            model=model,
            messages=[{"role": "user", "content": str(context.message)}]
        )

        result = await call_next(context)

        output_tokens = self.client.messages.count_tokens(
            model=model,
            messages=[{"role": "user", "content": str(result)}]
        )

        span = trace.get_current_span()
        span.set_attribute("tool.input_tokens_estimate", input_tokens.input_tokens)
        span.set_attribute("tool.output_tokens_estimate", output_tokens.input_tokens)

        return result


# Uncomment to enable token estimation (requires ANTHROPIC_API_KEY to be set):
# if os.getenv("ENABLE_TOKEN_ESTIMATION"):
#     mcp.add_middleware(TokenEstimationMiddleware())


@mcp.tool()
def ping() -> str:
    """Check that the translation harness MCP server is running."""
    return "Translation harness MCP server is running!"


if __name__ == "__main__":
    mcp.run()
