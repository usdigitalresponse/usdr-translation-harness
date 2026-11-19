"""Pilot size limits (extract/size_limits.py, the Settings tab in loaders.py,
and the checks in extract/main.py): green = normal, yellow = translated with a
heads-up, red = not processed."""
import json
from unittest.mock import patch, MagicMock

import pytest

import size_limits
from size_limits import (
    GREEN, YELLOW, RED, category, worse, estimated_pages, translatable_block_count, pdf_page_count,
    red_reason, yellow_reason, size_info,
)
from loaders import SETTING_DEFAULTS, _settings_from_rows, load_settings
from extract.main import (
    run_pdf_extraction, run_text_extraction, count_text_pages, EXTRACT_ROLE, MIME_GOOGLE_DOCS, MIME_DOCX,
    STATUS_REJECTED,
)

SETTINGS = dict(SETTING_DEFAULTS)  # 2 / 5 pages, 120 / 200 blocks, 500 words per page


def real_pdf(pages):
    """A minimal valid PDF with this many blank pages (with a correct xref table)."""
    objects = ["<< /Type /Catalog /Pages 2 0 R >>",
               "<< /Type /Pages /Kids [" + " ".join(f"{3 + i} 0 R" for i in range(pages)) + f"] /Count {pages} >>"]
    objects += ["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"] * pages
    out, offsets = b"%PDF-1.4\n", []
    for n, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


class TestCategories:
    @pytest.mark.parametrize("value, expected", [(1, GREEN), (2, GREEN), (3, YELLOW), (5, YELLOW), (6, RED)])
    def test_page_boundaries(self, value, expected):
        assert category(value, 2, 5) == expected

    @pytest.mark.parametrize("value, expected", [(120, GREEN), (121, YELLOW), (200, YELLOW), (201, RED)])
    def test_block_boundaries(self, value, expected):
        assert category(value, 120, 200) == expected

    def test_worse_wins(self):
        assert worse(GREEN, RED) == RED
        assert worse(YELLOW, GREEN) == YELLOW
        assert worse(GREEN, GREEN) == GREEN

    def test_real_pdf_page_count(self):
        assert pdf_page_count(real_pdf(3)) == 3

    def test_word_pages_estimated_from_words(self):
        assert estimated_pages(["word " * 499], 500) == 1
        assert estimated_pages(["word " * 501], 500) == 2
        assert estimated_pages([], 500) == 1

    def test_only_translatable_blocks_count(self):
        parsed = {"blocks": [{"translate": True}, {"translate": False}, {}]}
        assert translatable_block_count(parsed) == 2


class TestMessages:
    def test_red_pages(self):
        assert red_reason(True, 14, False, SETTINGS).startswith("it's 14 pages, and the pilot supports up to 5.")

    def test_red_pages_estimated(self):
        assert "about 9 pages" in red_reason(True, 9, True, SETTINGS)

    def test_red_blocks_explains_in_plain_terms(self):
        reason = red_reason(False, 2, False, SETTINGS)
        assert "too many separate pieces of text" in reason and "each cell counts separately" in reason
        assert "block" not in reason

    def test_yellow(self):
        assert yellow_reason(True, 4, True) == "about 4 pages"
        assert "large table" in yellow_reason(False, 2, False)


class TestSettings:
    def test_values_from_the_tab(self):
        rows = [["setting", "value", "notes"], ["green_max_pages", "3", "pilot"], ["yellow_max_blocks", "250"]]
        settings = _settings_from_rows(rows)
        assert settings["green_max_pages"] == 3 and settings["yellow_max_blocks"] == 250
        assert settings["yellow_max_pages"] == SETTING_DEFAULTS["yellow_max_pages"]  # missing → default

    @pytest.mark.parametrize("bad", ["0", "-1", "two", ""])
    def test_invalid_value_uses_default_and_is_logged(self, bad, capsys):
        settings = _settings_from_rows([["setting", "value"], ["green_max_pages", bad]])
        assert settings["green_max_pages"] == SETTING_DEFAULTS["green_max_pages"]
        assert '"input_problem": "settings"' in capsys.readouterr().out

    def test_unknown_settings_ignored_and_header_case_insensitive(self):
        settings = _settings_from_rows([["Setting", "Value"], ["something_else", "9"], ["GREEN_MAX_PAGES", "4"]])
        assert settings["green_max_pages"] == 4 and "something_else" not in settings

    def test_wrong_headers_use_defaults(self, capsys):
        assert _settings_from_rows([["name", "number"], ["green_max_pages", "4"]]) == SETTING_DEFAULTS
        assert "needs 'setting' and 'value'" in capsys.readouterr().out

    def test_no_sheet_defaults(self, monkeypatch):
        monkeypatch.delenv("MODEL_CONFIG_SHEET_ID", raising=False)
        assert load_settings() == SETTING_DEFAULTS

    @patch("loaders.google.auth.default", return_value=(MagicMock(), "proj"))
    @patch("loaders.build")
    def test_missing_tab_defaults_and_logged(self, mock_build, _auth, monkeypatch, capsys):
        monkeypatch.setenv("MODEL_CONFIG_SHEET_ID", "sheet-1")
        mock_build.return_value.spreadsheets.return_value.values.return_value.get.return_value.execute.side_effect = \
            RuntimeError("Unable to parse range: Settings")
        assert load_settings() == SETTING_DEFAULTS
        assert "couldn't read the Settings tab" in capsys.readouterr().out


# ── Extract: PDF path ─────────────────────────────────────────────────────

ONE_MODEL = {"models": [{"role": EXTRACT_ROLE, "provider": "anthropic", "model": "claude", "active": True}]}
TWO_MODELS = {"models": [{"role": EXTRACT_ROLE, "provider": "anthropic", "model": "claude", "active": True},
                         {"role": EXTRACT_ROLE, "provider": "google", "model": "gemini", "active": True}]}


def blocks_json(n):
    return json.dumps({"blocks": [{"id": f"b{i}", "role": "body", "text": "x", "translate": True} for i in range(n)]})


@pytest.fixture
def pdf_run():
    with patch("extract.main.load_config", return_value=ONE_MODEL) as config, \
         patch("extract.main.load_pdf_bytes") as load_pdf, \
         patch("extract.main.load_settings", return_value=dict(SETTINGS)), \
         patch("extract.main.extract_text_with_pdfplumber", return_value="text"), \
         patch("extract.main.load_doc", return_value="prompt"), \
         patch("extract.main.call_llm") as call_llm, \
         patch("extract.main.write_output", return_value="drive-id") as write_output, \
         patch("extract.main.validate_extraction"), \
         patch("extract.main._append_processing_log_row", return_value=True) as log_row, \
         patch("extract.main.log_extraction_result"), \
         patch("extract.main.publish_extraction_complete", return_value=[]) as publish, \
         patch("extract.main.notify_not_processed") as not_processed, \
         patch("extract.main.notify_larger_than_designed") as larger, \
         patch("extract.main.notify_extraction_failed") as failed:
        load_pdf.return_value = real_pdf(1)
        call_llm.return_value = (blocks_json(10), {})
        yield MagicMock(config=config, load_pdf=load_pdf, call_llm=call_llm, write_output=write_output,
                        log_row=log_row, publish=publish, not_processed=not_processed, larger=larger, failed=failed)


def statuses(log_row):
    return [c.args[0][3] for c in log_row.call_args_list]


class TestPdfSizeChecks:
    def test_green_goes_through_with_size_saved(self, pdf_run):
        run_pdf_extraction("src", "a.pdf")
        pdf_run.publish.assert_called_once()
        saved = pdf_run.write_output.call_args_list[-1].args[1]
        assert saved["size"] == size_info(GREEN, 1, False, 10)
        pdf_run.larger.assert_not_called()

    def test_red_pages_stops_before_the_model_call(self, pdf_run):
        pdf_run.load_pdf.return_value = real_pdf(6)
        run_pdf_extraction("src", "long.pdf", submitted_by_email="a@b.org", submitted_by_name="A")
        pdf_run.call_llm.assert_not_called()
        pdf_run.publish.assert_not_called()
        assert statuses(pdf_run.log_row) == [STATUS_REJECTED]
        assert "6 pages" in pdf_run.log_row.call_args.args[0][5]
        reason = pdf_run.not_processed.call_args.args[1]
        assert reason.startswith("it's 6 pages, and the pilot supports up to 5.")
        assert pdf_run.not_processed.call_args.args[2:] == ("a@b.org", "A")

    def test_yellow_pages_translated_with_a_heads_up(self, pdf_run):
        pdf_run.load_pdf.return_value = real_pdf(4)
        run_pdf_extraction("src", "medium.pdf")
        pdf_run.publish.assert_called_once()
        assert pdf_run.larger.call_args.args[:2] == ("medium.pdf", "4 pages")
        assert pdf_run.write_output.call_args_list[-1].args[1]["size"]["category"] == YELLOW

    def test_yellow_blocks_heads_up(self, pdf_run):
        pdf_run.call_llm.return_value = (blocks_json(150), {})
        run_pdf_extraction("src", "dense.pdf")
        pdf_run.publish.assert_called_once()
        assert "large table" in pdf_run.larger.call_args.args[1]

    def test_red_blocks_saved_but_not_translated(self, pdf_run):
        pdf_run.call_llm.return_value = (blocks_json(201), {})
        run_pdf_extraction("src", "table.pdf")
        pdf_run.publish.assert_not_called()
        assert statuses(pdf_run.log_row) == [STATUS_REJECTED]
        assert "too many separate pieces of text" in pdf_run.not_processed.call_args.args[1]
        pdf_run.failed.assert_not_called()

    def test_one_model_red_the_other_goes_through(self, pdf_run):
        pdf_run.config.return_value = TWO_MODELS
        pdf_run.call_llm.side_effect = [(blocks_json(250), {}), (blocks_json(100), {})]
        run_pdf_extraction("src", "a.pdf")
        published = pdf_run.publish.call_args.args[2]
        assert [r["model"] for r in published] == ["gemini"]
        pdf_run.not_processed.assert_not_called()


# ── Extract: Google Docs / Word path ──────────────────────────────────────

@pytest.fixture
def text_run():
    with patch("extract.main.fetch_paragraphs_from_drive") as fetch, \
         patch("extract.main.load_settings", return_value=dict(SETTINGS)), \
         patch("extract.main.export_gdoc_pdf") as export, \
         patch("extract.main.write_output", return_value="drive-id") as write_output, \
         patch("extract.main._append_processing_log_row", return_value=True) as log_row, \
         patch("extract.main.log_extraction_result"), \
         patch("extract.main.publish_extraction_complete", return_value=[]) as publish, \
         patch("extract.main.notify_not_processed") as not_processed, \
         patch("extract.main.notify_larger_than_designed") as larger:
        fetch.return_value = ["Short paragraph."] * 5
        export.return_value = real_pdf(1)
        yield MagicMock(fetch=fetch, export=export, write_output=write_output, log_row=log_row, publish=publish,
                        not_processed=not_processed, larger=larger)


class TestTextSizeChecks:
    def test_google_doc_pages_from_its_pdf_export(self, text_run):
        text_run.export.return_value = real_pdf(7)
        run_text_extraction("doc", "Long doc", MIME_GOOGLE_DOCS)
        text_run.export.assert_called_once_with("doc")
        text_run.publish.assert_not_called()
        assert text_run.not_processed.call_args.args[1].startswith("it's 7 pages")

    def test_word_pages_estimated_and_labeled_about(self, text_run):
        text_run.fetch.return_value = ["word " * 1600]  # ~4 pages at 500 words a page
        run_text_extraction("doc", "report.docx", MIME_DOCX)
        text_run.export.assert_not_called()
        assert text_run.larger.call_args.args[1] == "about 4 pages"
        assert text_run.write_output.call_args.args[1]["size"] == size_info(YELLOW, 4, True, 1)

    def test_too_many_paragraphs_is_red(self, text_run):
        text_run.fetch.return_value = ["cell"] * 201
        run_text_extraction("doc", "Table doc", MIME_GOOGLE_DOCS)
        text_run.publish.assert_not_called()
        assert "too many separate pieces of text" in text_run.not_processed.call_args.args[1]

    def test_export_failure_skips_the_page_check_only(self, text_run):
        text_run.export.side_effect = RuntimeError("export too large")
        run_text_extraction("doc", "Doc", MIME_GOOGLE_DOCS)
        text_run.publish.assert_called_once()
        assert text_run.write_output.call_args.args[1]["size"]["pages"] is None

    def test_green_doc_has_size_saved_and_no_notice(self, text_run):
        run_text_extraction("doc", "Flyer", MIME_GOOGLE_DOCS)
        text_run.publish.assert_called_once()
        assert text_run.write_output.call_args.args[1]["size"] == size_info(GREEN, 1, False, 5)
        text_run.larger.assert_not_called()
        text_run.not_processed.assert_not_called()
