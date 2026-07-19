import importlib.util
from pathlib import Path

import pytest


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "eval"
    / "export_judge_artifacts.py"
)
spec = importlib.util.spec_from_file_location("export_judge_artifacts", SCRIPT)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


def test_v3_uses_storyline_stream_category_not_theme_category():
    pairs = exporter.build_category_pairs(
        [{
            "storyline_id": "s1",
            "theme_id": "t1",
            "stream_category_id": "c-storyline",
            "theme_reason": "not judge context",
        }],
        [{
            "theme_id": "t1",
            "display_name": "Recall fallout",
            "category_id": "c-theme",
        }],
        [
            {"category_id": "c-storyline", "display_name": "Drug Safety"},
            {"category_id": "c-theme", "display_name": "Public Health"},
        ],
    )

    assert pairs[0]["filed_category"] == "Drug Safety"
    assert "theme_reason" not in pairs[0]["storyline"]


def test_v3_includes_unthemed_storylines_at_storyline_grain():
    pairs = exporter.build_category_pairs(
        [{
            "storyline_id": "s1",
            "theme_id": None,
            "stream_category_id": "c1",
        }],
        [],
        [{"category_id": "c1", "display_name": "Drug Safety"}],
    )

    assert pairs == [{
        "storyline": {
            "storyline_id": "s1",
            "theme_id": None,
            "stream_category_id": "c1",
        },
        "theme_id": "",
        "theme_name": None,
        "filed_category": "Drug Safety",
    }]


def test_export_rejects_live_state_that_differs_from_run_snapshot():
    class FakeDb:
        def all(self, query):
            if "from public.storylines" in query:
                return [{"id": "live-storyline"}]
            return []

    snapshot = {
        "storylines": [{"id": "frozen-storyline"}],
        "episodes": [],
        "episode_entries": [],
        "news_entries": [],
        "event_cards": [],
        "topic_themes": [],
        "topic_categories": [],
    }

    with pytest.raises(SystemExit, match="live clustering state"):
        exporter.assert_live_matches_snapshot(FakeDb(), snapshot)
