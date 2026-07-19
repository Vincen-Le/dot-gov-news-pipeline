from datetime import datetime, timezone
from pathlib import Path
import runpy


AUDIT = runpy.run_path(
    str(Path(__file__).parents[1] / "scripts" / "audit-news-corpus.py"))
Entry = AUDIT["Entry"]
build_label_rows = AUDIT["build_label_rows"]


def make_entry(entry_id: str, category: str = "Disaster Response & Emergency"):
    return Entry(
        id=entry_id,
        publisher="fema",
        title=f"Entry {entry_id}",
        summary="",
        body="",
        published_at=datetime(2026, 7, 18, tzinfo=timezone.utc),
        url=f"https://example.gov/{entry_id}",
        content_hash=entry_id * 64,
        category=category,
        category_confidence="high",
    )


def test_build_label_rows_preserves_storyline_and_episode_counts():
    entries = [make_entry(str(index)) for index in range(3)]
    category_ids = {
        "Disaster Response & Emergency":
            "00000000-0000-4000-8000-000000000001",
    }

    rows = build_label_rows(
        entries,
        [[0, 1, 2]],
        [[[0, 1], [2]]],
        mode="strict",
        category_ids=category_ids,
    )

    assert len(rows) == 3
    assert all(len(row["content_hash_at_labeling"]) == 64 for row in rows)
    assert {row["storyline_entry_count"] for row in rows} == {3}
    assert {row["storyline_episode_count"] for row in rows} == {2}
    assert sorted(row["episode_entry_count"] for row in rows) == [1, 2, 2]
    assert len({row["proposed_storyline_key"] for row in rows}) == 1
    assert len({row["proposed_episode_key"] for row in rows}) == 2
    assert all(row["category_confidence"] == "high" for row in rows)


def test_build_label_rows_uses_order_independent_stable_group_keys():
    entries = [make_entry(str(index)) for index in range(2)]
    category_ids = {
        "Disaster Response & Emergency":
            "00000000-0000-4000-8000-000000000001",
    }

    forward = build_label_rows(
        entries, [[0, 1]], [[[0, 1]]],
        mode="balanced", category_ids=category_ids)
    reverse = build_label_rows(
        entries, [[1, 0]], [[[1, 0]]],
        mode="balanced", category_ids=category_ids)

    assert {row["proposed_storyline_key"] for row in forward} == {
        row["proposed_storyline_key"] for row in reverse}
    assert {row["proposed_episode_key"] for row in forward} == {
        row["proposed_episode_key"] for row in reverse}
