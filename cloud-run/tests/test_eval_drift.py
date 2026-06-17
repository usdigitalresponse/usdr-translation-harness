import json
import pytest
from eval.drift.main import eval_drift, compute_bleu, compute_rouge


def make_request(body=None):
    class FakeRequest:
        def get_json(self, silent=False):
            return body
    return FakeRequest()


def test_returns_ok_placeholder():
    response = eval_drift(make_request({}))
    result = json.loads(response)
    assert result["status"] == "ok"


def test_compute_bleu():
    hypotheses = ["the cat sat on the mat"]
    references = ["the cat sat on the mat"]
    result = compute_bleu(hypotheses, references)
    assert result["score"] > 0


def test_compute_rouge():
    result = compute_rouge("the cat sat on the mat", "the cat sat on the mat")
    assert result["rouge1"]["fmeasure"] == pytest.approx(1.0)
    assert result["rougeL"]["fmeasure"] == pytest.approx(1.0)
