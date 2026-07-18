from datetime import datetime, timedelta, timezone

import numpy as np

from pipeline.window import ReplayWindow

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)


def vec(x):
    v = np.zeros(4, dtype=np.float32)
    v[x] = 1.0
    return v


def test_dup_and_embedded_within_window():
    w = ReplayWindow(window_hours=72.0)
    w.add("e1", "ep1", "hash-a", T0, vec(0))
    w.add("e2", "ep1", "hash-b", T0 + timedelta(hours=1), None)  # no embedding yet

    t = T0 + timedelta(hours=2)
    assert w.content_hash_dup("hash-a", t, 72.0) == {"id": "e1", "episode_id": "ep1"}
    assert w.content_hash_dup("hash-zz", t, 72.0) is None

    embedded = w.recent_embedded(t, 72.0)
    assert [r["id"] for r in embedded] == ["e1"]           # unembedded rows excluded
    assert np.allclose(embedded[0]["embedding"], vec(0))


def test_newest_match_wins():
    w = ReplayWindow(72.0)
    w.add("old", "ep1", "same", T0, None)
    w.add("new", "ep2", "same", T0 + timedelta(hours=5), None)
    dup = w.content_hash_dup("same", T0 + timedelta(hours=6), 72.0)
    assert dup == {"id": "new", "episode_id": "ep2"}


def test_advance_evicts_old_entries():
    w = ReplayWindow(72.0)
    w.add("e1", "ep1", "hash-a", T0, vec(0))
    w.advance(T0 + timedelta(hours=73))
    assert w.content_hash_dup("hash-a", T0 + timedelta(hours=73), 72.0) is None
    assert w.recent_embedded(T0 + timedelta(hours=73), 72.0) == []


def test_narrower_query_window_respected():
    # engine may query with a narrower window than the deque retains
    w = ReplayWindow(72.0)
    w.add("e1", "ep1", "hash-a", T0, vec(0))
    t = T0 + timedelta(hours=10)
    assert w.content_hash_dup("hash-a", t, 4.0) is None
    assert w.recent_embedded(t, 4.0) == []
