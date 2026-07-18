import json

import httpx
import numpy as np

from pipeline.ai import WorkersAI
from pipeline.config import Config


def _cfg() -> Config:
    return Config(database_url="x", cf_account_id="acct", cf_api_token="tok")


def _transport(handler):
    return httpx.MockTransport(handler)


def test_embed_parses_batch():
    def handler(request):
        assert "acct/ai/run/@cf/baai/bge-m3" in str(request.url)
        return httpx.Response(200, json={"result": {"data": [[0.1, 0.2], [0.3, 0.4]]}, "success": True})

    ai = WorkersAI(_cfg(), transport=_transport(handler))
    vecs = ai.embed(["a", "b"])
    assert len(vecs) == 2
    assert isinstance(vecs[0], np.ndarray)


def test_adjudicate_parses_json_and_defaults_to_split_on_error():
    def ok(request):
        body = json.loads(request.content)
        assert body.get("temperature") == 0
        return httpx.Response(200, json={
            "result": {"response": json.dumps({"same_event": True, "reason": "same recall"})},
            "success": True,
        })

    ai = WorkersAI(_cfg(), transport=_transport(ok))
    same, reason = ai.adjudicate_same_event(
        {"title": "A", "summary": "", "entities": []},
        {"title": "B", "summary": "", "entities": []},
        context="",
    )
    assert same is True and reason == "same recall"

    def boom(request):
        return httpx.Response(500, json={"success": False})

    ai = WorkersAI(_cfg(), transport=_transport(boom))
    same, reason = ai.adjudicate_same_event(
        {"title": "A", "summary": "", "entities": []},
        {"title": "B", "summary": "", "entities": []},
        context="",
    )
    assert same is False
    assert reason.startswith("adjudicator_error")
