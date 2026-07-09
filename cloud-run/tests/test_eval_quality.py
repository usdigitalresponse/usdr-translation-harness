import json
from http import HTTPStatus
from unittest.mock import MagicMock, patch

import jsonschema
import pytest

from eval.quality.main import (
    build_eval_prompt, build_result_row, eval_quality, evaluate_with_model,
    format_translation_for_review, get_active_models, parse_eval_response,
    run_quality_eval, validate_eval,
    CRITERIA, EVAL_ROLE,
)
from eval.quality.quality_llm import (
    call_llm, load_eval_schema, PROVIDER_ANTHROPIC, PROVIDER_GOOGLE,
)
from eval.quality.quality_loaders import parse_drive_file_id


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

    @patch("eval.quality.main.run_quality_eval")
    def test_returns_200_with_evaluations(self, mock_run):
        mock_run.return_value = [{"provider": "anthropic", "model": "claude-opus-4-8",
                                  "weightedOverallScore": 4.2}]
        body, status = eval_quality(make_request({"translationJsonUrl": "abc123"}))
        result = json.loads(body)

        assert status == HTTPStatus.OK
        assert result["status"] == "ok"
        assert result["translationFileId"] == "abc123"
        assert len(result["evaluations"]) == 1
        mock_run.assert_called_once_with("abc123")

    @patch("eval.quality.main.run_quality_eval")
    def test_parses_file_id_out_of_drive_url(self, mock_run):
        mock_run.return_value = [{"provider": "anthropic", "model": "m", "weightedOverallScore": 1}]
        url = "https://drive.google.com/file/d/FILE_ID_123/view?usp=sharing"
        body, status = eval_quality(make_request({"translationJsonUrl": url}))

        assert status == HTTPStatus.OK
        assert json.loads(body)["translationFileId"] == "FILE_ID_123"
        mock_run.assert_called_once_with("FILE_ID_123")

    @patch("eval.quality.main.run_quality_eval")
    def test_returns_partial_when_some_models_fail(self, mock_run):
        mock_run.return_value = [
            {"provider": "anthropic", "model": "claude-opus-4-8", "weightedOverallScore": 4.2},
            {"provider": "google", "model": "gemini-3.5-flash", "error": "boom"},
        ]
        body, status = eval_quality(make_request({"translationJsonUrl": "abc123"}))

        assert status == HTTPStatus.OK
        assert json.loads(body)["status"] == "partial"

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

    @patch("eval.quality.main.append_result_row")
    @patch("eval.quality.main.write_eval_result", return_value="result-file-id")
    @patch("eval.quality.main.call_llm")
    def test_returns_summary_and_persists_result(self, mock_llm, mock_write, mock_append):
        mock_llm.return_value = json.dumps(make_scores())

        result = evaluate_with_model("translation-file-id", self.MODEL_CONFIG, "PROMPT")

        mock_llm.assert_called_once_with("anthropic", "claude-opus-4-8", "PROMPT")
        assert result["provider"] == "anthropic"
        assert result["weightedOverallScore"] == 4.2
        assert result["overallPriorityRating"] == "Medium"
        assert result["resultFileId"] == "result-file-id"

        written = mock_write.call_args[0][1]
        assert written["translationFileId"] == "translation-file-id"
        assert written["scores"]["weighted_overall_score"] == 4.2
        mock_append.assert_called_once()

    @patch("eval.quality.main.append_result_row", side_effect=RuntimeError("sheet down"))
    @patch("eval.quality.main.write_eval_result", return_value=None)
    @patch("eval.quality.main.call_llm")
    def test_sheet_failure_does_not_fail_the_eval(self, mock_llm, mock_write, mock_append):
        mock_llm.return_value = json.dumps(make_scores())
        result = evaluate_with_model("translation-file-id", self.MODEL_CONFIG, "PROMPT")
        assert result["weightedOverallScore"] == 4.2


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
        mock_eval.side_effect = lambda file_id, m, prompt: {"provider": m["provider"], "model": m["model"]}

        results = run_quality_eval("file-1")

        assert len(results) == 2
        assert mock_eval.call_count == 2
        assert mock_doc.call_args[0][0] == "EVALUATION_RUBRIC_DOC_ID"

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
    @patch("eval.quality.quality_llm.call_claude", return_value="{}")
    def test_dispatches_to_claude_with_claude_schema(self, mock_claude):
        result = call_llm(PROVIDER_ANTHROPIC, "claude-opus-4-8", "prompt")
        schema = mock_claude.call_args[1]["output_schema"]

        assert result == "{}"
        assert mock_claude.call_args[1]["model"] == "claude-opus-4-8"
        assert schema["additionalProperties"] is False

    @patch("eval.quality.quality_llm.call_gemini", return_value="{}")
    def test_dispatches_to_gemini_with_gemini_schema(self, mock_gemini):
        result = call_llm(PROVIDER_GOOGLE, "gemini-3.5-flash", "prompt")
        schema = mock_gemini.call_args[1]["output_schema"]

        assert result == "{}"
        assert "additionalProperties" not in schema

    def test_raises_on_unknown_provider(self):
        with pytest.raises(ValueError, match="No eval schema"):
            call_llm("openai", "gpt-4", "prompt")


class TestLoadEvalSchema:
    def test_both_provider_schemas_define_the_same_criteria(self):
        claude = load_eval_schema(PROVIDER_ANTHROPIC)
        gemini = load_eval_schema(PROVIDER_GOOGLE)
        assert claude["required"] == gemini["required"]
        assert set(CRITERIA) <= set(claude["properties"])
