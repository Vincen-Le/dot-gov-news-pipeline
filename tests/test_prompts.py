from pipeline.shared.prompts import (
    COMPRESSOR_SYSTEM,
    build_adjudicator_prompt,
    build_category_classifier_prompt,
    build_theme_membership_prompt,
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
    assert out == [
        {"episode_id": "e1", "date": "2026-05-14", "text": "Recall announced"}]


def test_compressor_prompt_demands_one_to_two_sentence_summary():
    assert "1-2" in COMPRESSOR_SYSTEM
    assert "<= 3 sentences" not in COMPRESSOR_SYSTEM


def test_compressor_rubric_judges_whole_chain():
    assert "entire chain" in COMPRESSOR_SYSTEM
    assert "not only the latest" in COMPRESSOR_SYSTEM


def test_rank_audit_prompt_shape():
    from pipeline.shared.prompts import RANK_AUDIT_SYSTEM, build_rank_audit_prompt
    a = {"headline": "A", "summary": "sa", "agencies": 2, "feeds": 3,
         "entries": 4, "age_hours": 5.0}
    b = {"headline": "B", "summary": "sb", "agencies": 1, "feeds": 1,
         "entries": 1, "age_hours": 50.0}
    system, user = build_rank_audit_prompt(a, b)
    assert system == RANK_AUDIT_SYSTEM
    assert '"prefers"' in system
    assert "Item A" in user and "Item B" in user
    assert "age_hours" in user


def test_category_classifier_lists_seeded_categories_and_guidance():
    system, user = build_category_classifier_prompt(
        {"headline": "FTC settles deceptive fee case", "summary": "Consumer case."},
        [
            {"id": "c-law", "display_name": "Justice & Law Enforcement",
             "origin": "seed"},
            {"id": "c-fin", "display_name": "Financial Regulation",
             "origin": "seed"},
        ],
    )
    assert "exactly one" in system
    assert "choose by subject matter, not the publishing agency" in system
    assert "general consumer-protection and antitrust enforcement" in user
    assert "securities, banking, capital markets" in user


def test_membership_prompt_is_none_biased_and_lists_criterion():
    system, user = build_theme_membership_prompt(
        {"headline": "FDA recalls Valsatrex", "summary": "Safety review."},
        [{"theme_id": "t-1", "name": "Drug Recall Enforcement",
          "inclusion_criterion": "recalls after FDA safety reviews",
          "storyline_count": 2, "recent_headlines": [],
          "days_since_active": 1}],
    )
    assert "when unsure, answer with an empty theme_id" in system
    assert "Creating themes is not your job" in system
    assert "t-1" in user
    assert "recalls after FDA safety reviews" in user
