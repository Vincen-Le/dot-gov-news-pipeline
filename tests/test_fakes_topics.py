from datetime import datetime, timezone

import numpy as np

from pipeline.vectors import pack_fp16
from tests.fakes import FakeStore

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)


def _storyline(store, sid, headline="h"):
    store.storylines[sid] = {
        "id": sid, "entity_set": [], "event_keys": [], "episode_count": 1,
        "centroid": pack_fp16(np.ones(4, dtype=np.float32)),
        "headline": headline, "summary": "", "theme_id": None,
        "category_id": None, "newest_entry_at": T0, "first_entry_at": T0,
    }


def test_category_write_and_reads():
    store = FakeStore()
    store.categories["c1"] = {"id": "c1", "display_name": "Public Health",
                              "origin": "seed"}
    _storyline(store, "s1")
    assert store.uncategorized_storyline_ids() == ["s1"]

    store.set_storyline_category("s1", "c1", "classified", "obvious")
    assert store.uncategorized_storyline_ids() == []
    assert store.storyline_theme_state("s1")["category_id"] == "c1"

    residents = store.categorized_unthemed()
    assert [r["id"] for r in residents] == ["s1"]
    assert residents[0]["category_id"] == "c1"


def test_create_theme_carries_criterion_and_demote_hides_theme():
    store = FakeStore()
    _storyline(store, "s1")
    theme_id = store.create_theme(
        "Measles Outbreak Response", pack_fp16(np.ones(4, dtype=np.float32)),
        None, None, "storylines about the 2026 measles outbreak response")
    store.assign_theme("s1", theme_id, "promoted", None, "test", None, None)

    themes = store.all_themes()
    assert themes[0]["inclusion_criterion"].startswith("storylines about")

    store.demote_theme(theme_id)
    assert store.all_themes() == []
    assert store.storylines["s1"]["theme_id"] is None
    assert store.storylines["s1"]["theme_reason"].startswith("demoted")
