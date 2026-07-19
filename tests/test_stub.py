from pipeline.stub import StubModels
from pipeline.vectors import cosine


def test_stub_embedder_similarity_ordering():
    a, b, c = StubModels().embed([
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
        context="")
    assert same is True
    same, _ = stub.adjudicate_same_event(
        {"title": "x", "summary": "", "entities": ["valsatrex"]},
        {"title": "y", "summary": "", "entities": ["oxprenol"]}, context="")
    assert same is False


def test_stub_compressor_cites_episodes():
    card = StubModels().compress_overview(
        {"id": "s1"},
        [{"episode_id": "e1", "date": "2026-05-14",
          "headline": "Recall announced", "summary": "..."}],
    )
    assert card["timeline"][0]["episode_id"] == "e1"
    assert set(card["rubric"]) == {
        "mass_impact", "health_safety", "economic", "policy_change",
        "rights_legal", "national_scope", "urgency", "novelty",
    }


def test_stub_embedding_tag_never_collides_with_real_models():
    assert StubModels.embedding_tag == "stub-bow-256"
    assert "bge" not in StubModels.embedding_tag


def test_stub_compare_rank_is_swap_consistent():
    a = {"headline": "FDA recalls Valsatrex", "summary": "x", "agencies": 3,
         "feeds": 4, "entries": 6, "age_hours": 2.0}
    b = {"headline": "NPS trail closure", "summary": "y", "agencies": 1,
         "feeds": 1, "entries": 1, "age_hours": 1.0}
    m = StubModels()
    assert m.compare_rank(a, b)["prefers"] == "a"
    assert m.compare_rank(b, a)["prefers"] == "b"


def test_stub_compare_rank_breaks_ties_deterministically():
    a = {"headline": "Alpha", "summary": "", "agencies": 1, "feeds": 1,
         "entries": 1, "age_hours": 0.0}
    b = {"headline": "Beta", "summary": "", "agencies": 1, "feeds": 1,
         "entries": 1, "age_hours": 0.0}
    m = StubModels()
    assert m.compare_rank(a, b)["prefers"] == "a"
    assert m.compare_rank(b, a)["prefers"] == "b"


def test_stub_category_classifier_prefers_token_overlap():
    out = StubModels().classify_category(
        {"headline": "Public health emergency", "summary": ""},
        [{"id": "c-health", "display_name": "Public Health", "origin": "seed"},
         {"id": "c-tax", "display_name": "Taxes & Revenue", "origin": "seed"}])
    assert out["category_id"] == "c-health"


def test_stub_membership_joins_on_criterion_overlap():
    out = StubModels().adjudicate_membership(
        {"headline": "FDA recalls Valsatrex", "summary": ""},
        [{"theme_id": "t-1", "name": "Drug Enforcement",
          "inclusion_criterion": "recalls of specific drugs"}])
    assert out["theme_id"] == "t-1"
