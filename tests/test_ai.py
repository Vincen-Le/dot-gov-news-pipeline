import json

import httpx
import numpy as np
import pytest

from pipeline.ai import WorkersAI
from pipeline.config import Config


def _cfg() -> Config:
    return Config(database_url="x", cf_account_id="acct", cf_api_token="tok")


def _transport(handler):
    return httpx.MockTransport(handler)


def test_embed_parses_batch():
    def handler(request):
        assert "acct/ai/run/@cf/baai/bge-m3" in str(request.url)
        return httpx.Response(200, json={
            "result": {"data": [[0.1, 0.2], [0.3, 0.4]]}, "success": True})

    vecs = WorkersAI(_cfg(), transport=_transport(handler)).embed(["a", "b"])
    assert len(vecs) == 2
    assert isinstance(vecs[0], np.ndarray)


def test_adjudicate_parses_json_and_defaults_to_split_on_error():
    def ok(request):
        body = json.loads(request.content)
        assert body.get("temperature") == 0
        return httpx.Response(200, json={
            "result": {"response": json.dumps(
                {"same_event": True, "reason": "same recall"})},
            "success": True,
        })

    ai = WorkersAI(_cfg(), transport=_transport(ok))
    same, reason = ai.adjudicate_same_event(
        {"title": "A", "summary": "", "entities": []},
        {"title": "B", "summary": "", "entities": []}, context="")
    assert same is True and reason == "same recall"

    def boom(request):
        return httpx.Response(500, json={"success": False})

    same, reason = WorkersAI(
        _cfg(), transport=_transport(boom)).adjudicate_same_event(
            {"title": "A", "summary": "", "entities": []},
            {"title": "B", "summary": "", "entities": []}, context="")
    assert same is False
    assert reason.startswith("adjudicator_error")


def test_workers_ai_embedding_tag_is_the_configured_model():
    ai = WorkersAI(_cfg(), transport=_transport(lambda request: None))
    assert ai.embedding_tag == _cfg().embedding_model


def test_extract_json_passes_through_parsed_dict():
    from pipeline.ai import _extract_json
    parsed = {"category_id": "c-1", "reason": "already parsed"}
    assert _extract_json(parsed) == parsed


def test_category_classifier_parses_response():
    def handler(request):
        return httpx.Response(200, json={
            "result": {"response": {"category_id": "c-health",
                                      "reason": "public-health subject"}},
            "success": True})

    out = WorkersAI(_cfg(), transport=_transport(handler)).classify_category(
        {"headline": "Measles update", "summary": ""},
        [{"id": "c-health", "display_name": "Public Health", "origin": "seed"}])
    assert out == {"category_id": "c-health", "reason": "public-health subject"}


def test_adjudicate_membership_parses_nullable_theme():
    def handler(request):
        return httpx.Response(200, json={
            "result": {"response": {"theme_id": "t-1",
                                      "reason": "criterion satisfied"}},
            "success": True})

    out = WorkersAI(_cfg(), transport=_transport(handler)).adjudicate_membership(
        {"headline": "FDA recall", "summary": ""},
        [{"theme_id": "t-1", "name": "Drug Recalls",
          "inclusion_criterion": "specific FDA recalls", "storyline_count": 1,
          "recent_headlines": [], "days_since_active": 0}])
    assert out == {"theme_id": "t-1", "reason": "criterion satisfied"}


def test_membership_raises_on_transport_error():
    ai = WorkersAI(_cfg(), transport=_transport(
        lambda request: httpx.Response(500, json={"success": False})))
    with pytest.raises(Exception):
        ai.adjudicate_membership(
            {"headline": "h", "summary": ""},
            [{"theme_id": "t-1", "name": "A Theme",
              "inclusion_criterion": "a rule", "storyline_count": 1,
              "recent_headlines": [], "days_since_active": None}])


def test_workers_ai_counts_swallowed_errors():
    def boom(request):
        return httpx.Response(200, json={"result": {"response": "not json"},
                                         "success": True})

    ai = WorkersAI(_cfg(), transport=_transport(boom))
    ai.adjudicate_same_event({"title": "a"}, {"title": "b"}, "")
    with pytest.raises(Exception):
        ai.classify_category({"headline": "h"}, [])
    assert ai.errors["adjudicator"] == 1
    assert ai.errors["category_classifier"] == 1


def test_link_storyline_error_fallback():
    """link_storyline returns safe error dict when chat raises."""
    def boom(request):
        return httpx.Response(500, json={"success": False})

    ai = WorkersAI(_cfg(), transport=_transport(boom))
    entry = {
        "title": "EPA announces rule",
        "enriched_text": "The EPA announced a new rule.",
        "published_at": "2024-01-15T10:00:00Z",
        "entity_set": ["EPA"],
        "content_hash": "abc123",
    }
    candidates = [{
        "headline": "Earlier EPA action",
        "summary": "Earlier action summary",
        "newest_entry_at": "2024-01-14T10:00:00Z",
        "gap_hours": 24,
        "shared_entities": ["EPA"],
        "episode_count": 3,
    }]
    result = ai.link_storyline(entry, candidates)
    assert result["match"] is None
    assert result["same_development"] is False
    assert result["reason"].startswith("adjudicator_error")
    assert ai.errors["link_storyline"] == 1


def test_link_storyline_happy_path():
    """link_storyline parses valid JSON response."""
    def ok(request):
        return httpx.Response(200, json={
            "result": {"response": json.dumps(
                {"match": 0, "same_development": True, "reason": "same matter"})},
            "success": True,
        })

    ai = WorkersAI(_cfg(), transport=_transport(ok))
    entry = {
        "title": "EPA announces rule",
        "enriched_text": "The EPA announced a new rule.",
        "published_at": "2024-01-15T10:00:00Z",
        "entity_set": ["EPA"],
        "content_hash": "abc123",
    }
    candidates = [{
        "headline": "Earlier EPA action",
        "summary": "Earlier action summary",
        "newest_entry_at": "2024-01-14T10:00:00Z",
        "gap_hours": 24,
        "shared_entities": ["EPA"],
        "episode_count": 3,
    }]
    result = ai.link_storyline(entry, candidates)
    assert result["match"] == 0
    assert result["same_development"] is True
    assert result["reason"] == "same matter"
    assert ai.errors["link_storyline"] == 0


def test_link_storyline_out_of_range_match():
    """link_storyline coerces out-of-range match to None."""
    def ok(request):
        return httpx.Response(200, json={
            "result": {"response": json.dumps(
                {"match": 7, "same_development": False, "reason": "invalid"})},
            "success": True,
        })

    ai = WorkersAI(_cfg(), transport=_transport(ok))
    entry = {
        "title": "EPA announces rule",
        "enriched_text": "The EPA announced a new rule.",
        "published_at": "2024-01-15T10:00:00Z",
        "entity_set": ["EPA"],
        "content_hash": "abc123",
    }
    candidates = [{
        "headline": "Earlier EPA action",
        "summary": "Earlier action summary",
        "newest_entry_at": "2024-01-14T10:00:00Z",
        "gap_hours": 24,
        "shared_entities": ["EPA"],
        "episode_count": 3,
    }]
    result = ai.link_storyline(entry, candidates)
    assert result["match"] is None
    assert ai.errors["link_storyline"] == 0


def test_induce_theme_error_fallback():
    """induce_theme returns safe error dict when chat raises."""
    def boom(request):
        return httpx.Response(500, json={"success": False})

    ai = WorkersAI(_cfg(), transport=_transport(boom))
    members = [{
        "headline": "EPA announces rule",
        "summary": "EPA action summary",
    }]
    result = ai.induce_theme(members)
    assert result["theme"] is False
    assert result["name"] == ""
    assert result["reason"].startswith("adjudicator_error")
    assert ai.errors["induce_theme"] == 1


def test_induce_theme_happy_path():
    """induce_theme parses valid JSON response."""
    def ok(request):
        return httpx.Response(200, json={
            "result": {"response": json.dumps(
                {"theme": True, "name": "Regulatory Actions", "reason": "clear pattern"})},
            "success": True,
        })

    ai = WorkersAI(_cfg(), transport=_transport(ok))
    members = [{
        "headline": "EPA announces rule",
        "summary": "EPA action summary",
    }]
    result = ai.induce_theme(members)
    assert result["theme"] is True
    assert result["name"] == "Regulatory Actions"
    assert result["reason"] == "clear pattern"
    assert ai.errors["induce_theme"] == 0
