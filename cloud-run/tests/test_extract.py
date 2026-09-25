import io
import json
import os
from pathlib import Path
from unittest.mock import patch, MagicMock

from http import HTTPStatus

import pytest

from extract.main import (
    extract, extract_text_with_pdfplumber, get_active_models,
    load_pdf_bytes, build_extraction_prompt, publish_extraction_complete,
    log_extraction_result, log_extraction_failure, text_to_extraction_json, run_extraction,
    run_pdf_extraction,
    EXTRACT_ROLE, PUBSUB_TOPIC_ENV_VAR, STATUS_EXTRACTED, STATUS_FAILED,
    MIME_PDF, MIME_GOOGLE_DOCS, MIME_DOCX, TEXT_MIME_TYPES,
    PASSTHROUGH_PROVIDER, PASSTHROUGH_MODEL,
)
import anthropic
import google.auth.exceptions
import httpx
from google.genai import errors as genai_errors

from extract.llm import (
    call_llm, make_claude_client, make_gemini_client,
    PROVIDER_ANTHROPIC, PROVIDER_GOOGLE, BACKEND_VERTEX, BACKEND_DIRECT,
)

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


class FakeRequest:
    def __init__(self, json_data=None):
        self._json = json_data

    def get_json(self, silent=False):
        return self._json


class TestExtractEndpoint:
    def test_returns_400_when_no_file_id(self):
        req = FakeRequest({})
        body, status = extract(req)
        assert status == HTTPStatus.BAD_REQUEST
        assert "error" in json.loads(body)

    @patch("extract.main.run_extraction")
    def test_returns_202_with_file_id(self, mock_run):
        req = FakeRequest({"fileId": "abc123", "fileName": "test.pdf"})
        body, status = extract(req)
        result = json.loads(body)
        assert status == HTTPStatus.ACCEPTED
        assert result["status"] == "accepted"
        assert result["fileId"] == "abc123"
        assert result["fileName"] == "test.pdf"

    def test_returns_400_when_body_is_none(self):
        req = FakeRequest(None)
        body, status = extract(req)
        assert status == HTTPStatus.BAD_REQUEST


class TestGetActiveModels:
    SAMPLE_CONFIG = {
        "models": [
            {"role": "extract", "provider": "anthropic", "model": "claude-sonnet-4-6", "active": True},
            {"role": "extract", "provider": "google", "model": "gemini-3.5-flash", "active": False},
            {"role": "translate", "provider": "anthropic", "model": "claude-sonnet-4-6", "active": True},
        ]
    }

    def test_returns_only_active_models_for_role(self):
        result = get_active_models(self.SAMPLE_CONFIG, EXTRACT_ROLE)
        assert len(result) == 1
        assert result[0]["model"] == "claude-sonnet-4-6"
        assert result[0]["provider"] == "anthropic"

    def test_returns_multiple_when_both_active(self):
        config = {
            "models": [
                {"role": "extract", "provider": "anthropic", "model": "claude-sonnet-4-6", "active": True},
                {"role": "extract", "provider": "google", "model": "gemini-3.5-flash", "active": True},
            ]
        }
        result = get_active_models(config, EXTRACT_ROLE)
        assert len(result) == 2

    def test_returns_empty_when_none_active(self):
        config = {
            "models": [
                {"role": "extract", "provider": "anthropic", "model": "claude-sonnet-4-6", "active": False},
            ]
        }
        result = get_active_models(config, EXTRACT_ROLE)
        assert len(result) == 0

    def test_does_not_return_other_roles(self):
        result = get_active_models(self.SAMPLE_CONFIG, "translate")
        assert len(result) == 1
        assert result[0]["role"] == "translate"


class TestLoadPdfBytes:
    def test_loads_from_local_path(self):
        local_path = str(FIXTURES_DIR / "minimal.pdf")
        with patch.dict("os.environ", {"LOCAL_PDF_PATH": local_path}):
            pdf_bytes = load_pdf_bytes("ignored-file-id")
        assert len(pdf_bytes) > 0
        assert pdf_bytes.startswith(b"%PDF")

    def test_raises_on_missing_local_path(self):
        with patch.dict("os.environ", {"LOCAL_PDF_PATH": "/nonexistent/file.pdf"}):
            with pytest.raises(FileNotFoundError):
                load_pdf_bytes("ignored-file-id")

    def test_falls_through_to_drive_fetch_without_local_path(self):
        fake_pdf = b"%PDF-fake-content"
        with patch.dict("os.environ", {}, clear=True):
            with patch("extract.main.fetch_pdf_from_drive", return_value=fake_pdf) as mock_fetch:
                result = load_pdf_bytes("drive-file-id")
        mock_fetch.assert_called_once_with("drive-file-id")
        assert result == fake_pdf


class TestBuildExtractionPrompt:
    def test_appends_extracted_text_when_available(self):
        prompt = build_extraction_prompt("Extract content from this PDF.", "Hello World")
        assert "Extract content from this PDF." in prompt
        assert "<extracted_text>\nHello World\n</extracted_text>" in prompt

    def test_returns_base_prompt_when_no_text(self):
        prompt = build_extraction_prompt("Extract content from this PDF.", None)
        assert prompt == "Extract content from this PDF."
        assert "extracted_text" not in prompt


def _anthropic_status_error(status):
    request = httpx.Request("POST", "https://example.test/v1/messages")
    response = httpx.Response(status, request=request)
    error_classes = {
        401: anthropic.AuthenticationError,
        403: anthropic.PermissionDeniedError,
        404: anthropic.NotFoundError,
        429: anthropic.RateLimitError,
    }
    cls = error_classes.get(status, anthropic.InternalServerError)
    return cls("error", response=response, body=None)


def _gemini_status_error(status, code_name):
    return genai_errors.ClientError(status, {"error": {"code": status, "message": "x", "status": code_name}})


VERTEX_ENV = {"VERTEX_PROJECT_ID": "proj", "VERTEX_LOCATION": "us"}
def claude_ok(*_args, **_kwargs):
    # Fresh dict per call: call_llm adds fields to the usage dict it gets back
    return '{"blocks": []}', {"input_tokens": 100, "output_tokens": 50}


def gemini_ok(*_args, **_kwargs):
    return '{"blocks": []}', {"input_tokens": 200, "output_tokens": 75}


@patch("extract.llm.load_extraction_schema", return_value={"type": "object"})
class TestCallLlm:
    @patch("extract.llm.make_claude_client", side_effect=lambda backend: f"claude-{backend}")
    @patch("extract.llm.call_claude", side_effect=claude_ok)
    def test_claude_uses_vertex_first(self, mock_claude, _client, mock_schema):
        with patch.dict("os.environ", VERTEX_ENV):
            text, usage = call_llm(PROVIDER_ANTHROPIC, "claude-sonnet-4-6", "prompt", "base64pdf")

        mock_schema.assert_called_once_with(PROVIDER_ANTHROPIC)
        mock_claude.assert_called_once_with("claude-vertex", "prompt", model="claude-sonnet-4-6",
                                            pdf_base64="base64pdf", output_schema={"type": "object"})
        assert text == '{"blocks": []}'
        assert usage["input_tokens"] == 100
        assert usage["llm_backend"] == BACKEND_VERTEX
        assert "llm_fallback_reason" not in usage
        assert isinstance(usage["duration_ms"], int)

    @patch("extract.llm.make_gemini_client", side_effect=lambda backend: f"gemini-{backend}")
    @patch("extract.llm.call_gemini", side_effect=gemini_ok)
    def test_gemini_uses_vertex_first(self, mock_gemini, _client, _schema):
        with patch.dict("os.environ", VERTEX_ENV):
            _, usage = call_llm(PROVIDER_GOOGLE, "gemini-3.5-flash", "prompt", "base64pdf")

        assert mock_gemini.call_args[0][0] == "gemini-vertex"
        assert usage["llm_backend"] == BACKEND_VERTEX

    @pytest.mark.parametrize("status", [401, 403, 404, 429])
    @patch("extract.llm.make_claude_client", side_effect=lambda backend: backend)
    @patch("extract.llm.call_claude")
    def test_claude_falls_back_on_pre_generation_errors(self, mock_claude, _client, _schema, status):
        mock_claude.side_effect = [_anthropic_status_error(status), claude_ok()]
        with patch.dict("os.environ", VERTEX_ENV):
            _, usage = call_llm(PROVIDER_ANTHROPIC, "claude-sonnet-4-6", "prompt", None)

        assert [c[0][0] for c in mock_claude.call_args_list] == [BACKEND_VERTEX, BACKEND_DIRECT]
        assert usage["llm_backend"] == BACKEND_DIRECT
        assert f"HTTP {status}" in usage["llm_fallback_reason"]

    @patch("extract.llm.make_gemini_client", side_effect=lambda backend: backend)
    @patch("extract.llm.call_gemini")
    def test_gemini_falls_back_when_model_not_found(self, mock_gemini, _client, _schema):
        mock_gemini.side_effect = [_gemini_status_error(404, "NOT_FOUND"), gemini_ok()]
        with patch.dict("os.environ", VERTEX_ENV):
            _, usage = call_llm(PROVIDER_GOOGLE, "gemini-3.5-flash", "prompt", None)

        assert usage["llm_backend"] == BACKEND_DIRECT
        assert usage["llm_fallback_reason"] == "HTTP 404: NOT_FOUND"

    @patch("extract.llm.call_claude", side_effect=claude_ok)
    def test_falls_back_when_vertex_not_configured(self, mock_claude, _schema):
        with patch.dict("os.environ", {}, clear=False):
            os.environ.pop("VERTEX_PROJECT_ID", None)
            os.environ.pop("LLM_BACKEND", None)
            _, usage = call_llm(PROVIDER_ANTHROPIC, "claude-sonnet-4-6", "prompt", None)

        mock_claude.assert_called_once()  # only the direct attempt reached call_claude
        assert usage["llm_backend"] == BACKEND_DIRECT
        assert usage["llm_fallback_reason"] == "vertex not configured"

    @patch("extract.llm.make_claude_client", side_effect=lambda backend: backend)
    @patch("extract.llm.call_claude", side_effect=google.auth.exceptions.DefaultCredentialsError("no creds"))
    def test_credential_errors_fall_back(self, mock_claude, _client, _schema):
        mock_claude.side_effect = [google.auth.exceptions.DefaultCredentialsError("no creds"), claude_ok()]
        with patch.dict("os.environ", VERTEX_ENV):
            _, usage = call_llm(PROVIDER_ANTHROPIC, "claude-sonnet-4-6", "prompt", None)

        assert usage["llm_fallback_reason"] == "credentials: DefaultCredentialsError"

    @pytest.mark.parametrize("err", [
        _anthropic_status_error(500),
        _anthropic_status_error(400),
        TimeoutError("took too long"),
        ValueError("bad output"),
    ])
    @patch("extract.llm.make_claude_client", side_effect=lambda backend: backend)
    @patch("extract.llm.call_claude")
    def test_other_errors_do_not_fall_back(self, mock_claude, _client, _schema, err):
        mock_claude.side_effect = err
        with patch.dict("os.environ", VERTEX_ENV), pytest.raises(type(err)):
            call_llm(PROVIDER_ANTHROPIC, "claude-sonnet-4-6", "prompt", None)

        assert mock_claude.call_count == 1

    @patch("extract.llm.make_claude_client", side_effect=lambda backend: backend)
    @patch("extract.llm.call_claude")
    def test_vertex_only_raises_instead_of_falling_back(self, mock_claude, _client, _schema):
        mock_claude.side_effect = _anthropic_status_error(404)
        with patch.dict("os.environ", {**VERTEX_ENV, "LLM_BACKEND": "vertex-only"}), \
                pytest.raises(anthropic.NotFoundError):
            call_llm(PROVIDER_ANTHROPIC, "claude-sonnet-4-6", "prompt", None)

        assert mock_claude.call_count == 1

    @patch("extract.llm.make_claude_client", side_effect=lambda backend: backend)
    @patch("extract.llm.call_claude", side_effect=claude_ok)
    def test_direct_only_skips_vertex(self, mock_claude, _client, _schema):
        with patch.dict("os.environ", {**VERTEX_ENV, "LLM_BACKEND": "direct-only"}):
            _, usage = call_llm(PROVIDER_ANTHROPIC, "claude-sonnet-4-6", "prompt", None)

        assert mock_claude.call_args[0][0] == BACKEND_DIRECT
        assert usage["llm_backend"] == BACKEND_DIRECT
        assert "llm_fallback_reason" not in usage

    def test_raises_on_unknown_provider(self, mock_schema):
        mock_schema.side_effect = ValueError("No extraction schema for provider: openai")
        with pytest.raises(ValueError, match="No extraction schema"):
            call_llm("openai", "gpt-4", "prompt", "base64pdf")


class TestVertexClients:
    @patch("extract.llm.anthropic.AnthropicVertex")
    def test_claude_vertex_client_uses_project_and_location(self, mock_vertex):
        with patch.dict("os.environ", VERTEX_ENV):
            make_claude_client(BACKEND_VERTEX)
        kwargs = mock_vertex.call_args[1]
        assert kwargs["project_id"] == "proj"
        assert kwargs["region"] == "us"

    @patch("extract.llm.genai.Client")
    def test_gemini_vertex_client_uses_project_and_location(self, mock_client):
        with patch.dict("os.environ", VERTEX_ENV):
            make_gemini_client(BACKEND_VERTEX)
        mock_client.assert_called_once_with(vertexai=True, project="proj", location="us")

    @patch("extract.llm.genai.Client")
    def test_vertex_location_defaults_to_us(self, mock_client):
        with patch.dict("os.environ", {"VERTEX_PROJECT_ID": "proj"}):
            os.environ.pop("VERTEX_LOCATION", None)
            make_gemini_client(BACKEND_VERTEX)
        assert mock_client.call_args[1]["location"] == "us"


class TestExtractTextWithPdfplumber:
    def test_extracts_text_from_pdf_with_text_layer(self):
        pdf_bytes = (FIXTURES_DIR / "minimal.pdf").read_bytes()
        text = extract_text_with_pdfplumber(io.BytesIO(pdf_bytes))
        assert text is not None
        assert "Hello World" in text

    def test_returns_none_when_no_text_layer(self):
        mock_page = MagicMock()
        mock_page.extract_text.return_value = None

        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__ = MagicMock(return_value=mock_pdf)
        mock_pdf.__exit__ = MagicMock(return_value=False)

        with patch("extract.main.pdfplumber.open", return_value=mock_pdf):
            text = extract_text_with_pdfplumber(io.BytesIO(b"fake"))

        assert text is None


class TestPublishExtractionComplete:
    SAMPLE_RESULTS = [
        {
            "driveFileId": "drive-id-1",
            "fileName": "test_claude_extraction.json",
            "model": "claude-sonnet-4-6",
            "provider": "anthropic",
            "parsed": {"blocks": []},
        },
    ]

    @patch("extract.main.pubsub_v1.PublisherClient")
    def test_publishes_message_per_result(self, mock_client_cls):
        mock_publisher = MagicMock()
        mock_future = MagicMock()
        mock_future.result.return_value = "msg-123"
        mock_publisher.publish.return_value = mock_future
        mock_client_cls.return_value = mock_publisher

        topic = "projects/my-project/topics/extraction-complete"
        with patch.dict("os.environ", {PUBSUB_TOPIC_ENV_VAR: topic}):
            publish_extraction_complete("source-file-id", "test.pdf", self.SAMPLE_RESULTS)

        mock_publisher.publish.assert_called_once()
        call_args = mock_publisher.publish.call_args
        assert call_args[0][0] == topic
        message = json.loads(call_args[0][1])
        assert message["sourceFileId"] == "source-file-id"
        assert message["sourceFileName"] == "test.pdf"
        assert message["extractionFileId"] == "drive-id-1"
        assert message["model"] == "claude-sonnet-4-6"
        assert message["provider"] == "anthropic"
        assert message["submittedByEmail"] == ""

    @patch("extract.main.pubsub_v1.PublisherClient")
    def test_skips_publish_when_no_topic(self, mock_client_cls):
        with patch.dict("os.environ", {}, clear=False):
            os.environ.pop(PUBSUB_TOPIC_ENV_VAR, None)
            publish_extraction_complete("source-file-id", "test.pdf", self.SAMPLE_RESULTS)

        mock_client_cls.assert_not_called()

    @patch("extract.main.pubsub_v1.PublisherClient")
    def test_includes_submitted_by_email_in_message(self, mock_client_cls):
        mock_publisher = MagicMock()
        mock_future = MagicMock()
        mock_future.result.return_value = "msg-789"
        mock_publisher.publish.return_value = mock_future
        mock_client_cls.return_value = mock_publisher

        topic = "projects/my-project/topics/extraction-complete"
        with patch.dict("os.environ", {PUBSUB_TOPIC_ENV_VAR: topic}):
            publish_extraction_complete("source-file-id", "test.pdf", self.SAMPLE_RESULTS,
                                        submitted_by_email="user@example.com")

        message = json.loads(mock_publisher.publish.call_args[0][1])
        assert message["submittedByEmail"] == "user@example.com"

    @patch("extract.main.pubsub_v1.PublisherClient")
    def test_publishes_multiple_results(self, mock_client_cls):
        mock_publisher = MagicMock()
        mock_future = MagicMock()
        mock_future.result.return_value = "msg-456"
        mock_publisher.publish.return_value = mock_future
        mock_client_cls.return_value = mock_publisher

        two_results = self.SAMPLE_RESULTS + [{
            "driveFileId": "drive-id-2",
            "fileName": "test_gemini_extraction.json",
            "model": "gemini-3.5-flash",
            "provider": "google",
            "parsed": {"blocks": []},
        }]

        topic = "projects/my-project/topics/extraction-complete"
        with patch.dict("os.environ", {PUBSUB_TOPIC_ENV_VAR: topic}):
            publish_extraction_complete("source-file-id", "test.pdf", two_results)

        assert mock_publisher.publish.call_count == 2


class TestTextToExtractionJson:
    def test_splits_paragraphs_into_blocks(self):
        text = "First paragraph.\n\nSecond paragraph.\n\nThird."
        result = text_to_extraction_json(text, "file-123")
        assert result["sourceType"] == "text"
        assert result["sourceFileId"] == "file-123"
        assert len(result["blocks"]) == 3
        assert result["blocks"][0]["text"] == "First paragraph."
        assert result["blocks"][1]["text"] == "Second paragraph."
        assert result["blocks"][2]["text"] == "Third."

    def test_blocks_have_correct_structure(self):
        result = text_to_extraction_json("Hello world.", "file-123")
        block = result["blocks"][0]
        assert block["id"] == "block-1"
        assert block["role"] == "body"
        assert block["translate"] is True
        assert "spatial" not in block
        assert "typography" not in block

    def test_skips_blank_lines(self):
        text = "Line one.\n\n\n\n\nLine two."
        result = text_to_extraction_json(text, "file-123")
        assert len(result["blocks"]) == 2

    def test_omits_pdf_specific_fields(self):
        result = text_to_extraction_json("Some text.", "file-123")
        assert "page_metadata" not in result
        assert "non_translatable_elements" not in result
        assert "translation_warnings" not in result


class TestExtractEndpointMimeType:
    @patch("extract.main.run_extraction")
    def test_passes_mime_type_to_run_extraction(self, mock_run):
        req = FakeRequest({"fileId": "abc", "fileName": "doc.docx", "mimeType": MIME_DOCX})
        body, status = extract(req)
        assert status == HTTPStatus.ACCEPTED
        mock_run.assert_called_once()
        args = mock_run.call_args[0]
        assert args[2] == MIME_DOCX

    @patch("extract.main.run_extraction")
    def test_defaults_to_pdf_when_no_mime_type(self, mock_run):
        req = FakeRequest({"fileId": "abc", "fileName": "test.pdf"})
        extract(req)
        args = mock_run.call_args[0]
        assert args[2] == MIME_PDF


class TestRunExtractionRouting:
    @patch("extract.main.run_text_extraction")
    def test_routes_google_docs_to_text_path(self, mock_text):
        run_extraction("file-id", "My Doc", MIME_GOOGLE_DOCS)
        mock_text.assert_called_once_with("file-id", "My Doc", MIME_GOOGLE_DOCS, "public_flyer", "")

    @patch("extract.main.run_text_extraction")
    def test_routes_docx_to_text_path(self, mock_text):
        run_extraction("file-id", "report.docx", MIME_DOCX)
        mock_text.assert_called_once_with("file-id", "report.docx", MIME_DOCX, "public_flyer", "")

    @patch("extract.main.run_pdf_extraction")
    def test_routes_pdf_to_pdf_path(self, mock_pdf):
        run_extraction("file-id", "test.pdf", MIME_PDF)
        mock_pdf.assert_called_once_with("file-id", "test.pdf", "public_flyer", "")

    @patch("extract.main.run_text_extraction")
    def test_passes_submitted_by_email_to_text_path(self, mock_text):
        run_extraction("file-id", "My Doc", MIME_GOOGLE_DOCS, "public_flyer", "user@example.com")
        mock_text.assert_called_once_with("file-id", "My Doc", MIME_GOOGLE_DOCS, "public_flyer", "user@example.com")

    @patch("extract.main.run_pdf_extraction")
    def test_passes_submitted_by_email_to_pdf_path(self, mock_pdf):
        run_extraction("file-id", "test.pdf", MIME_PDF, "public_flyer", "user@example.com")
        mock_pdf.assert_called_once_with("file-id", "test.pdf", "public_flyer", "user@example.com")

    @patch("extract.main.log_structured")
    def test_rejects_unsupported_mime_type(self, mock_log):
        run_extraction("file-id", "image.png", "image/png")
        mock_log.assert_called_once()
        args = mock_log.call_args[0]
        assert args[0] == STATUS_FAILED


class TestLogExtractionResult:
    SAMPLE_RESULT = {
        "driveFileId": "extraction-drive-id",
        "fileName": "test_extraction.json",
        "parsed": {"blocks": []},
        "model": "claude-sonnet-4-6",
        "provider": "anthropic",
    }

    @patch("extract.main.build")
    @patch("extract.main.google.auth.default", return_value=(MagicMock(), "project-id"))
    def test_appends_row_with_extraction_details(self, mock_auth, mock_build):
        mock_service = MagicMock()
        mock_build.return_value = mock_service
        mock_values = mock_service.spreadsheets.return_value.values.return_value

        with patch.dict("os.environ", {"PROCESSING_LOG_SHEET_ID": "sheet-123"}):
            log_extraction_result("abc123", "test.pdf", self.SAMPLE_RESULT)

        mock_values.append.assert_called_once()
        call_kwargs = mock_values.append.call_args[1]
        assert call_kwargs["range"] == "ProcessingLog!A:I"
        row = call_kwargs["body"]["values"][0]
        assert row[0] == "abc123"
        assert row[1] == "test.pdf"
        assert row[3] == STATUS_EXTRACTED
        assert row[6] == "extraction-drive-id"
        assert row[7] == "anthropic"
        assert row[8] == "claude-sonnet-4-6"

    def test_skips_when_no_sheet_id(self):
        with patch.dict("os.environ", {}, clear=False):
            os.environ.pop("PROCESSING_LOG_SHEET_ID", None)
            log_extraction_result("abc123", "test.pdf", self.SAMPLE_RESULT)




# Processing log column indexes (A–I)
COL_STATUS = 3
COL_DURATION = 4
COL_ERROR = 5
COL_OUTPUT_FILE_ID = 6
COL_PROVIDER = 7
COL_MODEL = 8


def _sheet_values(mock_build):
    return mock_build.return_value.spreadsheets.return_value.values.return_value


@patch("extract.main.build")
@patch("extract.main.google.auth.default", return_value=(MagicMock(), "project-id"))
class TestProcessingLogRows:
    RESULT = {"driveFileId": "out-1", "model": "gemini", "provider": "google"}

    def test_success_row_includes_llm_duration(self, mock_auth, mock_build):
        with patch.dict("os.environ", {"PROCESSING_LOG_SHEET_ID": "sheet-123"}):
            log_extraction_result("abc", "a.pdf", self.RESULT, usage={"duration_ms": 4321})

        row = _sheet_values(mock_build).append.call_args[1]["body"]["values"][0]
        assert row[COL_STATUS] == STATUS_EXTRACTED
        assert row[COL_DURATION] == 4321
        assert row[COL_ERROR] == ""
        assert row[COL_OUTPUT_FILE_ID] == "out-1"

    def test_success_row_duration_blank_without_usage(self, mock_auth, mock_build):
        with patch.dict("os.environ", {"PROCESSING_LOG_SHEET_ID": "sheet-123"}):
            log_extraction_result("abc", "a.docx", self.RESULT)

        row = _sheet_values(mock_build).append.call_args[1]["body"]["values"][0]
        assert row[COL_DURATION] == ""

    def test_failure_row_puts_error_in_error_detail(self, mock_auth, mock_build):
        with patch.dict("os.environ", {"PROCESSING_LOG_SHEET_ID": "sheet-123"}):
            log_extraction_failure("abc", "a.pdf", "google", "gemini", "LLM call failed")

        values = _sheet_values(mock_build)
        row = values.append.call_args[1]["body"]["values"][0]
        assert row[COL_STATUS] == STATUS_FAILED
        assert row[COL_DURATION] == ""
        assert row[COL_ERROR] == "LLM call failed"
        assert row[COL_OUTPUT_FILE_ID] == ""
        assert row[COL_PROVIDER] == "google"
        assert row[COL_MODEL] == "gemini"
        # Append-only: never edit an existing row
        values.update.assert_not_called()


class TestExtractionFailureRows:
    MODEL_CONFIG = {"models": [{"role": EXTRACT_ROLE, "provider": "google", "model": "gemini", "active": True}]}

    @patch("extract.main.publish_extraction_complete")
    @patch("extract.main.log_extraction_failure")
    @patch("extract.main.call_llm", side_effect=RuntimeError("timeout"))
    @patch("extract.main.load_doc", return_value="prompt")
    @patch("extract.main.extract_text_with_pdfplumber", return_value="")
    @patch("extract.main.load_pdf_bytes", return_value=b"%PDF")
    @patch("extract.main.load_config")
    def test_llm_failure_writes_failed_row(self, mock_config, _pdf, _text, _doc, _llm,
                                           mock_fail, _publish):
        mock_config.return_value = self.MODEL_CONFIG
        run_pdf_extraction("abc", "a.pdf")

        mock_fail.assert_called_once_with("abc", "a.pdf", "google", "gemini",
                                          "LLM call failed", usage=None)

    @patch("extract.main.publish_extraction_complete")
    @patch("extract.main.log_extraction_failure")
    @patch("extract.main.save_extraction_results", return_value=None)
    @patch("extract.main.call_llm", return_value=("not json", {"duration_ms": 900}))
    @patch("extract.main.load_doc", return_value="prompt")
    @patch("extract.main.extract_text_with_pdfplumber", return_value="")
    @patch("extract.main.load_pdf_bytes", return_value=b"%PDF")
    @patch("extract.main.load_config")
    def test_parse_failure_writes_failed_row_with_duration(self, mock_config, _pdf, _text, _doc,
                                                           _llm, _save, mock_fail, _publish):
        mock_config.return_value = self.MODEL_CONFIG
        run_pdf_extraction("abc", "a.pdf")

        mock_fail.assert_called_once_with("abc", "a.pdf", "google", "gemini",
                                          "Extraction parse/validation failed",
                                          usage={"duration_ms": 900})

    @patch("extract.main.log_extraction_failure")
    @patch("extract.main.run_pdf_extraction", side_effect=RuntimeError("PDF download failed"))
    def test_setup_error_writes_failed_row(self, _run, mock_fail):
        run_extraction("abc", "a.pdf", MIME_PDF)

        args = mock_fail.call_args[0]
        assert args[:4] == ("abc", "a.pdf", "", "")
        assert "PDF download failed" in args[4]

    @patch("extract.main.log_extraction_failure", side_effect=RuntimeError("Sheets down"))
    @patch("extract.main.run_pdf_extraction", side_effect=RuntimeError("boom"))
    def test_sheet_write_failure_does_not_raise(self, _run, _fail):
        run_extraction("abc", "a.pdf", MIME_PDF)  # must not raise
