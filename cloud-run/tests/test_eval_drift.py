import json
from http import HTTPStatus
from unittest.mock import patch

import pytest

from eval.drift.main import (
    aggregate_model, build_judge_prompt, build_result_row, build_translation_prompt,
    compute_bleu, compute_rouge, eval_drift, evaluate_example, flag_regression,
    get_active_models, get_baselines, run_and_store, run_drift_eval, CRITERIA,
    PIPELINE_STAGE, STATUS_FAILED, STATUS_OK,
)
from eval.drift.drift_llm import call_llm, load_judge_schema, PROVIDER_ANTHROPIC, PROVIDER_GOOGLE
from eval.drift.drift_loaders import (
    _map_golden_headers, _rows_to_golden_examples, parse_drive_file_id,
    EVAL_RESULTS_HEADERS,
)


def make_request(body=None):
    class FakeRequest:
        def get_json(self, silent=False):
            return body
    return FakeRequest()


def make_judge_scores(overall=4.2, priority="Low", score=4):
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


def make_judge(overall=4.2, priority="Low"):
    return {
        "provider": "anthropic", "model": "claude-opus-4-8",
        "weightedOverallScore": overall, "overallPriorityRating": priority,
        "scores": make_judge_scores(overall, priority),
    }


GOLDEN_EXAMPLE = {
    "id": "golden-01",
    "source_language": "English",
    "target_language": "Spanish",
    "source_text": "the cat sat on the mat",
    "reference_translation": "the cat sat on the mat",
}

TRANSLATE_MODEL = {"role": "translate", "provider": "anthropic", "model": "claude-opus-4-8", "active": True}
JUDGE_MODEL = {"role": "eval", "provider": "anthropic", "model": "claude-opus-4-8", "active": True}


# --- Metrics (unchanged contract) ---

def test_compute_bleu():
    result = compute_bleu(["the cat sat on the mat"], ["the cat sat on the mat"])
    assert result["score"] > 0


def test_compute_rouge():
    result = compute_rouge("the cat sat on the mat", "the cat sat on the mat")
    assert result["rouge1"]["fmeasure"] == pytest.approx(1.0)
    assert result["rougeL"]["fmeasure"] == pytest.approx(1.0)


# --- Prompts ---

class TestPrompts:
    def test_translation_prompt_names_languages_and_source(self):
        prompt = build_translation_prompt("BASE", "English", "Spanish", "Hello world")
        assert "BASE" in prompt
        assert "English to Spanish" in prompt
        assert "Hello world" in prompt

    def test_judge_prompt_carries_reference_and_candidate(self):
        prompt = build_judge_prompt("RUBRIC", GOLDEN_EXAMPLE, "el gato")
        assert "RUBRIC" in prompt
        assert GOLDEN_EXAMPLE["reference_translation"] in prompt
        assert "el gato" in prompt  # candidate


# --- Regression thresholds ---

class TestFlagRegression:
    BASELINES = {"bleu": 30.0, "rougeL": 0.40, "judgeOverall": 3.0}

    def test_no_regression_when_all_above(self):
        regressed, reasons = flag_regression(85.0, 0.9, 4.5, self.BASELINES)
        assert regressed is False
        assert reasons == []

    def test_regresses_on_low_bleu(self):
        regressed, reasons = flag_regression(12.0, 0.9, 4.5, self.BASELINES)
        assert regressed is True
        assert any("BLEU" in r for r in reasons)

    def test_regresses_on_low_judge(self):
        regressed, reasons = flag_regression(85.0, 0.9, 2.0, self.BASELINES)
        assert regressed is True
        assert any("Judge" in r for r in reasons)

    def test_judge_threshold_skipped_when_none(self):
        regressed, reasons = flag_regression(85.0, 0.9, None, self.BASELINES)
        assert regressed is False
        assert all("Judge" not in r for r in reasons)


# --- get_active_models ---

def test_get_active_models_filters_role_and_active():
    config = {"models": [
        TRANSLATE_MODEL,
        {"role": "translate", "provider": "google", "model": "g", "active": False},
        JUDGE_MODEL,
    ]}
    translate = get_active_models(config, "translate")
    assert [m["model"] for m in translate] == ["claude-opus-4-8"]


# --- evaluate_example ---

class TestEvaluateExample:
    @patch("eval.drift.main.judge_candidate")
    @patch("eval.drift.main.generate_candidate")
    def test_perfect_candidate_scores_high_no_regression(self, mock_gen, mock_judge):
        # Candidate identical to reference → BLEU 100, ROUGE-L 1.0.
        mock_gen.return_value = (GOLDEN_EXAMPLE["reference_translation"], {"input_tokens": 5}, 12)
        mock_judge.return_value = make_judge(overall=4.5)

        result = evaluate_example(
            TRANSLATE_MODEL, JUDGE_MODEL, "PROMPT", "RUBRIC", GOLDEN_EXAMPLE, get_baselines(),
        )

        assert result["provider"] == "anthropic"
        assert result["exampleId"] == "golden-01"
        assert result["bleu"] > 99
        assert result["rouge"]["rougeL"] == pytest.approx(1.0)
        assert result["judge"]["weightedOverallScore"] == 4.5
        assert result["regression"] is False

    @patch("eval.drift.main.judge_candidate")
    @patch("eval.drift.main.generate_candidate")
    def test_divergent_candidate_flags_regression(self, mock_gen, mock_judge):
        mock_gen.return_value = ("totally unrelated words here", {}, 12)
        mock_judge.return_value = make_judge(overall=2.0)

        result = evaluate_example(
            TRANSLATE_MODEL, JUDGE_MODEL, "PROMPT", "RUBRIC", GOLDEN_EXAMPLE, get_baselines(),
        )

        assert result["regression"] is True
        assert result["regressionReasons"]

    @patch("eval.drift.main.judge_candidate", side_effect=RuntimeError("judge down"))
    @patch("eval.drift.main.generate_candidate")
    def test_judge_failure_is_recorded_not_raised(self, mock_gen, mock_judge):
        mock_gen.return_value = (GOLDEN_EXAMPLE["reference_translation"], {}, 12)

        result = evaluate_example(
            TRANSLATE_MODEL, JUDGE_MODEL, "PROMPT", "RUBRIC", GOLDEN_EXAMPLE, get_baselines(),
        )

        assert result["judge"]["error"] == "judge down"
        # BLEU/ROUGE still scored; judge threshold skipped.
        assert result["bleu"] > 99

    @patch("eval.drift.main.generate_candidate")
    def test_no_judge_model_skips_judging(self, mock_gen):
        mock_gen.return_value = (GOLDEN_EXAMPLE["reference_translation"], {}, 12)

        result = evaluate_example(
            TRANSLATE_MODEL, None, "PROMPT", "", GOLDEN_EXAMPLE, get_baselines(),
        )

        assert result["judge"] is None
        assert result["regression"] is False


# --- aggregate ---

def test_aggregate_model_means_and_regression_count():
    examples = [
        {"bleu": 80.0, "rouge": {"rougeL": 0.9}, "judge": make_judge(4.0), "regression": False},
        {"bleu": 20.0, "rouge": {"rougeL": 0.3}, "judge": make_judge(2.0), "regression": True},
        {"exampleId": "x", "error": "boom"},  # excluded from means
    ]
    agg = aggregate_model(examples)
    assert agg["exampleCount"] == 3
    assert agg["scoredCount"] == 2
    assert agg["meanBleu"] == pytest.approx(50.0)
    assert agg["meanJudgeOverall"] == pytest.approx(3.0)
    assert agg["regressionCount"] == 1
    assert agg["regressed"] is True


# --- result row ---

class TestBuildResultRow:
    def test_row_column_order_and_values(self):
        example_result = {
            "provider": "anthropic", "model": "claude-opus-4-8",
            "exampleId": "golden-01", "sourceLanguage": "English", "targetLanguage": "Spanish",
            "bleu": 87.654, "rouge": {"rouge1": 0.9, "rouge2": 0.8, "rougeL": 0.85},
            "judge": make_judge(overall=4.2, priority="Low"), "regression": False,
        }
        row = build_result_row(example_result, "result-1")
        assert len(row) == len(EVAL_RESULTS_HEADERS)
        assert row[1] == "golden-01"
        assert row[2] == "anthropic"
        assert row[6] == 87.65          # BLEU rounded
        assert row[9] == 0.85           # ROUGE-L
        assert row[10] == 4.2           # judge overall
        assert row[12] == "NO"          # regression
        assert row[13] == "result-1"

    def test_row_blanks_judge_when_absent(self):
        example_result = {
            "provider": "anthropic", "model": "m", "exampleId": "g",
            "sourceLanguage": "English", "targetLanguage": "Spanish",
            "bleu": 10.0, "rouge": {"rouge1": 0.1, "rouge2": 0.0, "rougeL": 0.1},
            "judge": None, "regression": True,
        }
        row = build_result_row(example_result, None)
        assert row[10] == ""            # no judge overall
        assert row[11] == ""            # no judge priority
        assert row[12] == "YES"
        assert row[13] == ""


# --- run_drift_eval orchestration ---

class TestRunDriftEval:
    CONFIG = {"models": [TRANSLATE_MODEL, JUDGE_MODEL]}

    @patch("eval.drift.main.evaluate_example")
    @patch("eval.drift.main.load_doc", return_value="DOC")
    @patch("eval.drift.main.load_golden_set")
    @patch("eval.drift.main.load_config")
    def test_runs_every_golden_example_per_model(self, mock_config, mock_golden, mock_doc, mock_eval):
        mock_config.return_value = self.CONFIG
        mock_golden.return_value = [
            {**GOLDEN_EXAMPLE, "id": "g1"}, {**GOLDEN_EXAMPLE, "id": "g2"},
        ]
        mock_eval.side_effect = lambda tm, jm, bp, rb, ex, bl: {
            "provider": tm["provider"], "model": tm["model"], "exampleId": ex["id"],
            "bleu": 50.0, "rouge": {"rougeL": 0.5}, "judge": make_judge(), "regression": False,
        }

        payload = run_drift_eval("weekly")

        assert payload["trigger"] == "weekly"
        assert payload["goldenSetSize"] == 2
        assert len(payload["models"]) == 1
        assert len(payload["models"][0]["examples"]) == 2
        assert payload["models"][0]["aggregate"]["exampleCount"] == 2

    @patch("eval.drift.main.load_config", return_value={"models": [JUDGE_MODEL]})
    def test_raises_without_translate_model(self, mock_config):
        with pytest.raises(RuntimeError, match="No active models"):
            run_drift_eval()

    @patch("eval.drift.main.evaluate_example", side_effect=RuntimeError("api down"))
    @patch("eval.drift.main.load_doc", return_value="DOC")
    @patch("eval.drift.main.load_golden_set", return_value=[{**GOLDEN_EXAMPLE, "id": "g1"}])
    @patch("eval.drift.main.load_config", return_value={"models": [TRANSLATE_MODEL, JUDGE_MODEL]})
    def test_records_example_error_without_aborting(self, mock_config, mock_golden, mock_doc, mock_eval):
        payload = run_drift_eval()
        example = payload["models"][0]["examples"][0]
        assert example["error"] == "api down"


# --- endpoint (fire-and-forget) ---

class TestEvalDriftEndpoint:
    @patch("eval.drift.main.threading.Thread")
    def test_returns_202_and_starts_background_run(self, mock_thread):
        body, status = eval_drift(make_request({"trigger": "weekly"}))
        result = json.loads(body)

        assert status == HTTPStatus.ACCEPTED
        assert result["status"] == "accepted"
        assert result["trigger"] == "weekly"
        # the eval itself runs off-thread, targeting run_and_store(trigger)
        _, kwargs = mock_thread.call_args
        assert kwargs["target"].__name__ == "run_and_store"
        assert kwargs["args"] == ("weekly",)
        mock_thread.return_value.start.assert_called_once()

    @patch("eval.drift.main.threading.Thread")
    def test_defaults_trigger_to_manual(self, mock_thread):
        body, status = eval_drift(make_request({}))
        assert status == HTTPStatus.ACCEPTED
        assert json.loads(body)["trigger"] == "manual"
        assert mock_thread.call_args.kwargs["args"] == ("manual",)


class TestRunAndStore:
    PAYLOAD = {
        "trigger": "weekly", "goldenSetSize": 2, "baselines": {},
        "models": [{"provider": "anthropic", "model": "claude-opus-4-8",
                    "aggregate": {"regressed": False}, "examples": []}],
    }

    @patch("eval.drift.main.append_result_rows")
    @patch("eval.drift.main.write_drift_result", return_value="loc-1")
    @patch("eval.drift.main.run_drift_eval")
    def test_runs_writes_and_appends(self, mock_run, mock_write, mock_rows):
        mock_run.return_value = self.PAYLOAD
        run_and_store("weekly")

        mock_run.assert_called_once_with("weekly")
        mock_write.assert_called_once_with(self.PAYLOAD)
        mock_rows.assert_called_once_with(self.PAYLOAD["models"], "loc-1")

    @patch("eval.drift.main.append_result_rows")
    @patch("eval.drift.main.write_drift_result")
    @patch("eval.drift.main.run_drift_eval", side_effect=RuntimeError("no golden set"))
    def test_run_failure_does_not_write_or_raise(self, mock_run, mock_write, mock_rows):
        run_and_store("manual")  # must not propagate
        mock_write.assert_not_called()
        mock_rows.assert_not_called()


# --- golden set parsing (drift_loaders) ---

class TestGoldenSetParsing:
    HEADERS = ["ID", "Source Language", "Target Language", "Source Text", "Reference Translation"]

    def test_maps_headers_to_canonical_fields(self):
        mapping = _map_golden_headers(self.HEADERS)
        assert mapping[0] == "id"
        assert mapping[3] == "source_text"
        assert mapping[4] == "reference_translation"

    def test_rows_to_examples_skips_incomplete_rows(self):
        rows = [
            self.HEADERS,
            ["g1", "English", "Spanish", "Hello", "Hola"],
            ["g2", "English", "Spanish", "", "Missing source"],  # skipped
        ]
        examples = _rows_to_golden_examples(rows)
        assert len(examples) == 1
        assert examples[0]["id"] == "g1"
        assert examples[0]["source_text"] == "Hello"
        assert examples[0]["reference_translation"] == "Hola"

    def test_defaults_id_and_languages_when_absent(self, monkeypatch):
        # Clear the ambient .env overrides so the "unknown" fallback is exercised.
        monkeypatch.delenv("GOLDEN_SOURCE_COLUMN", raising=False)
        monkeypatch.delenv("GOLDEN_REFERENCE_COLUMN", raising=False)
        rows = [["Source Text", "Reference Translation"], ["Hello", "Hola"]]
        examples = _rows_to_golden_examples(rows)
        assert examples[0]["id"] == "golden-01"
        assert examples[0]["source_language"] == "unknown"

    def test_raises_without_required_columns(self):
        rows = [["ID", "Notes"], ["g1", "whatever"]]
        with pytest.raises(ValueError, match="missing a source-text or reference-translation"):
            _rows_to_golden_examples(rows)

    def test_language_named_columns_via_env_override(self, monkeypatch):
        # Golden sets whose columns are titled by language (like the FAMLI xlsx)
        # are pointed at source/reference via env; the names label the languages.
        monkeypatch.setenv("GOLDEN_SOURCE_COLUMN", "English")
        monkeypatch.setenv("GOLDEN_REFERENCE_COLUMN", "Spanish")
        rows = [
            ["Agency ", "English ", "Spanish ", "Notes "],
            ["FAMLI", "Hello", "Hola", "ignore me"],
        ]
        examples = _rows_to_golden_examples(rows)
        assert len(examples) == 1
        assert examples[0]["source_text"] == "Hello"
        assert examples[0]["reference_translation"] == "Hola"
        assert examples[0]["source_language"] == "English"
        assert examples[0]["target_language"] == "Spanish"

    def test_ignores_unmapped_columns(self, monkeypatch):
        monkeypatch.setenv("GOLDEN_SOURCE_COLUMN", "English")
        monkeypatch.setenv("GOLDEN_REFERENCE_COLUMN", "Spanish")
        rows = [["English", "Spanish", "Notes"], ["Hi", "Hola", "note"]]
        example = _rows_to_golden_examples(rows)[0]
        assert set(example.keys()) == {
            "id", "source_language", "target_language", "source_text", "reference_translation",
        }


class TestLoadGoldenSetLocal:
    def test_reads_csv_via_env_columns(self, tmp_path, monkeypatch):
        from eval.drift.drift_loaders import load_golden_set
        csv_path = tmp_path / "golden.csv"
        csv_path.write_text(
            "English,Spanish,Notes\nHello,Hola,ignore\nGoodbye,Adios,ignore\n",
            encoding="utf-8",
        )
        monkeypatch.setenv("GOLDEN_SET_LOCAL_PATH", str(csv_path))
        monkeypatch.setenv("GOLDEN_SOURCE_COLUMN", "English")
        monkeypatch.setenv("GOLDEN_REFERENCE_COLUMN", "Spanish")

        examples = load_golden_set()
        assert [e["source_text"] for e in examples] == ["Hello", "Goodbye"]
        assert examples[0]["target_language"] == "Spanish"

    def test_reads_xlsx_via_env_columns(self, tmp_path, monkeypatch):
        openpyxl = pytest.importorskip("openpyxl")
        from eval.drift.drift_loaders import load_golden_set
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["English", "Spanish", "Notes"])
        ws.append(["Hello", "Hola", "ignore"])
        xlsx_path = tmp_path / "golden.xlsx"
        wb.save(xlsx_path)

        monkeypatch.setenv("GOLDEN_SET_LOCAL_PATH", str(xlsx_path))
        monkeypatch.setenv("GOLDEN_SOURCE_COLUMN", "English")
        monkeypatch.setenv("GOLDEN_REFERENCE_COLUMN", "Spanish")

        examples = load_golden_set()
        assert len(examples) == 1
        assert examples[0]["reference_translation"] == "Hola"


def test_parse_drive_file_id_from_url():
    assert parse_drive_file_id("https://drive.google.com/file/d/ABC123/view") == "ABC123"


# --- drift_llm dispatch ---

class TestCallLlm:
    @patch("eval.drift.drift_llm.call_claude", return_value=("candidate", {"input_tokens": 1}))
    def test_translation_call_passes_no_schema(self, mock_claude):
        text, usage = call_llm(PROVIDER_ANTHROPIC, "claude-opus-4-8", "prompt")
        assert text == "candidate"
        assert usage == {"input_tokens": 1}
        assert mock_claude.call_args[1]["output_schema"] is None

    @patch("eval.drift.drift_llm.call_gemini", return_value=("{}", {"output_tokens": 2}))
    def test_judge_call_forwards_schema(self, mock_gemini):
        schema = {"type": "object"}
        text, usage = call_llm(PROVIDER_GOOGLE, "gemini-3.5-flash", "prompt", output_schema=schema)
        assert text == "{}"
        assert mock_gemini.call_args[1]["output_schema"] is schema

    def test_raises_on_unknown_provider(self):
        with pytest.raises(ValueError, match="Unknown provider"):
            call_llm("openai", "gpt-4", "prompt")


class TestLoadJudgeSchema:
    def test_both_provider_schemas_define_the_same_criteria(self):
        claude = load_judge_schema(PROVIDER_ANTHROPIC)
        gemini = load_judge_schema(PROVIDER_GOOGLE)
        assert claude["required"] == gemini["required"]
        assert set(CRITERIA) <= set(claude["properties"])
        # Gemini schema must omit additionalProperties (it rejects the keyword).
        assert "additionalProperties" not in gemini["properties"]["accuracy_and_relevance"]
