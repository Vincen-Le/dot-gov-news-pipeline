from pipeline.prompts import (
    build_adjudicator_prompt,
    build_category_prompt,
    build_theme_adjudicator_prompt,
    validate_timeline,
)


def test_adjudicator_prompt_is_split_biased():
    system, _ = build_adjudicator_prompt(
        {"title": "A", "summary": "x", "entities": ["a"]},
        {"title": "B", "summary": "y", "entities": ["b"]},
        context="",
    )
    lowered = system.lower()
    assert "only if clearly the same specific" in lowered
    assert "different products, companies, cases, or locations" in lowered


def test_validate_timeline_drops_uncited_and_unknown():
    timeline = [
        {"episode_id": "e1", "date": "2026-05-14", "text": "Recall announced"},
        {"episode_id": "hallucinated", "date": "2026-05-15", "text": "Made up"},
        {"date": "2026-05-16", "text": "No citation"},
    ]
    out = validate_timeline(timeline, {"e1", "e2"})
    assert out == [{"episode_id": "e1", "date": "2026-05-14", "text": "Recall announced"}]


def test_theme_adjudicator_prompt_lists_candidates_with_ids():
    system, user = build_theme_adjudicator_prompt(
        {"headline": "FDA recalls Valsatrex", "summary": "Contamination."},
        [{"id": "t-1", "display_name": "FDA drug recalls",
          "headlines": ["FDA recalls Xarnib"], "similarity": 0.71}])
    assert "theme_id" in system and "updated_name" in system
    assert "t-1" in user and "FDA drug recalls" in user and "0.71" in user


def test_category_prompt_lists_categories_with_origin():
    system, user = build_category_prompt(
        "FDA drug recalls",
        {"headline": "FDA recalls Valsatrex", "summary": "Contamination."},
        [{"id": "c-1", "display_name": "Food & Drug Safety", "origin": "seed"}])
    assert "category_id" in system and "new_category_name" in system
    assert "c-1" in user and "Food & Drug Safety" in user
