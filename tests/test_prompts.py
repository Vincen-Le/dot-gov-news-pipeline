from pipeline.prompts import (
    COMPRESSOR_SYSTEM,
    build_adjudicator_prompt,
    build_theme_creator_prompt,
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
    assert "shared holiday, anniversary, observance, or umbrella initiative" in lowered
    assert "belongs at the theme level" in lowered


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


def test_theme_creator_prompt_demands_general_entity_resistant_label_and_category():
    system, user = build_theme_creator_prompt(
        {"headline": "Tijuana River water cleanup expands", "summary": "Cleanup work."},
        [{"id": "c-1", "display_name": "Energy & Environment", "origin": "seed"}],
    )
    assert "2-5 words" in system
    assert "more specific than a category" in system
    assert "incidental named entities" in system
    assert "Tijuana River Water Cleanup" in system
    assert "America 250" in system
    assert "theme_name" in system and "category_id" in system
    assert "c-1" in user and "Energy & Environment" in user
    assert "choose by subject matter, not the publishing agency" in system


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
        [{"id": "c-1", "display_name": "Foreign Affairs & Trade", "origin": "seed"}],
    )
    assert "JSON" in system
    assert "merge_theme_ids" in system
    assert "spawn" in system
    assert "t-1" in user
    assert "US Visa Sanctions Brazil" in user
    assert "Harvard exchange-program" in user
    assert "category_id" in system
    assert "c-1" in user and "Foreign Affairs & Trade" in user


def test_seeded_category_prompt_includes_consistency_guidance():
    _, user = build_theme_creator_prompt(
        {"headline": "FTC settles deceptive fee case", "summary": "Consumer case."},
        [
            {"id": "c-law", "display_name": "Justice & Law Enforcement", "origin": "seed"},
            {"id": "c-fin", "display_name": "Financial Regulation", "origin": "seed"},
        ],
    )
    assert "general consumer-protection and antitrust enforcement" in user
    assert "securities, banking, capital markets" in user


def test_theme_pair_prompt_requires_llm_verdict_and_seeded_category():
    from pipeline.prompts import build_theme_pair_adjudicator_prompt

    system, user = build_theme_pair_adjudicator_prompt(
        {"theme_id": "t-1", "name": "Veteran Employment Services",
         "recent_headlines": ["Veteran career fair"]},
        {"theme_id": "t-2", "name": "Veteran Employment",
         "recent_headlines": ["Veteran jobs of the week"]},
        [{"id": "c-vet", "display_name": "Veterans Affairs", "origin": "seed"}],
    )
    assert "same_theme" in system and "canonical_name" in system
    assert "Shared category, agency, document style" in system
    assert "t-1" in user and "t-2" in user and "c-vet" in user
