"""The shared retry rule for model calls (call_with_model_retry), in each
Python service: retry fast, temporary errors only; never timeouts."""

from http import HTTPStatus
from unittest.mock import MagicMock, patch

import anthropic
import pytest

try:
    import httpx2 as httpx  # anthropic 2.x / google-genai 3.x
except ImportError:
    import httpx  # older SDK versions
from google.genai import errors as genai_errors

import drift_llm
import quality_llm
from extract import llm as extract_llm

MODULES = [extract_llm, quality_llm, drift_llm]
REQUEST = httpx.Request("POST", "https://example.test")


def anthropic_status(status):
    response = httpx.Response(status, request=REQUEST)
    return anthropic.APIStatusError("error", response=response, body=None)


def gemini_status(code):
    return genai_errors.APIError(code, {"error": {"message": "error", "status": "X"}})


RETRY = [
    ("Claude rate limit", lambda: anthropic_status(HTTPStatus.TOO_MANY_REQUESTS), "HTTP 429"),
    ("Claude overloaded", lambda: anthropic_status(529), "HTTP 529"),
    ("Gemini unavailable", lambda: gemini_status(HTTPStatus.SERVICE_UNAVAILABLE), "HTTP 503"),
    ("Claude connection error", lambda: anthropic.APIConnectionError(request=REQUEST), "connection error"),
    ("Gemini connection refused", lambda: httpx.ConnectError("refused"), "connection error"),
]
NO_RETRY = [
    ("Claude timeout (a connection error subclass)", lambda: anthropic.APITimeoutError(request=REQUEST)),
    ("Gemini read timeout", lambda: httpx.ReadTimeout("timed out")),
    ("bad request", lambda: anthropic_status(HTTPStatus.BAD_REQUEST)),
    ("internal error", lambda: gemini_status(HTTPStatus.INTERNAL_SERVER_ERROR)),
    ("invalid output", lambda: ValueError("LLM returned invalid JSON")),
]


@pytest.mark.parametrize("module", MODULES, ids=lambda m: m.__name__)
class TestModelRetry:
    @pytest.mark.parametrize("label,make_err,reason", RETRY, ids=[r[0] for r in RETRY])
    def test_retries(self, module, label, make_err, reason):
        assert module.model_retry_reason(make_err()).startswith(reason)

    @pytest.mark.parametrize("label,make_err", NO_RETRY, ids=[r[0] for r in NO_RETRY])
    def test_does_not_retry(self, module, label, make_err):
        assert module.model_retry_reason(make_err()) is None

    def test_retries_with_backoff_then_succeeds(self, module):
        fn = MagicMock(side_effect=[anthropic_status(429), anthropic_status(529), "ok"])
        waits = []
        assert module.call_with_model_retry(fn, sleep=waits.append) == "ok"
        assert fn.call_count == 3
        assert waits == [5, 15]

    def test_gives_up_after_the_retries(self, module):
        err = anthropic_status(429)
        fn = MagicMock(side_effect=err)
        with pytest.raises(anthropic.APIStatusError):
            module.call_with_model_retry(fn, sleep=lambda _s: None)
        assert fn.call_count == 1 + module.MODEL_RETRIES

    def test_timeout_is_tried_once(self, module):
        fn = MagicMock(side_effect=anthropic.APITimeoutError(request=REQUEST))
        with pytest.raises(anthropic.APITimeoutError):
            module.call_with_model_retry(fn, sleep=lambda _s: None)
        assert fn.call_count == 1

    def test_slow_failure_is_not_retried(self, module):
        """A retryable error that took longer than the fast-failure limit may
        have happened mid-generation (billed), so it isn't retried."""
        ticks = iter([0, 45, 45, 90])
        fn = MagicMock(side_effect=anthropic.APIConnectionError(request=REQUEST))
        with pytest.raises(anthropic.APIConnectionError):
            module.call_with_model_retry(fn, sleep=lambda _s: None, clock=lambda: next(ticks))
        assert fn.call_count == 1

    def test_call_llm_uses_the_rule(self, module):
        with patch.object(module, "_call_llm_once", side_effect=[anthropic_status(529), ("text", {})]) as once, \
                patch.object(module.time, "sleep") as sleep:
            args = ("anthropic", "model", "prompt") + ((None,) if module is extract_llm else ())
            assert module.call_llm(*args) == ("text", {})
        assert once.call_count == 2
        sleep.assert_called_once_with(5)


@pytest.mark.parametrize("module", [extract_llm, quality_llm], ids=lambda m: m.__name__)
def test_claude_clients_have_sdk_retries_off(module):
    with patch.object(module.anthropic, "Anthropic") as direct:
        module.make_claude_client(module.BACKEND_DIRECT)
    assert direct.call_args.kwargs["max_retries"] == 0


def test_drift_claude_client_has_sdk_retries_off():
    with patch.object(drift_llm.anthropic, "Anthropic") as direct:
        with pytest.raises(Exception):
            drift_llm.call_claude("prompt")  # the mocked client's response isn't a real one
    assert direct.call_args.kwargs["max_retries"] == 0
