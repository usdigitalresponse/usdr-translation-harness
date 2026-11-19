import csv
import json
import os
from http import HTTPStatus
from unittest.mock import MagicMock, patch

import anthropic
import google.auth.exceptions
import httpx
import jsonschema
import pytest
from google.genai import errors as genai_errors

from eval.quality.main import (
    build_eval_prompt, build_result_row, eval_quality, evaluate_with_model,
    format_translation_for_review, get_active_models, log_structured,
    normalize_inline_blocks, parse_eval_response, run_quality_eval, validate_eval,
    write_combined_result, CRITERIA, EVAL_ROLE, PIPELINE_STAGE, STATUS_FAILED, STATUS_OK,
    eval_key, latest_result, runs_with_key, all_models_succeeded, rerun_limit,
    DEFAULT_RERUN_LIMIT, LIMIT_REACHED_MESSAGE,
)
from eval.quality.quality_llm import (
    call_llm, load_eval_schema, make_claude_client, make_gemini_client,
    PROVIDER_ANTHROPIC, PROVIDER_GOOGLE, BACKEND_VERTEX, BACKEND_DIRECT,
)
from eval.quality.quality_loaders import (
    append_result_row, parse_drive_file_id, _extract_structural_text,
    EVAL_RESULTS_HEADERS, EVAL_RESULTS_SHEET_NAME,
    _load_config_from_sheet, load_config, find_latest_eval_result,
)


def make_request(body=None):
    class FakeRequest:
        def get_json(self, silent=False):
            return body
    return FakeRequest()


def make_scores(overall=4.2, priority="Medium", score=4):
    scores = {criterion: {
        "score": score,
        "strengths": "clear",
        "issues": "none",
        "recommendations": "none",
        "priority": priority,
    } for criterion in CRITERIA}
    scores["weighted_overall_score"] = overall
    scores["overall_priority_rating"] = priority
    return scores


SAMPLE_TRANSLATION = {
    "blocks": [
        {"id": "b01", "original_text": "Hello", "translated_text": "Hola"},
        {"id": "b02", "original_text": "Goodbye", "translated_text": "Adiós"},
    ],
    "metadata": {
        "source_language": "English",
        "target_language": "Spanish",
        "overall_notes": "Register kept formal.",
    },
}


class TestEvalQualityEndpoint:
    def test_returns_400_when_no_url(self):
        body, status = eval_quality(make_request({}))
        assert status == HTTPStatus.BAD_REQUEST
        assert "error" in json.loads(body)

    def test_returns_400_when_body_is_none(self):
        body, status = eval_quality(make_request(None))
        assert status == HTTPStatus.BAD_REQUEST

    @patch("eval.quality.main.append_result_rows")
    @patch("eval.quality.main.write_combined_result", return_value="loc-xyz")
    @patch("eval.quality.main.run_quality_eval")
    def test_returns_200_with_evaluations(self, mock_run, mock_write, mock_rows):
        mock_run.return_value = [{"provider": "anthropic", "model": "claude-opus-4-8",
                                  "weightedOverallScore": 4.2}]
        body, status = eval_quality(make_request({"translationJsonUrl": "abc123"}))
        result = json.loads(body)

        assert status == HTTPStatus.OK
        assert result["status"] == "ok"
        assert result["translationFileId"] == "abc123"
        assert result["resultLocationId"] == "loc-xyz"
        assert len(result["evaluations"]) == 1
        mock_run.assert_called_once_with("abc123", None, None, active_models=None, rubric=None)

    @patch("eval.quality.main.append_result_rows")
    @patch("eval.quality.main.write_combined_result", return_value=None)
    @patch("eval.quality.main.run_quality_eval")
    def test_parses_file_id_out_of_drive_url(self, mock_run, mock_write, mock_rows):
        mock_run.return_value = [{"provider": "anthropic", "model": "m", "weightedOverallScore": 1}]
        url = "https://drive.google.com/file/d/FILE_ID_123/view?usp=sharing"
        body, status = eval_quality(make_request({"translationJsonUrl": url}))

        assert status == HTTPStatus.OK
        assert json.loads(body)["translationFileId"] == "FILE_ID_123"
        mock_run.assert_called_once_with("FILE_ID_123", None, None, active_models=None, rubric=None)

    @patch("eval.quality.main.append_result_rows")
    @patch("eval.quality.main.write_combined_result", return_value=None)
    @patch("eval.quality.main.run_quality_eval")
    def test_returns_partial_when_some_models_fail(self, mock_run, mock_write, mock_rows):
        mock_run.return_value = [
            {"provider": "anthropic", "model": "claude-opus-4-8", "weightedOverallScore": 4.2},
            {"provider": "google", "model": "gemini-3.5-flash", "error": "boom"},
        ]
        body, status = eval_quality(make_request({"translationJsonUrl": "abc123"}))

        assert status == HTTPStatus.OK
        assert json.loads(body)["status"] == "partial"

    @patch("eval.quality.main.append_result_rows")
    @patch("eval.quality.main.write_combined_result", return_value=None)
    @patch("eval.quality.main.run_quality_eval")
    def test_result_location_null_when_written_locally(self, mock_run, mock_write, mock_rows):
        mock_run.return_value = [{"provider": "google", "model": "m", "weightedOverallScore": 4}]
        body, _ = eval_quality(make_request({"blocks": [{"original_text": "a", "translated_text": "b"}]}))
        assert json.loads(body)["resultLocationId"] is None

    @patch("eval.quality.main.run_quality_eval")
    def test_returns_500_when_all_models_fail(self, mock_run):
        mock_run.return_value = [{"provider": "google", "model": "gemini-3.5-flash", "error": "boom"}]
        body, status = eval_quality(make_request({"translationJsonUrl": "abc123"}))

        assert status == HTTPStatus.INTERNAL_SERVER_ERROR
        assert json.loads(body)["error"] == "All eval models failed"

    @patch("eval.quality.main.run_quality_eval", side_effect=RuntimeError("no active models"))
    def test_returns_500_when_run_raises(self, mock_run):
        body, status = eval_quality(make_request({"translationJsonUrl": "abc123"}))

        assert status == HTTPStatus.INTERNAL_SERVER_ERROR
        assert json.loads(body)["error"] == "no active models"


class TestNormalizeInlineBlocks:
    def test_assigns_ids_and_trims(self):
        result = normalize_inline_blocks([
            {"original_text": "Hello", "translated_text": "Hola"},
            {"id": "x9", "original_text": " Bye ", "translated_text": " Adios "},
        ])
        assert [b["id"] for b in result["blocks"]] == ["b01", "x9"]
        assert result["blocks"][1]["translated_text"] == "Adios"

    def test_drops_fully_empty_blocks(self):
        result = normalize_inline_blocks([
            {"original_text": "Hello", "translated_text": "Hola"},
            {"original_text": "", "translated_text": "   "},
        ])
        assert len(result["blocks"]) == 1

    def test_keeps_block_with_only_one_side(self):
        result = normalize_inline_blocks([{"original_text": "Hello", "translated_text": ""}])
        assert len(result["blocks"]) == 1

    def test_raises_when_all_blocks_empty(self):
        with pytest.raises(ValueError, match="No non-empty blocks"):
            normalize_inline_blocks([{"original_text": "", "translated_text": ""}])

    def test_carries_metadata_through(self):
        meta = {"source_language": "English", "target_language": "Spanish"}
        result = normalize_inline_blocks([{"original_text": "a", "translated_text": "b"}], meta)
        assert result["metadata"] == meta

    def test_defaults_metadata_to_empty_dict(self):
        result = normalize_inline_blocks([{"original_text": "a", "translated_text": "b"}])
        assert result["metadata"] == {}


class TestInlineBlocksEndpoint:
    @patch("eval.quality.main.run_quality_eval")
    def test_accepts_blocks_without_translation_url(self, mock_run):
        mock_run.return_value = [{"provider": "google", "model": "m", "weightedOverallScore": 4}]
        body, status = eval_quality(make_request({
            "documentId": "doc-1",
            "blocks": [{"original_text": "Hello", "translated_text": "Hola"}],
        }))

        assert status == HTTPStatus.OK
        assert json.loads(body)["translationFileId"] == "doc-1"

        # blocks path must bypass the Drive fetch entirely
        file_id, translation_json, document_id = mock_run.call_args[0]
        assert file_id == "doc-1"
        assert document_id == "doc-1"
        assert translation_json["blocks"][0]["translated_text"] == "Hola"

    @patch("eval.quality.main.run_quality_eval")
    def test_labels_inline_when_no_document_id(self, mock_run):
        mock_run.return_value = [{"provider": "google", "model": "m", "weightedOverallScore": 4}]
        body, status = eval_quality(make_request({
            "blocks": [{"original_text": "Hello", "translated_text": "Hola"}],
        }))
        assert json.loads(body)["translationFileId"] == "inline"

    def test_returns_400_when_blocks_all_empty(self):
        body, status = eval_quality(make_request({
            "blocks": [{"original_text": "", "translated_text": ""}],
        }))
        assert status == HTTPStatus.BAD_REQUEST
        assert "Invalid blocks" in json.loads(body)["error"]

    def test_returns_400_when_blocks_malformed(self):
        body, status = eval_quality(make_request({"blocks": ["not-an-object"]}))
        assert status == HTTPStatus.BAD_REQUEST

    @patch("eval.quality.main.run_quality_eval")
    def test_blocks_take_precedence_over_url(self, mock_run):
        mock_run.return_value = [{"provider": "google", "model": "m", "weightedOverallScore": 4}]
        eval_quality(make_request({
            "translationJsonUrl": "abc123",
            "documentId": "doc-1",
            "blocks": [{"original_text": "Hello", "translated_text": "Hola"}],
        }))
        assert mock_run.call_args[0][1] is not None


class TestRunQualityEvalInlineJson:
    @patch("eval.quality.main.evaluate_with_model")
    @patch("eval.quality.main.load_doc", return_value="RUBRIC")
    @patch("eval.quality.main.load_translation_json")
    @patch("eval.quality.main.load_config")
    def test_skips_drive_fetch_when_json_supplied(self, mock_config, mock_load, mock_doc, mock_eval):
        mock_config.return_value = {"models": [
            {"role": "eval", "provider": "google", "model": "m", "active": True},
        ]}
        mock_eval.return_value = {"provider": "google", "model": "m"}

        run_quality_eval("doc-1", SAMPLE_TRANSLATION)

        mock_load.assert_not_called()


class TestWriteCombinedResult:
    EVALS = [
        {"provider": "anthropic", "model": "claude-opus-4-8", "scores": {"weighted_overall_score": 4.1}},
        {"provider": "google", "model": "gemini-3.5-flash", "scores": {"weighted_overall_score": 4.3}},
    ]

    @patch("eval.quality.main.write_eval_result", return_value="drive-file-1")
    def test_stores_hash_and_evaluations_not_the_translation(self, mock_write):
        location = write_combined_result("doc-1", "doc-1", "hash-abc", self.EVALS)

        assert location == "drive-file-1"
        filename, payload, properties = mock_write.call_args[0]
        assert filename.endswith("_combined_eval.json")
        assert payload["evaluations"] == self.EVALS
        assert payload["contentHash"] == "hash-abc"
        assert "blocks" not in payload  # translation is not duplicated into the result
        assert payload["documentId"] == "doc-1"
        # Tagged so the add-on can query Drive for this doc's latest result.
        assert properties["documentId"] == "doc-1"

    @patch("eval.quality.main.write_eval_result", return_value=None)
    def test_returns_none_when_written_locally(self, mock_write):
        assert write_combined_result("doc-1", None, "h", self.EVALS) is None

    @patch("eval.quality.main.write_eval_result", return_value=None)
    def test_no_properties_tag_without_a_document_id(self, mock_write):
        write_combined_result("inline", None, "h", self.EVALS)
        assert mock_write.call_args[0][2] is None  # properties


class TestExtractStructuralText:
    def _para(self, s):
        return {"paragraph": {"elements": [{"textRun": {"content": s}}]}}

    def test_reads_paragraph_text(self):
        assert _extract_structural_text([self._para("Hello "), self._para("world")]) == "Hello world"

    def test_reads_table_cell_text_that_paragraphs_only_would_drop(self):
        table = {"table": {"tableRows": [
            {"tableCells": [
                {"content": [self._para("Score 5")]},
                {"content": [self._para("Excellent")]},
            ]},
        ]}}
        out = _extract_structural_text([self._para("Rubric\n"), table])
        assert "Rubric" in out
        assert "Score 5" in out and "Excellent" in out  # table content preserved

    def test_recurses_into_nested_tables(self):
        inner = {"table": {"tableRows": [{"tableCells": [{"content": [self._para("deep")]}]}]}}
        outer = {"table": {"tableRows": [{"tableCells": [{"content": [inner]}]}]}}
        assert "deep" in _extract_structural_text([outer])


class TestParseDriveFileId:
    @pytest.mark.parametrize("value,expected", [
        ("abc123", "abc123"),
        ("https://drive.google.com/file/d/FILE_ID/view", "FILE_ID"),
        ("https://docs.google.com/document/d/FILE_ID/edit#gid=0", "FILE_ID"),
        ("https://drive.google.com/open?id=FILE_ID", "FILE_ID"),
        ("https://drive.google.com/file/123", "123"),
    ])
    def test_parses_supported_shapes(self, value, expected):
        assert parse_drive_file_id(value) == expected

    def test_raises_on_empty(self):
        with pytest.raises(ValueError):
            parse_drive_file_id("")


class TestAppendResultRow:
    """The results sheet provisions itself, so an empty spreadsheet works."""

    def _service(self, existing_tabs, existing_header):
        service = MagicMock()
        service.spreadsheets.return_value.get.return_value.execute.return_value = {
            "sheets": [{"properties": {"title": t}} for t in existing_tabs]
        }
        values = service.spreadsheets.return_value.values.return_value
        values.get.return_value.execute.return_value = (
            {"values": [existing_header]} if existing_header else {}
        )
        return service

    def _run(self, service, row=None):
        with patch("eval.quality.quality_loaders.google.auth.default",
                   return_value=(MagicMock(), "proj")):
            with patch("eval.quality.quality_loaders.build", return_value=service):
                with patch.dict("os.environ", {"EVAL_QUALITY_RESULTS_SHEET_ID": "sheet-1"}):
                    append_result_row(row or ["ts", "file-1", "google", "m", 4.2, "Medium",
                                              4, 4, 4, 4, 4, "res-1"])

    def test_creates_tab_when_missing(self):
        service = self._service(["Sheet1"], None)
        self._run(service)

        batch = service.spreadsheets.return_value.batchUpdate
        batch.assert_called_once()
        request = batch.call_args[1]["body"]["requests"][0]
        assert request["addSheet"]["properties"]["title"] == EVAL_RESULTS_SHEET_NAME

    def test_does_not_recreate_existing_tab(self):
        service = self._service([EVAL_RESULTS_SHEET_NAME], EVAL_RESULTS_HEADERS)
        self._run(service)
        service.spreadsheets.return_value.batchUpdate.assert_not_called()

    def test_writes_header_when_sheet_is_empty(self):
        service = self._service(["Sheet1"], None)
        self._run(service)

        update = service.spreadsheets.return_value.values.return_value.update
        update.assert_called_once()
        assert update.call_args[1]["body"]["values"][0] == EVAL_RESULTS_HEADERS

    def test_does_not_rewrite_existing_header(self):
        service = self._service([EVAL_RESULTS_SHEET_NAME], EVAL_RESULTS_HEADERS)
        self._run(service)
        service.spreadsheets.return_value.values.return_value.update.assert_not_called()

    def test_appends_the_row(self):
        service = self._service([EVAL_RESULTS_SHEET_NAME], EVAL_RESULTS_HEADERS)
        row = ["ts", "file-1", "google", "m", 4.2, "Medium", 4, 3, 5, 4, 4, "res-1"]
        self._run(service, row)

        append = service.spreadsheets.return_value.values.return_value.append
        append.assert_called_once()
        assert append.call_args[1]["body"]["values"] == [row]
        assert append.call_args[1]["range"].startswith(EVAL_RESULTS_SHEET_NAME)

    def test_header_count_matches_row_width(self):
        row = build_result_row("file-1", "google", "m", make_scores(), "res-1")
        assert len(EVAL_RESULTS_HEADERS) == len(row)

    def test_skips_entirely_when_sheet_id_unset(self):
        with patch("eval.quality.quality_loaders.build") as mock_build:
            with patch.dict("os.environ", {}, clear=False):
                os.environ.pop("EVAL_QUALITY_RESULTS_SHEET_ID", None)
                os.environ.pop("LOCAL_EVAL_RESULTS_CSV", None)
                append_result_row(["ts"])
        mock_build.assert_not_called()


class TestAppendResultRowLocalCsv:
    """LOCAL_EVAL_RESULTS_CSV routes results to a file instead of Sheets."""

    def _append(self, csv_path, row):
        with patch("eval.quality.quality_loaders.build") as mock_build:
            with patch.dict("os.environ", {"LOCAL_EVAL_RESULTS_CSV": str(csv_path)}):
                append_result_row(row)
        # Local path must never touch the Sheets client.
        mock_build.assert_not_called()

    def test_writes_header_then_row_to_new_file(self, tmp_path):
        csv_path = tmp_path / "results.csv"
        row = ["ts", "file-1", "google", "m", 4.2, "Medium", 4, 4, 4, 4, 4, "res-1"]
        self._append(csv_path, row)

        rows = list(csv.reader(csv_path.open(encoding="utf-8")))
        assert rows[0] == EVAL_RESULTS_HEADERS
        assert rows[1] == [str(c) for c in row]

    def test_appends_without_repeating_header(self, tmp_path):
        csv_path = tmp_path / "results.csv"
        self._append(csv_path, ["ts1", "f1", "google", "m", 4.2, "Medium", 4, 4, 4, 4, 4, "r1"])
        self._append(csv_path, ["ts2", "f2", "anthropic", "m", 3.1, "High", 3, 3, 3, 3, 3, "r2"])

        rows = list(csv.reader(csv_path.open(encoding="utf-8")))
        assert len(rows) == 3  # header + two data rows
        assert rows.count(EVAL_RESULTS_HEADERS) == 1
        assert rows[2][2] == "anthropic"

    def test_creates_parent_directory(self, tmp_path):
        csv_path = tmp_path / "nested" / "dir" / "results.csv"
        self._append(csv_path, ["ts", "f", "google", "m", 5, "Low", 5, 5, 5, 5, 5, ""])
        assert csv_path.exists()

    def test_preserves_unicode(self, tmp_path):
        csv_path = tmp_path / "results.csv"
        self._append(csv_path, ["ts", "Licencia Médica", "google", "m", 5, "Low", 5, 5, 5, 5, 5, ""])
        assert "Médica" in csv_path.read_text(encoding="utf-8")

    def test_local_csv_takes_precedence_over_sheet_id(self, tmp_path):
        csv_path = tmp_path / "results.csv"
        with patch("eval.quality.quality_loaders.build") as mock_build:
            with patch.dict("os.environ", {
                "LOCAL_EVAL_RESULTS_CSV": str(csv_path),
                "EVAL_QUALITY_RESULTS_SHEET_ID": "sheet-1",
            }):
                append_result_row(["ts", "f", "google", "m", 5, "Low", 5, 5, 5, 5, 5, ""])
        mock_build.assert_not_called()
        assert csv_path.exists()


class TestGetActiveModels:
    SAMPLE_CONFIG = {
        "models": [
            {"role": "eval", "provider": "anthropic", "model": "claude-opus-4-8", "active": True},
            {"role": "eval", "provider": "google", "model": "gemini-3.5-flash", "active": False},
            {"role": "translate", "provider": "anthropic", "model": "claude-sonnet-4-6", "active": True},
        ]
    }

    def test_returns_only_active_models_for_role(self):
        result = get_active_models(self.SAMPLE_CONFIG, EVAL_ROLE)
        assert len(result) == 1
        assert result[0]["model"] == "claude-opus-4-8"

    def test_returns_empty_when_none_active(self):
        config = {"models": [
            {"role": "eval", "provider": "anthropic", "model": "claude-opus-4-8", "active": False},
        ]}
        assert get_active_models(config, EVAL_ROLE) == []


class TestFormatTranslationForReview:
    def test_renders_source_target_pairs(self):
        text = format_translation_for_review(SAMPLE_TRANSLATION)
        assert "[b01]\nSource: Hello\nTranslation: Hola" in text
        assert "[b02]\nSource: Goodbye\nTranslation: Adiós" in text

    def test_includes_translator_notes(self):
        text = format_translation_for_review(SAMPLE_TRANSLATION)
        assert "[translator notes]\nRegister kept formal." in text

    def test_omits_notes_when_absent(self):
        text = format_translation_for_review({"blocks": [], "metadata": {}})
        assert "translator notes" not in text


class TestBuildEvalPrompt:
    def test_includes_rubric_languages_and_translation(self):
        prompt = build_eval_prompt("RUBRIC TEXT", SAMPLE_TRANSLATION)
        assert prompt.startswith("RUBRIC TEXT")
        assert "English to Spanish translation" in prompt
        assert "<translation>\n[b01]" in prompt
        assert prompt.endswith("</translation>")

    def test_falls_back_to_unknown_languages(self):
        prompt = build_eval_prompt("RUBRIC", {"blocks": [], "metadata": {}})
        assert "unknown to unknown translation" in prompt


class TestParseEvalResponse:
    def test_parses_bare_json(self):
        assert parse_eval_response('{"weighted_overall_score": 4.2}') == {"weighted_overall_score": 4.2}

    def test_parses_json_inside_markdown_fence(self):
        raw = '```json\n{"weighted_overall_score": 4.2}\n```'
        assert parse_eval_response(raw) == {"weighted_overall_score": 4.2}

    def test_raises_on_invalid_json(self):
        with pytest.raises(json.JSONDecodeError):
            parse_eval_response("not json")


class TestValidateEval:
    def test_accepts_complete_scores(self):
        validate_eval(make_scores())

    def test_rejects_missing_criterion(self):
        scores = make_scores()
        del scores["cultural_sensitivity"]
        with pytest.raises(jsonschema.ValidationError):
            validate_eval(scores)

    def test_rejects_invalid_priority(self):
        scores = make_scores()
        scores["overall_priority_rating"] = "Urgent"
        with pytest.raises(jsonschema.ValidationError):
            validate_eval(scores)


class TestBuildResultRow:
    def test_row_matches_sheet_column_order(self):
        row = build_result_row("file-1", "anthropic", "claude-opus-4-8", make_scores(), "result-1")

        assert row[1] == "file-1"
        assert row[2] == "anthropic"
        assert row[3] == "claude-opus-4-8"
        assert row[4] == 4.2
        assert row[5] == "Medium"
        assert row[6:11] == [4, 4, 4, 4, 4]
        assert row[11] == "result-1"

    def test_blanks_result_file_id_when_written_locally(self):
        row = build_result_row("file-1", "anthropic", "claude-opus-4-8", make_scores(), None)
        assert row[11] == ""


class TestEvaluateWithModel:
    MODEL_CONFIG = {"role": "eval", "provider": "anthropic", "model": "claude-opus-4-8", "active": True}

    @patch("eval.quality.main.call_llm")
    def test_returns_summary_with_full_scores(self, mock_llm):
        mock_llm.return_value = (json.dumps(make_scores()), {"input_tokens": 10, "output_tokens": 20})

        result = evaluate_with_model(self.MODEL_CONFIG, "PROMPT")

        mock_llm.assert_called_once_with("anthropic", "claude-opus-4-8", "PROMPT")
        assert result["provider"] == "anthropic"
        assert result["weightedOverallScore"] == 4.2
        assert result["overallPriorityRating"] == "Medium"
        # Full per-criterion detail is carried for the combined file / sidebar.
        assert result["scores"]["accuracy_and_relevance"]["score"] == 4

    @patch("eval.quality.main.write_eval_result")
    @patch("eval.quality.main.append_result_row")
    @patch("eval.quality.main.call_llm")
    def test_does_not_write_a_per_model_file_or_row(self, mock_llm, mock_append, mock_write):
        mock_llm.return_value = (json.dumps(make_scores()), {"input_tokens": 10, "output_tokens": 20})

        evaluate_with_model(self.MODEL_CONFIG, "PROMPT")

        # Per-model persistence moved out; the combined file + rows happen later.
        mock_write.assert_not_called()
        mock_append.assert_not_called()


class TestAppendResultRows:
    EVALS = [
        {"provider": "anthropic", "model": "claude-opus-4-8", "scores": make_scores(4, 4.1, "Low")},
        {"provider": "google", "model": "gemini-3.5-flash", "scores": make_scores(3, 3.2, "High")},
    ]

    @patch("eval.quality.main.append_result_row")
    def test_appends_one_row_per_model_linking_the_combined_file(self, mock_append):
        from eval.quality.main import append_result_rows
        append_result_rows("doc-1", self.EVALS, "combined-loc")

        assert mock_append.call_count == 2
        rows = [c.args[0] for c in mock_append.call_args_list]
        assert rows[0][3] == "claude-opus-4-8"
        assert all(r[11] == "combined-loc" for r in rows)  # all point at combined

    @patch("eval.quality.main.append_result_row", side_effect=RuntimeError("sheet down"))
    def test_row_failure_does_not_raise(self, mock_append):
        from eval.quality.main import append_result_rows
        append_result_rows("doc-1", self.EVALS, None)  # must not propagate


class TestRunQualityEval:
    CONFIG = {"models": [
        {"role": "eval", "provider": "anthropic", "model": "claude-opus-4-8", "active": True},
        {"role": "eval", "provider": "google", "model": "gemini-3.5-flash", "active": True},
    ]}

    @patch("eval.quality.main.evaluate_with_model")
    @patch("eval.quality.main.load_doc", return_value="RUBRIC")
    @patch("eval.quality.main.load_translation_json", return_value=SAMPLE_TRANSLATION)
    @patch("eval.quality.main.load_config")
    def test_runs_every_active_model(self, mock_config, mock_translation, mock_doc, mock_eval):
        mock_config.return_value = self.CONFIG
        mock_eval.side_effect = lambda m, prompt: {"provider": m["provider"], "model": m["model"]}

        results = run_quality_eval("file-1")

        assert len(results) == 2
        assert mock_eval.call_count == 2
        assert mock_doc.call_args[0][0] == "EVALUATION_RUBRIC_DOC_ID"

    @patch("eval.quality.main.evaluate_with_model")
    @patch("eval.quality.main.load_doc", return_value="RUBRIC")
    @patch("eval.quality.main.load_translation_json", return_value=SAMPLE_TRANSLATION)
    @patch("eval.quality.main.load_config")
    def test_preserves_model_order_despite_completion_order(self, mock_config, mock_translation, mock_doc, mock_eval):
        import time
        mock_config.return_value = self.CONFIG

        def slow_first(m, prompt):
            # Force the first model (claude) to finish AFTER the second, so a
            # naive append would reorder — the indexed placement must not.
            if m["provider"] == "anthropic":
                time.sleep(0.15)
            return {"provider": m["provider"], "model": m["model"]}

        mock_eval.side_effect = slow_first
        results = run_quality_eval("file-1")

        assert [r["provider"] for r in results] == ["anthropic", "google"]

    @patch("eval.quality.main.evaluate_with_model", side_effect=RuntimeError("api down"))
    @patch("eval.quality.main.load_doc", return_value="RUBRIC")
    @patch("eval.quality.main.load_translation_json", return_value=SAMPLE_TRANSLATION)
    @patch("eval.quality.main.load_config")
    def test_records_error_per_failed_model(self, mock_config, mock_translation, mock_doc, mock_eval):
        mock_config.return_value = self.CONFIG
        results = run_quality_eval("file-1")

        assert len(results) == 2
        assert all(r["error"] == "api down" for r in results)

    @patch("eval.quality.main.load_config", return_value={"models": []})
    def test_raises_when_no_active_models(self, mock_config):
        with pytest.raises(RuntimeError, match="No active models"):
            run_quality_eval("file-1")


VERTEX_ENV = {"VERTEX_PROJECT_ID": "proj", "VERTEX_LOCATION": "us"}


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


def _llm_ok(*_args, **_kwargs):
    # Fresh dict per call: call_llm adds fields to the usage dict it gets back
    return "{}", {"input_tokens": 1}


class TestCallLlm:
    @patch("eval.quality.quality_llm.make_claude_client", side_effect=lambda backend: backend)
    @patch("eval.quality.quality_llm.call_claude", side_effect=_llm_ok)
    def test_claude_uses_vertex_first_with_claude_schema(self, mock_claude, _client):
        with patch.dict("os.environ", VERTEX_ENV):
            text, usage = call_llm(PROVIDER_ANTHROPIC, "claude-opus-4-8", "prompt")

        assert text == "{}"
        assert mock_claude.call_args[0][0] == BACKEND_VERTEX
        assert mock_claude.call_args[1]["model"] == "claude-opus-4-8"
        assert mock_claude.call_args[1]["output_schema"]["additionalProperties"] is False
        assert usage == {"input_tokens": 1, "llm_backend": BACKEND_VERTEX}

    @patch("eval.quality.quality_llm.make_gemini_client", side_effect=lambda backend: backend)
    @patch("eval.quality.quality_llm.call_gemini", side_effect=_llm_ok)
    def test_gemini_uses_vertex_first_with_gemini_schema(self, mock_gemini, _client):
        with patch.dict("os.environ", VERTEX_ENV):
            _, usage = call_llm(PROVIDER_GOOGLE, "gemini-3.5-flash", "prompt")

        assert mock_gemini.call_args[0][0] == BACKEND_VERTEX
        assert "additionalProperties" not in mock_gemini.call_args[1]["output_schema"]
        assert usage["llm_backend"] == BACKEND_VERTEX

    @pytest.mark.parametrize("status", [401, 403, 404, 429])
    @patch("eval.quality.quality_llm.make_claude_client", side_effect=lambda backend: backend)
    @patch("eval.quality.quality_llm.call_claude")
    def test_claude_falls_back_on_pre_generation_errors(self, mock_claude, _client, status):
        mock_claude.side_effect = [_anthropic_status_error(status), _llm_ok()]
        with patch.dict("os.environ", VERTEX_ENV):
            _, usage = call_llm(PROVIDER_ANTHROPIC, "claude-opus-4-8", "prompt")

        assert [c[0][0] for c in mock_claude.call_args_list] == [BACKEND_VERTEX, BACKEND_DIRECT]
        assert usage["llm_backend"] == BACKEND_DIRECT
        assert f"HTTP {status}" in usage["llm_fallback_reason"]

    @patch("eval.quality.quality_llm.make_gemini_client", side_effect=lambda backend: backend)
    @patch("eval.quality.quality_llm.call_gemini")
    def test_gemini_falls_back_when_model_not_found(self, mock_gemini, _client):
        mock_gemini.side_effect = [
            genai_errors.ClientError(404, {"error": {"code": 404, "message": "x", "status": "NOT_FOUND"}}),
            _llm_ok(),
        ]
        with patch.dict("os.environ", VERTEX_ENV):
            _, usage = call_llm(PROVIDER_GOOGLE, "gemini-3.5-flash", "prompt")

        assert usage["llm_backend"] == BACKEND_DIRECT
        assert usage["llm_fallback_reason"] == "HTTP 404: NOT_FOUND"

    @patch("eval.quality.quality_llm.call_claude", side_effect=_llm_ok)
    def test_falls_back_when_vertex_not_configured(self, mock_claude):
        with patch.dict("os.environ", {}):
            os.environ.pop("VERTEX_PROJECT_ID", None)
            os.environ.pop("LLM_BACKEND", None)
            _, usage = call_llm(PROVIDER_ANTHROPIC, "claude-opus-4-8", "prompt")

        mock_claude.assert_called_once()
        assert usage["llm_fallback_reason"] == "vertex not configured"

    @patch("eval.quality.quality_llm.make_claude_client", side_effect=lambda backend: backend)
    @patch("eval.quality.quality_llm.call_claude")
    def test_credential_errors_fall_back(self, mock_claude, _client):
        mock_claude.side_effect = [google.auth.exceptions.DefaultCredentialsError("no creds"), _llm_ok()]
        with patch.dict("os.environ", VERTEX_ENV):
            _, usage = call_llm(PROVIDER_ANTHROPIC, "claude-opus-4-8", "prompt")

        assert usage["llm_fallback_reason"] == "credentials: DefaultCredentialsError"

    @pytest.mark.parametrize("err", [
        _anthropic_status_error(500),
        _anthropic_status_error(400),
        TimeoutError("took too long"),
    ])
    @patch("eval.quality.quality_llm.make_claude_client", side_effect=lambda backend: backend)
    @patch("eval.quality.quality_llm.call_claude")
    def test_other_errors_do_not_fall_back(self, mock_claude, _client, err):
        mock_claude.side_effect = err
        with patch.dict("os.environ", VERTEX_ENV), pytest.raises(type(err)):
            call_llm(PROVIDER_ANTHROPIC, "claude-opus-4-8", "prompt")

        assert mock_claude.call_count == 1

    @patch("eval.quality.quality_llm.make_claude_client", side_effect=lambda backend: backend)
    @patch("eval.quality.quality_llm.call_claude")
    def test_vertex_only_raises_instead_of_falling_back(self, mock_claude, _client):
        mock_claude.side_effect = _anthropic_status_error(404)
        with patch.dict("os.environ", {**VERTEX_ENV, "LLM_BACKEND": "vertex-only"}), \
                pytest.raises(anthropic.NotFoundError):
            call_llm(PROVIDER_ANTHROPIC, "claude-opus-4-8", "prompt")

        assert mock_claude.call_count == 1

    @patch("eval.quality.quality_llm.make_claude_client", side_effect=lambda backend: backend)
    @patch("eval.quality.quality_llm.call_claude", side_effect=_llm_ok)
    def test_direct_only_skips_vertex(self, mock_claude, _client):
        with patch.dict("os.environ", {**VERTEX_ENV, "LLM_BACKEND": "direct-only"}):
            _, usage = call_llm(PROVIDER_ANTHROPIC, "claude-opus-4-8", "prompt")

        assert mock_claude.call_args[0][0] == BACKEND_DIRECT
        assert "llm_fallback_reason" not in usage

    def test_raises_on_unknown_provider(self):
        with pytest.raises(ValueError, match="No eval schema"):
            call_llm("openai", "gpt-4", "prompt")


class TestVertexClients:
    @patch("eval.quality.quality_llm.anthropic.AnthropicVertex")
    def test_claude_vertex_client_uses_project_and_location(self, mock_vertex):
        with patch.dict("os.environ", VERTEX_ENV):
            make_claude_client(BACKEND_VERTEX)
        assert mock_vertex.call_args[1]["project_id"] == "proj"
        assert mock_vertex.call_args[1]["region"] == "us"

    @patch("eval.quality.quality_llm.genai.Client")
    def test_gemini_vertex_client_keeps_timeout(self, mock_client):
        with patch.dict("os.environ", VERTEX_ENV):
            make_gemini_client(BACKEND_VERTEX)
        kwargs = mock_client.call_args[1]
        assert kwargs["vertexai"] is True
        assert kwargs["project"] == "proj"
        assert kwargs["location"] == "us"
        assert kwargs["http_options"].timeout == 240_000


class TestLogStructured:
    def _emit(self, capsys, *args, **kwargs):
        log_structured(*args, **kwargs)
        return json.loads(capsys.readouterr().out.strip())

    def test_success_line_carries_metrics_for_dashboards(self, capsys):
        entry = self._emit(
            capsys, STATUS_OK, "anthropic", "claude-opus-4-8", "file-1",
            document_id="doc-1", scores=make_scores(4.2, "Medium"),
            usage={"input_tokens": 100, "output_tokens": 50}, duration_ms=1234,
        )
        assert entry["severity"] == "INFO"
        assert entry["pipeline_stage"] == PIPELINE_STAGE
        assert entry["status"] == STATUS_OK
        assert entry["provider"] == "anthropic"
        assert entry["translationFileId"] == "file-1"
        assert entry["documentId"] == "doc-1"
        assert entry["weightedOverallScore"] == 4.2
        assert entry["overallPriorityRating"] == "Medium"
        assert entry["input_tokens"] == 100
        assert entry["output_tokens"] == 50
        assert entry["duration_ms"] == 1234

    def test_failure_line_is_error_severity_with_error_text(self, capsys):
        entry = self._emit(capsys, STATUS_FAILED, "google", "gemini-3.5-flash", "file-1",
                           error="api down")
        assert entry["severity"] == "ERROR"
        assert entry["error"] == "api down"
        # Absent optional fields are omitted rather than logged as null.
        assert "weightedOverallScore" not in entry
        assert "duration_ms" not in entry


class TestLoadEvalSchema:
    def test_both_provider_schemas_define_the_same_criteria(self):
        claude = load_eval_schema(PROVIDER_ANTHROPIC)
        gemini = load_eval_schema(PROVIDER_GOOGLE)
        assert claude["required"] == gemini["required"]
        assert set(CRITERIA) <= set(claude["properties"])


class TestModelConfigChecks:
    @staticmethod
    def _input_problems(capsys):
        entries = []
        for line in capsys.readouterr().out.splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if entry.get("input_problem"):
                entries.append(entry)
        return entries

    @patch("eval.quality.quality_loaders.build")
    @patch("eval.quality.quality_loaders.google.auth.default", return_value=(MagicMock(), "project"))
    def test_missing_header_row_names_missing_columns(self, _auth, mock_build, capsys):
        mock_build.return_value.spreadsheets().values().get().execute.return_value = {
            "values": [["Last updated: Oct 1"], ["Role", "Provider", "Model", "Active"]]
        }

        with pytest.raises(ValueError, match="missing expected columns: role, provider, model, active"):
            _load_config_from_sheet("sheet-id-123")

        [problem] = self._input_problems(capsys)
        assert problem["input_problem"] == "model_config"
        assert problem["message"].startswith("Quality eval input problem (model_config)")

    @patch("eval.quality.quality_loaders.build")
    @patch("eval.quality.quality_loaders.google.auth.default", return_value=(MagicMock(), "project"))
    def test_valid_sheet_parses(self, _auth, mock_build, capsys):
        mock_build.return_value.spreadsheets().values().get().execute.return_value = {
            "values": [["Role", "Provider", "Model", "Active"], ["eval", "Anthropic", "claude-opus-5", "YES"]]
        }

        config = _load_config_from_sheet("sheet-id-123")

        assert config["models"] == [{"role": "eval", "provider": "anthropic", "model": "claude-opus-5", "active": True}]
        assert self._input_problems(capsys) == []

    def test_missing_sheet_id_on_cloud_run_raises(self):
        with patch.dict("os.environ", {"K_SERVICE": "eval-quality"}):
            with pytest.raises(ValueError, match="MODEL_CONFIG_SHEET_ID is not set"):
                load_config()


# ── Skipping an evaluation when nothing changed ───────────────────────────

MODELS = [{"role": EVAL_ROLE, "provider": "google", "model": "gemini", "active": True},
          {"role": EVAL_ROLE, "provider": "anthropic", "model": "claude", "active": True}]
RUBRIC = "Score accuracy 1-5."
GOOD_EVALS = [{"provider": "anthropic", "model": "claude", "weightedOverallScore": 4.2, "scores": {}}]
BLOCKS_BODY = {"documentId": "doc-1", "contentHash": "hash-1", "skipIfUnchanged": True,
               "blocks": [{"id": "b01", "original_text": "Hello", "translated_text": "Hola"}]}


def saved_result(**overrides):
    payload = {"documentId": "doc-1", "evaluatedAt": "2026-11-18T10:00:00",
               **eval_key("hash-1", MODELS, RUBRIC), "evaluations": GOOD_EVALS}
    payload.update(overrides)
    return payload, "saved-file-1"


class TestEvalKey:
    def test_same_inputs_same_key_and_model_order_doesnt_matter(self):
        assert eval_key("h", MODELS, RUBRIC) == eval_key("h", list(reversed(MODELS)), RUBRIC)

    def test_text_models_and_rubric_each_change_the_key(self):
        base = eval_key("h", MODELS, RUBRIC)
        assert eval_key("other", MODELS, RUBRIC) != base
        assert eval_key("h", MODELS[:1], RUBRIC) != base
        assert eval_key("h", MODELS, RUBRIC + " Also tone.") != base

    def test_key_fields(self):
        key = eval_key("h", MODELS, RUBRIC)
        assert key["contentHash"] == "h"
        assert key["modelSet"] == ["anthropic/claude", "google/gemini"]
        assert len(key["rubricHash"]) == 64


class TestRunCounting:
    KEY = eval_key("hash-1", MODELS, RUBRIC)

    def test_counts_runs_of_the_same_input(self):
        assert runs_with_key(saved_result(runsWithThisKey=7), self.KEY) == 7

    def test_result_saved_before_counts_existed_counts_as_one(self):
        assert runs_with_key(saved_result(), self.KEY) == 1

    @pytest.mark.parametrize("change", [
        {"contentHash": "edited"}, {"modelSet": ["anthropic/claude"]}, {"rubricHash": "0" * 64},
    ])
    def test_changed_input_starts_over(self, change):
        assert runs_with_key(saved_result(runsWithThisKey=50, **change), self.KEY) == 0

    def test_result_saved_before_keys_existed_doesnt_count(self):
        payload, location = saved_result()
        del payload["modelSet"], payload["rubricHash"]
        assert runs_with_key((payload, location), self.KEY) == 0

    def test_nothing_saved(self):
        assert runs_with_key(None, self.KEY) == 0

    def test_all_models_succeeded(self):
        assert all_models_succeeded(saved_result()[0])
        assert not all_models_succeeded(saved_result(evaluations=GOOD_EVALS + [{"error": "timeout"}])[0])
        assert not all_models_succeeded(saved_result(evaluations=[])[0])

    @patch("eval.quality.main.find_latest_eval_result", side_effect=RuntimeError("Drive down"))
    def test_lookup_failure_means_run_it(self, _find):
        assert latest_result("doc-1") is None


class TestRerunLimitSetting:
    def test_default(self, monkeypatch):
        monkeypatch.delenv("EVAL_RERUN_LIMIT", raising=False)
        assert rerun_limit() == DEFAULT_RERUN_LIMIT == 100

    def test_setting(self, monkeypatch):
        monkeypatch.setenv("EVAL_RERUN_LIMIT", "25")
        assert rerun_limit() == 25

    @pytest.mark.parametrize("bad", ["0", "-3", "lots"])
    def test_bad_setting_uses_default(self, monkeypatch, bad):
        monkeypatch.setenv("EVAL_RERUN_LIMIT", bad)
        assert rerun_limit() == DEFAULT_RERUN_LIMIT


@patch("eval.quality.main.load_eval_inputs", return_value=(MODELS, RUBRIC))
@patch("eval.quality.main.append_result_rows")
@patch("eval.quality.main.write_combined_result", return_value="new-file")
@patch("eval.quality.main.run_quality_eval", return_value=GOOD_EVALS)
class TestEndpointReuse:
    def test_unchanged_returns_saved_result_without_calling_models(self, mock_run, mock_write, mock_rows, _inputs):
        with patch("eval.quality.main.find_latest_eval_result", return_value=saved_result()):
            body, status = eval_quality(make_request(BLOCKS_BODY))
        result = json.loads(body)
        assert status == HTTPStatus.OK
        assert result["cached"] is True
        assert result["limitReached"] is False
        assert result["evaluatedAt"] == "2026-11-18T10:00:00"
        assert result["resultLocationId"] == "saved-file-1"
        assert result["evaluations"] == GOOD_EVALS
        mock_run.assert_not_called()
        mock_write.assert_not_called()
        mock_rows.assert_not_called()

    def test_without_the_flag_the_models_always_run(self, mock_run, mock_write, mock_rows, _inputs):
        body_without_flag = {k: v for k, v in BLOCKS_BODY.items() if k != "skipIfUnchanged"}
        with patch("eval.quality.main.find_latest_eval_result", return_value=saved_result()):
            body, _ = eval_quality(make_request(body_without_flag))
        assert json.loads(body)["cached"] is False
        mock_run.assert_called_once_with("doc-1", mock_run.call_args[0][1], "doc-1", active_models=MODELS, rubric=RUBRIC)

    def test_changed_text_runs_and_saves_the_new_key_with_count_one(self, mock_run, mock_write, mock_rows, _inputs):
        with patch("eval.quality.main.find_latest_eval_result", return_value=saved_result(contentHash="old", runsWithThisKey=9)):
            body, _ = eval_quality(make_request(BLOCKS_BODY))
        assert json.loads(body)["cached"] is False
        mock_run.assert_called_once()
        assert mock_write.call_args[0][4] == eval_key("hash-1", MODELS, RUBRIC)
        assert mock_write.call_args.kwargs["runs"] == 1

    def test_run_again_on_unchanged_input_counts_up(self, mock_run, mock_write, mock_rows, _inputs):
        body_without_flag = {k: v for k, v in BLOCKS_BODY.items() if k != "skipIfUnchanged"}
        with patch("eval.quality.main.find_latest_eval_result", return_value=saved_result(runsWithThisKey=4)):
            eval_quality(make_request(body_without_flag))
        mock_run.assert_called_once()
        assert mock_write.call_args.kwargs["runs"] == 5

    @pytest.mark.parametrize("skip_flag", [True, False])
    def test_at_the_limit_no_models_and_the_saved_result_comes_back(self, mock_run, mock_write, mock_rows, _inputs,
                                                                     skip_flag, monkeypatch):
        monkeypatch.setenv("EVAL_RERUN_LIMIT", "3")
        request_body = {**BLOCKS_BODY, "skipIfUnchanged": skip_flag}
        with patch("eval.quality.main.find_latest_eval_result", return_value=saved_result(runsWithThisKey=3)):
            body, status = eval_quality(make_request(request_body))
        result = json.loads(body)
        assert status == HTTPStatus.OK
        assert result["limitReached"] is True and result["cached"] is True
        assert result["evaluations"] == GOOD_EVALS
        mock_run.assert_not_called()
        mock_write.assert_not_called()

    def test_under_the_limit_run_again_still_runs(self, mock_run, mock_write, mock_rows, _inputs, monkeypatch):
        monkeypatch.setenv("EVAL_RERUN_LIMIT", "3")
        body_without_flag = {k: v for k, v in BLOCKS_BODY.items() if k != "skipIfUnchanged"}
        with patch("eval.quality.main.find_latest_eval_result", return_value=saved_result(runsWithThisKey=2)):
            body, _ = eval_quality(make_request(body_without_flag))
        assert json.loads(body)["limitReached"] is False
        mock_run.assert_called_once()

    def test_at_the_limit_with_nothing_to_show_is_a_429(self, mock_run, mock_write, mock_rows, _inputs, monkeypatch):
        monkeypatch.setenv("EVAL_RERUN_LIMIT", "3")
        failed = saved_result(runsWithThisKey=3, evaluations=[{"provider": "x", "model": "y", "error": "timeout"}])
        with patch("eval.quality.main.find_latest_eval_result", return_value=failed):
            body, status = eval_quality(make_request(BLOCKS_BODY))
        assert status == HTTPStatus.TOO_MANY_REQUESTS
        assert json.loads(body)["error"] == LIMIT_REACHED_MESSAGE
        mock_run.assert_not_called()

    def test_edited_text_at_the_limit_runs(self, mock_run, mock_write, mock_rows, _inputs, monkeypatch):
        monkeypatch.setenv("EVAL_RERUN_LIMIT", "3")
        with patch("eval.quality.main.find_latest_eval_result", return_value=saved_result(runsWithThisKey=3, contentHash="old")):
            eval_quality(make_request(BLOCKS_BODY))
        mock_run.assert_called_once()

    def test_no_content_hash_no_lookup(self, mock_run, mock_write, mock_rows, inputs):
        body = {k: v for k, v in BLOCKS_BODY.items() if k != "contentHash"}
        with patch("eval.quality.main.find_latest_eval_result") as find:
            eval_quality(make_request(body))
        find.assert_not_called()
        inputs.assert_not_called()
        mock_run.assert_called_once()

    def test_setup_failure_is_a_500(self, mock_run, mock_write, mock_rows, inputs):
        inputs.side_effect = RuntimeError("No active models configured for role 'eval'")
        body, status = eval_quality(make_request(BLOCKS_BODY))
        assert status == HTTPStatus.INTERNAL_SERVER_ERROR
        assert "No active models" in json.loads(body)["error"]
        mock_run.assert_not_called()


class TestSettingsInEvalQuality:
    def test_rerun_limit_from_the_settings_tab(self, monkeypatch):
        monkeypatch.delenv("EVAL_RERUN_LIMIT", raising=False)
        assert rerun_limit({"eval_rerun_limit": 40}) == 40

    def test_env_var_overrides_the_tab(self, monkeypatch):
        monkeypatch.setenv("EVAL_RERUN_LIMIT", "2")
        assert rerun_limit({"eval_rerun_limit": 40}) == 2

    def test_blocks_over_the_limit_arent_evaluated(self):
        many = {"documentId": "doc-1", "contentHash": "h",
                "blocks": [{"id": f"b{i}", "original_text": "x", "translated_text": "y"} for i in range(4)]}
        with patch("eval.quality.main.load_settings", return_value={"yellow_max_blocks": 3, "eval_rerun_limit": 100}), \
             patch("eval.quality.main.run_quality_eval") as run, \
             patch("eval.quality.main.load_eval_inputs") as inputs:
            body, status = eval_quality(make_request(many))
        result = json.loads(body)
        assert status == HTTPStatus.REQUEST_ENTITY_TOO_LARGE
        assert result["tooLarge"] is True
        assert result["error"] == ("This translation has too many separate pieces of text to evaluate "
                                   "(4; the pilot supports up to 3).")
        run.assert_not_called()
        inputs.assert_not_called()


class TestBlockCapCountsTranslatedRows:
    def test_rows_without_spanish_dont_count(self):
        body = {"documentId": "doc-1", "blocks": (
            [{"id": f"b{i}", "original_text": "x", "translated_text": "y"} for i in range(3)]
            + [{"id": f"c{i}", "original_text": "context", "translated_text": ""} for i in range(5)])}
        with patch("eval.quality.main.load_settings", return_value={"yellow_max_blocks": 3, "eval_rerun_limit": 100}), \
             patch("eval.quality.main.run_quality_eval", return_value=GOOD_EVALS) as run, \
             patch("eval.quality.main.write_combined_result", return_value=None), \
             patch("eval.quality.main.append_result_rows"):
            _, status = eval_quality(make_request(body))
        assert status == HTTPStatus.OK  # 3 translated rows: at the limit, not over it
        run.assert_called_once()


class TestWriteCombinedResultKey:
    @patch("eval.quality.main.write_eval_result", return_value="drive-file-1")
    def test_stores_model_set_rubric_hash_and_run_count(self, mock_write):
        key = eval_key("hash-1", MODELS, RUBRIC)
        write_combined_result("doc-1", "doc-1", "hash-1", GOOD_EVALS, key, runs=4)
        payload = mock_write.call_args[0][1]
        assert payload["runsWithThisKey"] == 4
        assert payload["contentHash"] == "hash-1"
        assert payload["modelSet"] == key["modelSet"]
        assert payload["rubricHash"] == key["rubricHash"]


class TestEvaluatedAtIsUtc:
    @patch("eval.quality.main.write_eval_result", return_value="drive-file-1")
    def test_saved_time_carries_its_utc_offset(self, mock_write):
        write_combined_result("doc-1", "doc-1", "hash-1", GOOD_EVALS)
        evaluated_at = mock_write.call_args[0][1]["evaluatedAt"]
        assert evaluated_at.endswith("+00:00")
        assert mock_write.call_args[0][2]["evaluatedAt"] == evaluated_at


class TestFindLatestEvalResult:
    def test_none_when_results_are_written_locally(self, monkeypatch):
        monkeypatch.delenv("DRIVE_EVAL_RESULTS_FOLDER_ID", raising=False)
        assert find_latest_eval_result("doc-1") is None

    @patch("eval.quality.quality_loaders.google.auth.default", return_value=(MagicMock(), "proj"))
    @patch("eval.quality.quality_loaders.build")
    def test_queries_like_the_add_on_and_reads_the_newest(self, mock_build, _auth, monkeypatch):
        monkeypatch.setenv("DRIVE_EVAL_RESULTS_FOLDER_ID", "folder-1")
        files = mock_build.return_value.files.return_value
        files.list.return_value.execute.return_value = {"files": [{"id": "newest"}]}
        files.get_media.return_value.execute.return_value = json.dumps({"contentHash": "h"}).encode()

        assert find_latest_eval_result("doc-1") == ({"contentHash": "h"}, "newest")
        params = files.list.call_args.kwargs
        assert params["q"] == "properties has { key='documentId' and value='doc-1' } and trashed = false"
        assert params["orderBy"] == "createdTime desc" and params["pageSize"] == 1
        assert params["supportsAllDrives"] and params["includeItemsFromAllDrives"]
        assert params["corpora"] == "allDrives"

    @patch("eval.quality.quality_loaders.google.auth.default", return_value=(MagicMock(), "proj"))
    @patch("eval.quality.quality_loaders.build")
    def test_none_when_nothing_saved(self, mock_build, _auth, monkeypatch):
        monkeypatch.setenv("DRIVE_EVAL_RESULTS_FOLDER_ID", "folder-1")
        mock_build.return_value.files.return_value.list.return_value.execute.return_value = {"files": []}
        assert find_latest_eval_result("doc-1") is None
