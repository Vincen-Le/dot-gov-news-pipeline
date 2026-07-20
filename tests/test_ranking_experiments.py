from datetime import datetime, timezone
from uuid import UUID

import pytest

from pipeline.ranking.contracts import RankExperimentConfig
from pipeline.ranking.experiments import calculate_rank_rows


CATEGORY = UUID("00000000-0000-4000-8000-000000000301")
CUTOFF = datetime(2026, 5, 10, tzinfo=timezone.utc)


def _record(number, *, rubric, agencies, feeds, newest, category=CATEGORY):
    card_id = UUID(f"00000000-0000-4000-8000-{number:012d}")
    return {
        "golden_event_card_id": card_id,
        "storyline_id": UUID(f"00000000-0000-4000-8001-{number:012d}"),
        "rubric": rubric,
        "rubric_version": 1 if rubric is not None else None,
        "newest_entry_at": newest,
        "agency_ids": agencies,
        "distinct_feeds": feeds,
        "category_id": category,
        "theme_id": None,
        "context_hash": f"md5:{number:032x}",
        "card_snapshot": {"id": str(card_id), "headline": f"Card {number}"},
        "context_snapshot": {"entry_count": number},
    }


def test_calculation_assigns_stable_global_and_category_positions():
    config = RankExperimentConfig(
        tau_seconds=100_000.0,
        publisher_weight_version=2,
        rubric_weights={"impact": 10.0},
        publisher_weights={"doj": 3.0, "fda": 2.0},
    )
    records = [
        _record(1, rubric={"impact": False}, agencies=["fda"], feeds=1,
                newest=datetime(2026, 5, 1, tzinfo=timezone.utc)),
        _record(2, rubric={"impact": True}, agencies=["doj"], feeds=1,
                newest=datetime(2026, 5, 2, tzinfo=timezone.utc)),
        _record(3, rubric={"impact": True}, agencies=["fda", "doj"], feeds=2,
                newest=datetime(2026, 5, 3, tzinfo=timezone.utc), category=None),
    ]

    rows = calculate_rank_rows(records, config, CUTOFF)

    assert [str(row.golden_event_card_id)[-1] for row in rows] == ["3", "2", "1"]
    assert [row.global_position for row in rows] == [1, 2, 3]
    assert rows[0].category_position is None
    assert [rows[1].category_position, rows[2].category_position] == [1, 2]
    assert rows[0].rank_input.source_weight_max == 3.0
    assert rows[0].rank_input.publisher_weight_version == 2
    assert rows[0].rank_input.input_hash.startswith("sha256:")


def test_calculation_is_independent_of_input_order_and_deduplicates_agencies():
    config = RankExperimentConfig(
        tau_seconds=100_000.0,
        publisher_weight_version=1,
        rubric_weights={"impact": 1.0},
        publisher_weights={"fda": 2.0},
    )
    left = _record(1, rubric={"impact": True}, agencies=["fda", "fda"], feeds=1,
                   newest=datetime(2026, 5, 1, tzinfo=timezone.utc))
    right = _record(2, rubric={"impact": False}, agencies=[], feeds=1,
                    newest=datetime(2026, 5, 1, tzinfo=timezone.utc))

    forward = calculate_rank_rows([left, right], config, CUTOFF)
    backward = calculate_rank_rows([right, left], config, CUTOFF)

    assert [row.golden_event_card_id for row in forward] == [
        row.golden_event_card_id for row in backward
    ]
    assert forward[0].rank_input.distinct_agencies == 1


def test_calculation_requires_timezone_aware_cutoff():
    config = RankExperimentConfig(
        tau_seconds=1.0,
        publisher_weight_version=1,
        rubric_weights={"impact": 1.0},
    )

    with pytest.raises(ValueError, match="timezone-aware"):
        calculate_rank_rows([], config, datetime(2026, 5, 1))
