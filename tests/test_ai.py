import json

import httpx
import pytest
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


def test_workers_ai_embedding_tag_is_the_configured_model():
    ai = WorkersAI(_cfg(), transport=_transport(lambda request: None))
    assert ai.embedding_tag == _cfg().embedding_model


def test_extract_json_passes_through_parsed_dict():
    from pipeline.ai import _extract_json

    parsed = {"category_id": "c-1", "reason": "already parsed by workers ai"}
    assert _extract_json(parsed) == parsed


def test_adjudicate_theme_parses_and_normalizes_dict_response():
    def handler(request):
        return httpx.Response(200, json={
            "result": {"response": {  # dict, not string: workers ai json mode
                "decision": "join", "theme_id": "t-1",
                "new_theme_name": None,
                "merge_theme_ids": ["t-1", "t-2"],
                "reason": "same subject"}},
            "success": True,
        })

    ai = WorkersAI(_cfg(), transport=_transport(handler))
    out = ai.adjudicate_theme(
        {"headline": "h", "summary": ""},
        [{"theme_id": "t-1", "name": "A", "storyline_count": 2,
          "recent_headlines": []},
         {"theme_id": "t-2", "name": "B", "storyline_count": 1,
          "recent_headlines": []}],
    )
    assert out == {"decision": "join", "theme_id": "t-1",
                   "new_theme_name": None,
                   "merge_theme_ids": ["t-1", "t-2"],
                   "reason": "same subject"}


def test_adjudicate_theme_raises_on_transport_error():
    def boom(request):
        return httpx.Response(500, json={"success": False})

    ai = WorkersAI(_cfg(), transport=_transport(boom))
    with pytest.raises(Exception):
        ai.adjudicate_theme({"headline": "h", "summary": ""},
                            [{"theme_id": "t-1", "name": "A",
                              "storyline_count": 1, "recent_headlines": []}])
