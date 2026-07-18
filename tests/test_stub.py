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
