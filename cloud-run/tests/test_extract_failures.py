"""Extract failure reporting: plain-language reasons (failure_reasons.py), the
Chat notice (notifier.py), and when main.py posts it. Real error objects from
the installed SDKs and googleapiclient, not hand-built fakes."""
import json
import zipfile
from unittest.mock import patch, MagicMock

import anthropic
import httplib2
import pytest
from google.genai import errors as genai_errors
from googleapiclient.errors import HttpError

try:
    import httpx2 as httpx  # anthropic 2.x / google-genai 3.x
except ImportError:
    import httpx  # older SDK versions

from failure_reasons import (
    model_failure_reason, input_failure_reason, text_fetch_failure_reason, combine_reasons,
    REASON_FILE_NOT_FOUND, REASON_FILE_UNREADABLE, REASON_HANDOFF_FAILED,
    REASON_INVALID_OUTPUT, REASON_MISSING_SETTING, REASON_MODEL_ACCESS,
    REASON_MODEL_CONFIG, REASON_MODEL_NOT_FOUND, REASON_NO_ACTIVE_MODELS,
    REASON_PROVIDER_BUSY, REASON_TIMEOUT, REASON_UNEXPECTED,
    REASON_UNSUPPORTED_TYPE,
)
from loaders import ModelConfigError, MissingSettingError
import notifier
from extract.main import (
    run_pdf_extraction, run_text_extraction, run_extraction, hand_off_to_translate,
    EXTRACT_ROLE, MIME_PDF, MIME_DOCX,
)

REQUEST = httpx.Request("POST", "https://example.test")


def claude_status_error(status):
    return anthropic.APIStatusError("error", response=httpx.Response(status, request=REQUEST), body=None)


def gemini_error(code):
    return genai_errors.APIError(code, {"error": {"message": "error", "status": "X"}})


def drive_error(status):
    return HttpError(httplib2.Response({"status": status}), b'{"error": {"message": "File not found"}}')


class TestModelFailureReason:
    @pytest.mark.parametrize("make_err, reason", [
        (lambda: claude_status_error(404), REASON_MODEL_NOT_FOUND),
        (lambda: gemini_error(404), REASON_MODEL_NOT_FOUND),
        (lambda: claude_status_error(401), REASON_MODEL_ACCESS),
        (lambda: claude_status_error(403), REASON_MODEL_ACCESS),
        (lambda: anthropic.APITimeoutError(request=REQUEST), REASON_TIMEOUT),
        (lambda: httpx.ReadTimeout("timed out"), REASON_TIMEOUT),
        (lambda: claude_status_error(429), REASON_PROVIDER_BUSY),
        (lambda: gemini_error(503), REASON_PROVIDER_BUSY),
        (lambda: httpx.ConnectError("refused"), REASON_PROVIDER_BUSY),
        (lambda: claude_status_error(400), REASON_UNEXPECTED),
        (lambda: RuntimeError("boom"), REASON_UNEXPECTED),
    ])
    def test_reason(self, make_err, reason):
        assert model_failure_reason(make_err()) == reason


class TestInputFailureReason:
    @pytest.mark.parametrize("make_err, reason", [
        (lambda: drive_error(404), REASON_FILE_NOT_FOUND),
        (lambda: drive_error(403), REASON_FILE_NOT_FOUND),
        (lambda: MissingSettingError("EXTRACTION_PROMPT_DOC_ID not set in .env"), REASON_MISSING_SETTING),
        (lambda: ModelConfigError("Model Config problem: no rows"), REASON_MODEL_CONFIG),
        (lambda: drive_error(500), REASON_UNEXPECTED),
        (lambda: RuntimeError("boom"), REASON_UNEXPECTED),
    ])
    def test_reason(self, make_err, reason):
        assert input_failure_reason(make_err()) == reason

    def test_text_fetch_drive_error(self):
        assert text_fetch_failure_reason(drive_error(403)) == REASON_FILE_NOT_FOUND

    def test_text_fetch_unreadable_file(self):
        # What python-docx raises on a file that isn't really a .docx
        assert text_fetch_failure_reason(zipfile.BadZipFile("not a zip")) == REASON_FILE_UNREADABLE


class TestCombineReasons:
    def test_one_line_when_all_match(self):
        assert combine_reasons([("a", "x", "same."), ("g", "y", "same.")]) == ["same."]

    def test_one_line_per_model_when_they_differ(self):
        assert combine_reasons([("a", "x", "one."), ("g", "y", "two.")]) == ["a/x: one.", "g/y: two."]


class TestNotifier:
    def _post(self, monkeypatch, reasons, **kwargs):
        monkeypatch.setenv(notifier.WEBHOOK_ENV_VAR, "https://chat.example/webhook")
        with patch("notifier.urllib.request.urlopen", MagicMock()) as urlopen:
            notifier.notify_extraction_failed("f.pdf", reasons, **kwargs)
        request = urlopen.call_args[0][0]
        return json.loads(request.data)["text"]

    def test_single_reason(self, monkeypatch):
        text = self._post(monkeypatch, ["The file couldn't be read."], submitted_by_email="a@b.org")
        assert text == (
            "User: a@b.org\n"
            "⚠️ Translation failed for *f.pdf* while reading the document. It won't be retried automatically.\n"
            "*Reason:* The file couldn't be read.\n"
            "Contact your workflow owner. Full details are in the Processing Log."
        )

    def test_several_reasons(self, monkeypatch):
        text = self._post(monkeypatch, ["a/x: one.", "g/y: two."])
        assert "*Reasons:*\n• a/x: one.\n• g/y: two.\n" in text

    def test_no_webhook_no_post(self, monkeypatch):
        monkeypatch.delenv(notifier.WEBHOOK_ENV_VAR, raising=False)
        with patch("notifier.urllib.request.urlopen") as urlopen:
            notifier.notify_extraction_failed("f.pdf", ["x"])
        urlopen.assert_not_called()

    def test_post_failure_does_not_raise(self, monkeypatch):
        monkeypatch.setenv(notifier.WEBHOOK_ENV_VAR, "https://chat.example/webhook")
        with patch("notifier.urllib.request.urlopen", side_effect=OSError("network down")):
            notifier.notify_extraction_failed("f.pdf", ["x"])  # must not raise


TWO_MODELS = {"models": [
    {"role": EXTRACT_ROLE, "provider": "anthropic", "model": "claude", "active": True},
    {"role": EXTRACT_ROLE, "provider": "google", "model": "gemini", "active": True},
]}
GOOD_RESULT = {"parsed": {"blocks": []}, "driveFileId": "ext-1", "fileName": "a_extraction.json"}


@pytest.fixture
def pdf_run():
    """Patch run_pdf_extraction's inputs; yields the mocks to configure and inspect."""
    with patch("extract.main.load_config", return_value=TWO_MODELS) as config, \
         patch("extract.main.load_pdf_bytes", return_value=b"%PDF"), \
         patch("extract.main.extract_text_with_pdfplumber", return_value=""), \
         patch("extract.main.load_doc", return_value="prompt"), \
         patch("extract.main.call_llm") as call_llm, \
         patch("extract.main.save_extraction_results", return_value=GOOD_RESULT) as save, \
         patch("extract.main.log_extraction_failure") as fail_row, \
         patch("extract.main.log_extraction_result"), \
         patch("extract.main.publish_extraction_complete", return_value=[]) as publish, \
         patch("extract.main.notify_extraction_failed") as notify:
        yield MagicMock(config=config, call_llm=call_llm, save=save, fail_row=fail_row,
                        publish=publish, notify=notify)


class TestPdfExtractionNotices:
    def test_all_models_fail_differently(self, pdf_run):
        pdf_run.call_llm.side_effect = [claude_status_error(404), anthropic.APITimeoutError(request=REQUEST)]
        run_pdf_extraction("src", "a.pdf", submitted_by_email="p@x.gov", submitted_by_name="P")

        pdf_run.notify.assert_called_once_with("a.pdf", [
            f"anthropic/claude: {REASON_MODEL_NOT_FOUND}",
            f"google/gemini: {REASON_TIMEOUT}",
        ], "p@x.gov", "P")
        pdf_run.publish.assert_not_called()
        # The Processing Log gets the real error, not just "LLM call failed"
        first_error = pdf_run.fail_row.call_args_list[0][0][4]
        assert first_error.startswith("LLM call failed: APIStatusError: ")

    def test_all_models_fail_the_same_way(self, pdf_run):
        pdf_run.call_llm.side_effect = [claude_status_error(404), gemini_error(404)]
        run_pdf_extraction("src", "a.pdf")
        pdf_run.notify.assert_called_once_with("a.pdf", [REASON_MODEL_NOT_FOUND], "", "")

    def test_one_model_succeeds_no_notice(self, pdf_run):
        pdf_run.call_llm.side_effect = [claude_status_error(404), ("{}", {})]
        run_pdf_extraction("src", "a.pdf")
        pdf_run.notify.assert_not_called()
        pdf_run.publish.assert_called_once()

    def test_invalid_output(self, pdf_run):
        pdf_run.call_llm.return_value = ("not json", {})
        pdf_run.save.return_value = None
        run_pdf_extraction("src", "a.pdf")
        pdf_run.notify.assert_called_once_with("a.pdf", [REASON_INVALID_OUTPUT], "", "")

    def test_save_failure_goes_on_to_the_next_model(self, pdf_run):
        pdf_run.call_llm.return_value = ("{}", {"duration_ms": 5})
        pdf_run.save.side_effect = [drive_error(503), GOOD_RESULT]
        run_pdf_extraction("src", "a.pdf")
        assert pdf_run.save.call_count == 2
        assert "Saving the extraction failed" in pdf_run.fail_row.call_args[0][4]
        pdf_run.publish.assert_called_once()
        pdf_run.notify.assert_not_called()

    def test_no_active_models_gets_a_row_and_a_notice(self, pdf_run):
        pdf_run.config.return_value = {"models": []}
        run_pdf_extraction("src", "a.pdf")
        assert pdf_run.fail_row.call_args[0][4] == "No active extract models in Model Config"
        pdf_run.notify.assert_called_once_with("a.pdf", [REASON_NO_ACTIVE_MODELS], "", "")
        pdf_run.call_llm.assert_not_called()


class TestHandOff:
    RESULTS = [dict(GOOD_RESULT, provider="anthropic", model="claude"),
               dict(GOOD_RESULT, provider="google", model="gemini")]

    @patch("extract.main.notify_extraction_failed")
    @patch("extract.main.log_extraction_failure")
    @patch("extract.main.publish_extraction_complete")
    def test_every_publish_fails_row_and_notice(self, publish, fail_row, notify):
        publish.return_value = [(r, RuntimeError("Pub/Sub down")) for r in self.RESULTS]
        hand_off_to_translate("src", "a.pdf", self.RESULTS, "public_flyer", "", "")
        assert fail_row.call_count == 2
        assert "Hand-off to Translate (Pub/Sub publish) failed: RuntimeError: Pub/Sub down" in fail_row.call_args[0][4]
        notify.assert_called_once_with("a.pdf", [REASON_HANDOFF_FAILED], "", "")

    @patch("extract.main.notify_extraction_failed")
    @patch("extract.main.log_extraction_failure")
    @patch("extract.main.publish_extraction_complete")
    def test_some_publishes_fail_row_only(self, publish, fail_row, notify):
        publish.return_value = [(self.RESULTS[0], RuntimeError("Pub/Sub down"))]
        hand_off_to_translate("src", "a.pdf", self.RESULTS, "public_flyer", "", "")
        assert fail_row.call_count == 1
        notify.assert_not_called()


class TestOtherNotices:
    @patch("extract.main.notify_extraction_failed")
    @patch("extract.main.log_extraction_failure")
    @patch("extract.main.fetch_text_from_drive", side_effect=drive_error(404))
    def test_text_fetch_failure(self, _fetch, fail_row, notify):
        run_text_extraction("src", "a.docx", MIME_DOCX)
        assert fail_row.call_args[0][4].startswith("Text fetch failed: HttpError: ")
        notify.assert_called_once_with("a.docx", [REASON_FILE_NOT_FOUND], "", "")

    @patch("extract.main.notify_extraction_failed")
    @patch("extract.main.log_extraction_failure")
    @patch("extract.main.run_pdf_extraction", side_effect=MissingSettingError("EXTRACTION_PROMPT_DOC_ID not set in .env"))
    def test_setup_failure(self, _run, fail_row, notify):
        run_extraction("src", "a.pdf", MIME_PDF)
        assert "MissingSettingError" in fail_row.call_args[0][4]
        notify.assert_called_once_with("a.pdf", [REASON_MISSING_SETTING], "", "")

    @patch("extract.main.notify_extraction_failed")
    @patch("extract.main.log_extraction_failure")
    def test_unsupported_type(self, _fail_row, notify):
        run_extraction("src", "a.xlsx", "application/vnd.ms-excel")
        notify.assert_called_once_with("a.xlsx", [REASON_UNSUPPORTED_TYPE], "", "")
