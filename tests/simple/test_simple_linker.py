from datetime import datetime, timedelta, timezone

import numpy as np

from pipeline.shared.config import Config
from pipeline.shared.stub import StubModels
from pipeline.simple.index import StorylineIndex
from pipeline.simple.linker import Linker
from tests.fakes import FakeStore

CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             engine="spine")
T0 = datetime(2025, 7, 1, tzinfo=timezone.utc)

# Mirrors episodes_attach_method_valid / episode_entries_attach_method_valid
# in supabase/migrations/20260718000600_create_storylines_episodes.sql — the
# DB-legal vocabulary spine's writes must map onto (see pipeline/simple/linker.py's
# _EPISODE_ATTACH_METHOD / _ENTRY_ATTACH_METHOD).
EPISODE_ATTACH_METHODS = {
    "event_key", "entity_candidate", "adjudicated_join", "new_storyline",
    "consolidation_merge",
}
ENTRY_ATTACH_METHODS = {
    "exact_url", "content_hash", "near_dup", "event_key", "centroid_join",
    "entity_community", "adjudicated_join", "adjudicated_new", "new_cluster",
    "consolidation_merge", "consolidation_split",
}


class NoCategories:
    def classify(self, storyline_id, method="stream"):
        return None


def _row(i, title, t, vec):
    return {"id": f"entry-{i}", "title": title, "summary": f"{title} summary.",
            "enriched_text": f"{title} enriched.", "published_at": t,
            "content_hash": f"hash-{i}",
            "embedding": vec, "entity_set": ["ftc"], "event_keys": [],
            "agency": "ftc"}


def _linker(store):
    return Linker(store, StubModels(), CFG, StorylineIndex(), NoCategories())


def test_first_entry_creates_storyline_with_master_node():
    store = FakeStore()
    linker = _linker(store)
    vec = np.array([1.0, 0.0], dtype=np.float32)
    out = linker.process_entry(_row(1, "FTC sues Acme Corp over merger", T0, vec), vec)
    assert out["method"] == "new_storyline_no_candidates"
    overviews = [c for c in store.cards if c["kind"] == "overview"]
    assert len(overviews) == 1                       # master node exists at birth
    assert overviews[0]["storyline_id"] == out["storyline_id"]
    # observability label differs from the DB-legal value actually written
    assert store.episodes[out["episode_id"]]["attach_method"] in EPISODE_ATTACH_METHODS
    assert store.attaches[-1]["method"] in ENTRY_ATTACH_METHODS


def test_same_development_attaches_to_open_episode():
    store = FakeStore()
    linker = _linker(store)
    vec = np.array([1.0, 0.0], dtype=np.float32)
    first = linker.process_entry(
        _row(1, "FTC sues Acme Corp over merger", T0, vec), vec)
    second = linker.process_entry(
        _row(2, "FTC sues Acme Corp — merger challenge detail",
             T0 + timedelta(hours=2), vec), vec)
    assert second["method"] == "judge_same_dev"
    assert second["episode_id"] == first["episode_id"]
    assert store.attaches[-1]["method"] in ENTRY_ATTACH_METHODS


def test_stale_episode_gets_new_episode_same_storyline():
    store = FakeStore()
    linker = _linker(store)
    vec = np.array([1.0, 0.0], dtype=np.float32)
    first = linker.process_entry(
        _row(1, "FTC sues Acme Corp over merger", T0, vec), vec)
    late = T0 + timedelta(hours=CFG.spine_episode_gap_hours + 1)
    second = linker.process_entry(
        _row(2, "FTC sues Acme Corp merger ruling", late, vec), vec)
    assert second["method"] == "judge_new_episode"
    assert second["storyline_id"] == first["storyline_id"]
    assert second["episode_id"] != first["episode_id"]
    assert store.episodes[second["episode_id"]]["attach_method"] in EPISODE_ATTACH_METHODS
    assert store.attaches[-1]["method"] in ENTRY_ATTACH_METHODS


def test_unrelated_entry_spawns_new_storyline():
    store = FakeStore()
    linker = _linker(store)
    v1 = np.array([1.0, 0.0], dtype=np.float32)
    v2 = np.array([0.9, 0.44], dtype=np.float32)  # above floor but no token overlap
    first = linker.process_entry(
        _row(1, "FTC sues Acme Corp over merger", T0, v1), v1)
    second = linker.process_entry(
        _row(2, "NASA launches lunar probe mission", T0 + timedelta(hours=1), v2), v2)
    assert second["method"] == "new_storyline"
    assert second["storyline_id"] != first["storyline_id"]
    assert store.episodes[second["episode_id"]]["attach_method"] in EPISODE_ATTACH_METHODS
    assert store.attaches[-1]["method"] in ENTRY_ATTACH_METHODS
