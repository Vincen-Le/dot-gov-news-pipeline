from pipeline.stub import StubModels
from pipeline.vectors import cosine


def test_stub_embedder_similarity_ordering():
    stub = StubModels()
    a, b, c = stub.embed([
        "FDA recalls Valsatrex blood pressure medication contamination",
        "Valsatrex recall expanded by FDA after contamination found",
        "EPA finalizes emissions rule for power plants",
    ])
    assert cosine(a, b) > cosine(a, c)


def test_stub_adjudicator_uses_entity_overlap():
    stub = StubModels()
    same, _ = stub.adjudicate_same_event(
        {"title": "x", "summary": "", "entities": ["valsatrex"]},
        {"title": "y", "summary": "", "entities": ["valsatrex", "sundexo"]},
        context="",
    )
    assert same is True
    same, _ = stub.adjudicate_same_event(
        {"title": "x", "summary": "", "entities": ["valsatrex"]},
        {"title": "y", "summary": "", "entities": ["oxprenol"]},
        context="",
    )
    assert same is False


def test_stub_compressor_cites_episodes():
    stub = StubModels()
    card = stub.compress_overview(
        {"id": "s1"},
        [{"episode_id": "e1", "date": "2026-05-14", "headline": "Recall announced", "summary": "..."}],
    )
    assert card["timeline"][0]["episode_id"] == "e1"
    assert set(card["rubric"]) == {
        "mass_impact", "health_safety", "economic", "policy_change",
        "rights_legal", "national_scope", "urgency", "novelty",
    }


def test_stub_adjudicate_theme_joins_on_shared_token():
    result = StubModels().adjudicate_theme(
        {"headline": "FDA recalls Valsatrex", "summary": ""},
        [{"id": "t-1", "display_name": "FDA recalls",
          "headlines": ["FDA recalls Xarnib"], "similarity": 0.7}])
    assert result["theme_id"] == "t-1"
    assert result["reason"].startswith("stub")


def test_stub_adjudicate_theme_spawns_on_disjoint_tokens():
    result = StubModels().adjudicate_theme(
        {"headline": "SSA field office closures", "summary": ""},
        [{"id": "t-1", "display_name": "FDA recalls",
          "headlines": ["FDA recalls Xarnib"], "similarity": 0.7}])
    assert result["theme_id"] is None
    assert result["updated_name"] == "SSA field office closures"


def test_stub_classify_category_matches_token_else_none():
    hit = StubModels().classify_category(
        "FDA drug recalls", {"headline": "FDA recalls Valsatrex", "summary": ""},
        [{"id": "c-1", "display_name": "Drug Safety", "origin": "seed"}])
    assert hit["category_id"] == "c-1"
    miss = StubModels().classify_category(
        "SSA closures", {"headline": "SSA field office closures", "summary": ""},
        [{"id": "c-1", "display_name": "Drug Safety", "origin": "seed"}])
    assert miss["category_id"] is None
    assert miss["new_category_name"] == "General Government"
