from pipeline.eval_report import render_eval_report
from pipeline.judge import VECTORS, load_rubric

SCORE = {
    "reward_v2": 0.712,
    "quanta": {"v1": 0.025},
    "validity": {"v2_weak": False},
    "v1_score": 0.8, "v1_n": 20, "drift_rate": 0.1,
    "v1_method_worst": 0.75, "v1_method_worst_name": "event_key",
    "v1_method_precision": {"event_key": 0.75},
    "per_chain": {"s1": -0.5, "s2": 1.0},
    "v2_score": 0.55, "v2_n": 30, "v2_n_intruders": 12,
    "v2_discrimination": 0.62,
    "v2_theme_scores": {"t1": 0.9, "t2": 0.2},
    "v2_granularity": {"t1": "right", "t2": "too_granular"},
    "v3_score": 0.92, "v3_n": 50,
    "v4_merge_pairs": 1, "v4_candidate_n": 4, "v4_singleton_rate": 0.0,
    "v5_entity_precision": 0.85, "v5_entity_n": 200,
    "v5_event_key_validity": 0.97, "v5_missed_mean": 0.4,
    "v6_score": 0.75, "v6_n": 40,
    "v7_score": 0.7, "v7_n": 12,
    "v7_criteria": {"coverage": 0.9, "faithful": 0.95, "current": 0.8, "representative": 0.9},
    "recall": {"storyline_pairwise_f1": None, "theme_pairwise_f1": None,
               "note": "n/a (no gold labels)"},
}
META = {"run": {"name": "jul20-00-check", "id": "abc", "finished_at": "2026-07-20"},
        "pipeline": "complex_v1", "judge_model": "claude-opus-4-8",
        "counts": {"v1_chains": 8, "v2_themes": 3, "v3_pairs": 50, "v7_overviews": 12}}


def test_report_carries_values_interpretations_and_levers():
    report = render_eval_report(SCORE, META,
                                {"theme_cohesion": {"t1": 0.3, "t2": 0.7}})
    assert "R_v2 = 0.712" in report
    assert "complex_v1" in report
    assert "target ≥ 0.70" in report          # interpretation inline
    assert "lever" in report                   # every weak state names a lever
    assert "t2: too_granular" in report        # granularity flag table
    assert "enrichment lever: ['t1']" in report  # cohesion router quadrant
    assert "n/a (no gold labels)" in report    # recall slot never deleted
    assert "- s1: -0.500" in report            # worst chains spot-check ids
    assert "VALIDITY FLAG" not in report


def test_report_flags_weak_discrimination():
    score = dict(SCORE, validity={"v2_weak": True}, v2_discrimination=0.2)
    report = render_eval_report(score, META)
    assert "VALIDITY FLAG" in report


def test_rubric_sections_load_for_every_vector():
    for vector in VECTORS:
        rubric = load_rubric(vector)
        assert rubric.startswith("## ")
        assert vector.upper() in rubric.splitlines()[0]
