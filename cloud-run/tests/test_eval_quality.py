import json


def make_request(body=None):
    class FakeRequest:
        def get_json(self, silent=False):
            return body
    return FakeRequest()


def test_returns_400_when_no_url():
    from eval.quality.main import eval_quality

    response, status = eval_quality(make_request({}))
    assert status == 400
    assert "error" in json.loads(response)


def test_returns_ok_placeholder():
    from eval.quality.main import eval_quality

    response = eval_quality(make_request({"translationJsonUrl": "https://drive.google.com/file/123"}))
    result = json.loads(response)
    assert result["status"] == "ok"
