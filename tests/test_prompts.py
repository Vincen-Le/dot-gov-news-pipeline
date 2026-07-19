from pipeline.prompts import (
    COMPRESSOR_SYSTEM,
    build_adjudicator_prompt,
    build_category_prompt,
    build_theme_namer_prompt,
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


def test_compressor_prompt_demands_one_to_two_sentence_summary():
    assert "1-2" in COMPRESSOR_SYSTEM
    assert "<= 3 sentences" not in COMPRESSOR_SYSTEM


def test_theme_namer_prompt_demands_short_compact_label():
    system, user = build_theme_namer_prompt(
        {"headline": "FDA recalls Valsatrex", "summary": "Contamination."})
    assert "2-5 words" in system
    assert "Output only the label" in system
    assert "FDA recalls Valsatrex" in user


def test_category_prompt_lists_categories_with_origin():
    system, user = build_category_prompt(
        "FDA drug recalls",
        {"headline": "FDA recalls Valsatrex", "summary": "Contamination."},
        [{"id": "c-1", "display_name": "Food & Drug Safety", "origin": "seed"}])
    assert "category_id" in system and "new_category_name" in system
    assert "c-1" in user and "Food & Drug Safety" in user


def test_compressor_rubric_judges_whole_chain():
    from pipeline.prompts import COMPRESSOR_SYSTEM
    assert "entire chain" in COMPRESSOR_SYSTEM
    assert "not only the latest" in COMPRESSOR_SYSTEM


def test_rank_audit_prompt_shape():
    from pipeline.prompts import RANK_AUDIT_SYSTEM, build_rank_audit_prompt
    a = {"headline": "A", "summary": "sa", "agencies": 2, "feeds": 3,
         "entries": 4, "age_hours": 5.0}
    b = {"headline": "B", "summary": "sb", "agencies": 1, "feeds": 1,
         "entries": 1, "age_hours": 50.0}
    system, user = build_rank_audit_prompt(a, b)
    assert system == RANK_AUDIT_SYSTEM
    assert '"prefers"' in system
    assert "Item A" in user and "Item B" in user
    assert "age_hours" in user


def test_theme_adjudicator_prompt_lists_candidates_and_json_contract():
    from pipeline.prompts import build_theme_adjudicator_prompt

    system, user = build_theme_adjudicator_prompt(
        {"headline": "State opens Harvard exchange-program investigation",
         "summary": "Investigation into sponsor eligibility."},
        [{"theme_id": "t-1", "name": "US Visa Sanctions Brazil",
          "storyline_count": 16,
          "recent_headlines": ["Visa restrictions on Brazilian officials"]}],
    )
    assert "JSON" in system
    assert "merge_theme_ids" in system
    assert "spawn" in system
    assert "t-1" in user
    assert "US Visa Sanctions Brazil" in user
    assert "Harvard exchange-program" in user
