from dataclasses import replace
from datetime import datetime, timezone
import math

import pytest

from pipeline.ranking.contracts import (
    RANK_SYSTEM_V1,
    RankExperimentConfig,
    RankInputV1,
    RankTermsV1,
    canonical_hash,
    canonical_json,
    compute_rank_terms_v1,
)


T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)


def test_canonical_json_is_order_independent_and_normalizes_time():
    left = {"b": {"z", "a"}, "a": datetime(2026, 5, 14, 10, 0, tzinfo=timezone.utc)}
    right = {"a": T0.replace(hour=10), "b": {"a", "z"}}

    assert canonical_json(left) == canonical_json(right)
    assert canonical_hash(left) == canonical_hash(right)
    assert canonical_hash(left).startswith("sha256:")


def test_canonical_json_rejects_naive_datetimes_and_nonfinite_values():
    with pytest.raises(ValueError, match="timezone-aware"):
        canonical_json({"at": datetime(2026, 5, 14)})
    with pytest.raises(ValueError, match="non-finite"):
        canonical_json({"score": float("nan")})


def test_rank_system_v1_contract_is_stable_and_semantic_changes_hash():
    assert RANK_SYSTEM_V1.ordered_term_keys[-1] == "freshness_term"
    changed = replace(RANK_SYSTEM_V1, rubric_semantics_key="newsworthiness_boolean_v2")
    assert changed.contract_hash != RANK_SYSTEM_V1.contract_hash


def test_experiment_config_hash_changes_when_a_dial_changes():
    config = RankExperimentConfig(
        tau_seconds=124600.0,
        publisher_weight_version=1,
        rubric_weights={"mass_impact": 1.0, "urgency": 2.0},
    )
    retuned = replace(config, tau_seconds=100000.0)
    assert config.config_hash != retuned.config_hash


def test_rank_input_requires_explicit_freshness_cutoff_and_is_hashable():
    value = RankInputV1(
        rubric={"mass_impact": True},
        rubric_version=1,
        distinct_agencies=2,
        distinct_feeds=3,
        source_weight_max=2.0,
        newest_entry_at=T0,
        freshness_cutoff_at=T0,
        tau_seconds=124600.0,
    )
    assert value.input_hash == canonical_hash(value)
    with pytest.raises(ValueError, match="rubric version"):
        replace(value, rubric_version=None)


def test_rank_terms_sum_excludes_prior_used_flag():
    terms = RankTermsV1(
        rubric_points=4.0,
        prior_used=False,
        agency_term=0.5,
        feed_term=0.25,
        source_term=0.75,
        freshness_term=14000.0,
    )
    assert terms.rank_key == 14005.5


def test_v1_evaluator_is_cutoff_deterministic_and_uses_frozen_weights():
    config = RankExperimentConfig(
        tau_seconds=100.0,
        publisher_weight_version=3,
        rubric_weights={"mass_impact": 4.0, "novelty": 2.0},
        publisher_weights={"doj": 3.0},
    )
    rank_input = RankInputV1(
        rubric={"mass_impact": True, "novelty": False},
        rubric_version=1,
        distinct_agencies=2,
        distinct_feeds=3,
        source_weight_max=3.0,
        newest_entry_at=datetime(2026, 5, 2, tzinfo=timezone.utc),
        freshness_cutoff_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
        tau_seconds=100.0,
    )

    terms = compute_rank_terms_v1(rank_input, config)

    assert terms.prior_used is False
    assert terms.rubric_points == 4.0
    assert terms.source_term == pytest.approx(math.log(3.0))
    assert terms.freshness_term == pytest.approx(
        datetime(2026, 5, 1, tzinfo=timezone.utc).timestamp() / 100.0
    )


def test_v1_evaluator_applies_unjudged_prior():
    config = RankExperimentConfig(
        tau_seconds=100.0,
        publisher_weight_version=1,
        rubric_weights={"one": 4.0, "two": 2.0},
    )
    rank_input = RankInputV1(
        rubric=None,
        rubric_version=None,
        distinct_agencies=0,
        distinct_feeds=0,
        source_weight_max=1.0,
        newest_entry_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
        freshness_cutoff_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
        tau_seconds=100.0,
    )

    assert compute_rank_terms_v1(rank_input, config).rubric_points == 3.0
