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


def test_stub_name_theme_returns_short_deterministic_label():
    name = StubModels().name_theme(
        {"headline": "FDA recalls Valsatrex lots after contamination review",
         "summary": ""})
    assert name == "FDA recalls Valsatrex lots after"
    assert len(name.split()) <= 5


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


def test_stub_embedding_tag_never_collides_with_real_models():
    assert StubModels.embedding_tag == "stub-bow-256"
    assert "bge" not in StubModels.embedding_tag
