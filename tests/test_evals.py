import random

import pytest

from pipeline.shared.eval_namespace import get_eval_namespace
from pipeline.shared.evals import (
    b_cubed,
    pairwise_f1,
    quanta,
    reward_v2,
    sample_intruders,
    score_v1,
    score_v2,
    score_v3,
    score_v4,
    score_v5,
    score_v6,
    score_v7,
    weighted_binary,
)


def test_eval_namespaces_keep_pipeline_ledgers_separate():
    complex_namespace = get_eval_namespace("complex_v1")
    simple_namespace = get_eval_namespace("simple_v1")
    assert complex_namespace.experiment_runs_table == "complex_v1_experiment_runs"
    assert simple_namespace.experiment_runs_table == "simple_v1_experiment_runs"
    assert complex_namespace.experiment_snapshots_table == (
        "complex_v1_experiment_cluster_snapshots"
    )
    assert complex_namespace.annotate_snapshot_rpc != simple_namespace.annotate_snapshot_rpc


def test_eval_namespace_rejects_arbitrary_sql_identifier():
    with pytest.raises(ValueError, match="unknown eval pipeline"):
        get_eval_namespace("complex_v1; drop table news_entries")


def test_weighted_binary_false_merge_costs_double():
    assert weighted_binary([True, True, False]) == pytest.approx((2 - 2) / 3)
    with pytest.raises(ValueError):
        weighted_binary([])


def test_score_v1_clean_chains():
    pairs = [
        {"storyline_id": "s1", "episode_id": "e2", "related": "y", "attach_method": "event_key"},
        {"storyline_id": "s1", "episode_id": "e3", "related": "y", "attach_method": "entity"},
    ]
    chains = [{"storyline_id": "s1", "endpoints_related": "y", "chain_verdict": "coherent"}]
    result = score_v1(pairs, chains)
    assert result["v1_score"] == 1.0
    assert result["v1_n"] == 2
    assert result["drift_rate"] == 0.0
    assert result["v1_method_worst"] == 1.0
    assert result["v1_method_worst_name"] in {"event_key", "entity"}


def test_score_v1_drift_charges_last_link():
    # every pairwise link passes, but endpoints fail -> one link charged as unrelated
    pairs = [
        {"storyline_id": "s1", "episode_id": "e2", "related": "y", "attach_method": "event_key"},
        {"storyline_id": "s1", "episode_id": "e3", "related": "y", "attach_method": "event_key"},
    ]
    chains = [{"storyline_id": "s1", "endpoints_related": "n", "chain_verdict": "drifted"}]
    result = score_v1(pairs, chains)
    assert result["v1_score"] == pytest.approx((1 - 2) / 2)
    assert result["drift_rate"] == 1.0


def test_score_v1_drift_not_double_charged_when_pairwise_already_failed():
    pairs = [
        {"storyline_id": "s1", "episode_id": "e2", "related": "n", "attach_method": "event_key"},
        {"storyline_id": "s1", "episode_id": "e3", "related": "y", "attach_method": "event_key"},
    ]
    chains = [{"storyline_id": "s1", "endpoints_related": "n", "chain_verdict": "should_split"}]
    result = score_v1(pairs, chains)
    assert result["v1_score"] == pytest.approx((1 - 2) / 2)  # unchanged by drift rule


def test_score_v1_rejects_missing_endpoint_verdict():
    pairs = [{
        "storyline_id": "s1",
        "episode_id": "e2",
        "related": "y",
        "attach_method": "event_key",
    }]
    with pytest.raises(ValueError, match="expected 1/0"):
        score_v1(pairs, [{
            "storyline_id": "s1",
            "endpoints_related": "",
            "chain_verdict": "coherent",
        }])


def test_score_v2_intruders_fold_into_score():
    theme_rows = [
        {"theme_id": "t1", "storyline_id": "m1", "fits": "y"},
        {"theme_id": "t1", "storyline_id": "m2", "fits": "y"},
        {"theme_id": "t1", "storyline_id": "x1", "fits": "n"},  # planted, rejected
        {"theme_id": "t1", "storyline_id": "x2", "fits": "y"},  # planted, accepted!
    ]
    granularity = [{"theme_id": "t1", "granularity": "right"}]
    truth = [{"theme_id": "t1", "storyline_id": "x1"}, {"theme_id": "t1", "storyline_id": "x2"}]
    result = score_v2(theme_rows, granularity, truth)
    # (2 fits - 0 misfits*2 - 1 intruder_accepted*2) / (2 members + 2 intruders)
    assert result["v2_score"] == pytest.approx((2 - 2) / 4)
    assert result["v2_discrimination"] == pytest.approx(1.0 - 0.5)
    assert result["v2_n_intruders"] == 2


def test_score_v2_granularity_penalty():
    theme_rows = [{"theme_id": "t1", "storyline_id": "m1", "fits": "y"}]
    granularity = [{"theme_id": "t1", "granularity": "too_granular"}]
    result = score_v2(theme_rows, granularity, [])
    assert result["v2_score"] == pytest.approx(1.0 - 0.25)


def test_v2_quantum_respects_macro_average_and_intruder_denominators():
    scored = score_v2(
        [
            {"theme_id": "t1", "storyline_id": "m1", "fits": "y"},
            {"theme_id": "t2", "storyline_id": "m2", "fits": "y"},
            {"theme_id": "t2", "storyline_id": "m3", "fits": "y"},
            {"theme_id": "t2", "storyline_id": "x1", "fits": "n"},
            {"theme_id": "t2", "storyline_id": "x2", "fits": "n"},
        ],
        [
            {"theme_id": "t1", "granularity": "right"},
            {"theme_id": "t2", "granularity": "right"},
        ],
        [
            {"theme_id": "t2", "storyline_id": "x1"},
            {"theme_id": "t2", "storyline_id": "x2"},
        ],
    )
    ns = {
        **scored,
        "v1_n": 1,
        "v3_n": 1,
        "v5_entity_n": 1,
        "v6_n": 1,
        "v7_n": 1,
    }
    # One flip in one-case t1 changes its theme score by 3, then macro /2,
    # then reward /6.
    assert quanta(ns)["v2"] == pytest.approx(3 / 1 / 2 / 6)


def test_score_v7_hallucination_costs_double():
    rows = [
        {"storyline_id": "s1", "coverage": "y", "faithful": "n", "current": "y", "representative": "y"},
        {"storyline_id": "s2", "coverage": "y", "faithful": "y", "current": "y", "representative": "y"},
    ]
    result = score_v7(rows)
    # 7 passed, 1 faithful failure -> (7 - 2) / 8
    assert result["v7_score"] == pytest.approx(5 / 8)
    assert result["v7_criteria"]["faithful"] == pytest.approx(0.5)
    assert result["v7_n"] == 2


def test_reward_v2_formula():
    reward = reward_v2({"v1_score": 0.6, "v2_score": 0.5, "v3_score": 0.9,
                        "v5_entity_precision": 0.8, "v6_score": 0.7, "v7_score": 0.7,
                        "v4_merge_pairs": 2})
    assert reward == pytest.approx((0.6 + 0.5 + 0.9 + 0.8 + 0.7 + 0.7) / 6 - 0.04)


def test_score_v3_and_v5_and_v6_port():
    v3 = score_v3([{"verdict": "correct"}, {"verdict": "ambiguous"}, {"verdict": "better_option_exists"}])
    assert v3["v3_score"] == pytest.approx(2 / 3)
    v5 = score_v5([{"kind": "entity", "valid": "y"}, {"kind": "entity", "valid": "n"},
                   {"kind": "event_key", "valid": "y"}], miss_count=3, sampled_count=10)
    assert v5["v5_entity_precision"] == 0.5
    assert v5["v5_event_key_validity"] == 1.0
    assert v5["v5_missed_mean"] == pytest.approx(0.3)
    v6 = score_v6([{"same_event": "y"}, {"same_event": "n"}])
    assert v6["v6_score"] == pytest.approx((1 - 2) / 2)


def test_v4_and_v5_reject_unknown_categorical_values():
    assert score_v4([{"should_merge": "y"}, {"should_merge": "n"}]) == {
        "v4_merge_pairs": 1,
        "v4_candidate_n": 2,
    }
    with pytest.raises(ValueError, match="expected 1/0"):
        score_v4([{"should_merge": "maybe"}])
    with pytest.raises(ValueError, match="invalid V5 token kinds"):
        score_v5([{"kind": "other", "valid": "y"}], 0, 1)
    normalized = score_v5([{"kind": " ENTITY ", "valid": "n"}], 0, 1,
                          stats_rows=[{"valid": "y"}])
    assert normalized["v5_sampled_entity_n"] == 1
    assert normalized["v5_entity_precision"] == 0.5


def test_sample_intruders_hard_negatives_first_then_random():
    rng = random.Random(42)
    candidates = [("hard1", 0.9), ("hard2", 0.8), ("c3", 0.5), ("c4", 0.4), ("c5", 0.3)]
    picked = sample_intruders(candidates, k=4, rng=rng)
    assert len(picked) == len(set(picked)) == 4
    assert "hard1" in picked and "hard2" in picked  # ceil(4/2)=2 hard negatives
    assert set(picked) <= {c[0] for c in candidates}


def test_sample_intruders_small_pool():
    assert sample_intruders([("a", 0.5)], k=5, rng=random.Random(42)) == ["a"]


def test_pairwise_perfect_match():
    pred = {"a": "1", "b": "1", "c": "2"}
    gold = {"a": "x", "b": "x", "c": "y"}
    scores = pairwise_f1(pred, gold)
    assert scores == {"precision": 1.0, "recall": 1.0, "f1": 1.0, "n_items": 3}


def test_pairwise_fragmentation_hits_recall_not_precision():
    # gold says a,b,c belong together; pred split c off
    pred = {"a": "1", "b": "1", "c": "2"}
    gold = {"a": "x", "b": "x", "c": "x"}
    scores = pairwise_f1(pred, gold)
    assert scores["precision"] == 1.0
    assert round(scores["recall"], 4) == round(1 / 3, 4)
    assert scores["f1"] == 0.5


def test_pairwise_false_merge_hits_precision_not_recall():
    pred = {"a": "1", "b": "1", "c": "1"}
    gold = {"a": "x", "b": "x", "c": "y"}
    scores = pairwise_f1(pred, gold)
    assert round(scores["precision"], 4) == round(1 / 3, 4)
    assert scores["recall"] == 1.0


def test_items_missing_gold_labels_are_excluded():
    pred = {"a": "1", "b": "1", "c": "1"}
    gold = {"a": "x", "b": "x"}  # c unlabeled
    scores = pairwise_f1(pred, gold)
    assert scores["n_items"] == 2
    assert scores["f1"] == 1.0


def test_pairwise_all_singletons_is_vacuously_perfect_precision():
    pred = {"a": "1", "b": "2"}
    gold = {"a": "x", "b": "x"}
    scores = pairwise_f1(pred, gold)
    assert scores["precision"] == 1.0  # no predicted pairs -> nothing wrong
    assert scores["recall"] == 0.0
    assert scores["f1"] == 0.0


def test_b_cubed_fragmentation():
    pred = {"a": "1", "b": "1", "c": "2"}
    gold = {"a": "x", "b": "x", "c": "x"}
    scores = b_cubed(pred, gold)
    assert scores["precision"] == 1.0
    assert round(scores["recall"], 4) == round(5 / 9, 4)
    assert scores["n_items"] == 3


def test_b_cubed_perfect():
    pred = {"a": "1", "b": "1"}
    gold = {"a": "x", "b": "x"}
    scores = b_cubed(pred, gold)
    assert scores["precision"] == 1.0 and scores["recall"] == 1.0 and scores["f1"] == 1.0


def test_empty_intersection_returns_zero_n():
    scores = pairwise_f1({"a": "1"}, {"b": "x"})
    assert scores["n_items"] == 0
    assert scores["f1"] == 0.0
