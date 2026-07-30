import csv
import json
import os
from http import HTTPStatus
from unittest.mock import MagicMock, patch

import jsonschema
import pytest

from eval.quality.main import (
    build_eval_prompt, build_result_row, eval_quality, evaluate_with_model,
    format_translation_for_review, get_active_models, log_structured,
    normalize_inline_blocks, parse_eval_response, run_quality_eval, validate_eval,
    write_combined_result, CRITERIA, EVAL_ROLE, PIPELINE_STAGE, STATUS_FAILED, STATUS_OK,
)
from eval.quality.quality_llm import (
    call_llm, load_eval_schema, PROVIDER_ANTHROPIC, PROVIDER_GOOGLE,
)
from eval.quality.quality_loaders import (
    append_result_row, parse_drive_file_id, _extract_structural_text,
    EVAL_RESULTS_HEADERS, EVAL_RESULTS_SHEET_NAME,
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
        mock_run.assert_called_once_with("abc123", None, None)

    @patch("eval.quality.main.append_result_rows")
    @patch("eval.quality.main.write_combined_result", return_value=None)
    @patch("eval.quality.main.run_quality_eval")
    def test_parses_file_id_out_of_drive_url(self, mock_run, mock_write, mock_rows):
        mock_run.return_value = [{"provider": "anthropic", "model": "m", "weightedOverallScore": 1}]
        url = "https://drive.google.com/file/d/FILE_ID_123/view?usp=sharing"
        body, status = eval_quality(make_request({"translationJsonUrl": url}))

        assert status == HTTPStatus.OK
        assert json.loads(body)["translationFileId"] == "FILE_ID_123"
        mock_run.assert_called_once_with("FILE_ID_123", None, None)

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


class TestCallLlm:
    @patch("eval.quality.quality_llm.call_claude", return_value=("{}", {"input_tokens": 1}))
    def test_dispatches_to_claude_with_claude_schema(self, mock_claude):
        text, usage = call_llm(PROVIDER_ANTHROPIC, "claude-opus-4-8", "prompt")
        schema = mock_claude.call_args[1]["output_schema"]

        assert text == "{}"
        assert usage == {"input_tokens": 1}
        assert mock_claude.call_args[1]["model"] == "claude-opus-4-8"
        assert schema["additionalProperties"] is False

    @patch("eval.quality.quality_llm.call_gemini", return_value=("{}", {"output_tokens": 2}))
    def test_dispatches_to_gemini_with_gemini_schema(self, mock_gemini):
        text, usage = call_llm(PROVIDER_GOOGLE, "gemini-3.5-flash", "prompt")
        schema = mock_gemini.call_args[1]["output_schema"]

        assert text == "{}"
        assert usage == {"output_tokens": 2}
        assert "additionalProperties" not in schema

    def test_raises_on_unknown_provider(self):
        with pytest.raises(ValueError, match="No eval schema"):
            call_llm("openai", "gpt-4", "prompt")


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
