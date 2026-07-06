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
    log_extraction_result,
    EXTRACT_ROLE, PUBSUB_TOPIC_ENV_VAR, STATUS_EXTRACTED,
)
from extract.llm import call_llm, PROVIDER_ANTHROPIC, PROVIDER_GOOGLE

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


class TestCallLlm:
    @patch("extract.llm.load_extraction_schema", return_value={"type": "object"})
    @patch("extract.llm.call_claude", return_value='{"blocks": []}')
    def test_dispatches_to_claude(self, mock_claude, mock_schema):
        result = call_llm(PROVIDER_ANTHROPIC, "claude-sonnet-4-6", "prompt", "base64pdf")
        mock_schema.assert_called_once_with(PROVIDER_ANTHROPIC)
        mock_claude.assert_called_once_with("prompt", model="claude-sonnet-4-6", pdf_base64="base64pdf", output_schema={"type": "object"})
        assert result == '{"blocks": []}'

    @patch("extract.llm.load_extraction_schema", return_value={"type": "object"})
    @patch("extract.llm.call_gemini", return_value='{"blocks": []}')
    def test_dispatches_to_gemini(self, mock_gemini, mock_schema):
        result = call_llm(PROVIDER_GOOGLE, "gemini-3.5-flash", "prompt", "base64pdf")
        mock_schema.assert_called_once_with(PROVIDER_GOOGLE)
        mock_gemini.assert_called_once_with("prompt", model="gemini-3.5-flash", pdf_base64="base64pdf", output_schema={"type": "object"})
        assert result == '{"blocks": []}'

    def test_raises_on_unknown_provider(self):
        with pytest.raises(ValueError, match="No extraction schema"):
            call_llm("openai", "gpt-4", "prompt", "base64pdf")


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

    @patch("extract.main.pubsub_v1.PublisherClient")
    def test_skips_publish_when_no_topic(self, mock_client_cls):
        with patch.dict("os.environ", {}, clear=False):
            os.environ.pop(PUBSUB_TOPIC_ENV_VAR, None)
            publish_extraction_complete("source-file-id", "test.pdf", self.SAMPLE_RESULTS)

        mock_client_cls.assert_not_called()

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


