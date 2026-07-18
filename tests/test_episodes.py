from datetime import datetime, timedelta, timezone

import numpy as np

from pipeline.config import Config
from pipeline.episodes import EpisodeEngine
from tests.fakes import FakeStore

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


def new_storyline_resolver(entry, vec):
    return None, "new_storyline", None, None, None


class SayNoModels:
    def adjudicate_same_event(self, a, b, context):
        return False, "no"


class SayYesModels:
    def adjudicate_same_event(self, a, b, context):
        return True, "yes"


def make_engine(store, models=None):
    return EpisodeEngine(store, models or SayNoModels(), CFG, new_storyline_resolver)


def vec(seed_axis: int) -> np.ndarray:
    v = np.zeros(8, dtype=np.float32)
    v[seed_axis] = 1.0
    return v


def test_first_entry_creates_episode_and_storyline():
    store = FakeStore()
    engine = make_engine(store)
    e = store.add_entry(title="FDA recalls Valsatrex", content_hash="h1",
                        published_at=T0, entity_set=["valsatrex"], event_keys=[])
    decision = engine.process_entry(e, vec(0))
    assert decision["method"] == "new_cluster"
    assert len(store.episodes) == 1 and len(store.storylines) == 1


def test_content_hash_dup_folds_as_syndicated():
    store = FakeStore()
    engine = make_engine(store)
    a = store.add_entry(title="t", content_hash="same", published_at=T0,
                        entity_set=["valsatrex"], event_keys=[])
    engine.process_entry(a, vec(0))
    b = store.add_entry(title="t copy", content_hash="same",
                        published_at=T0 + timedelta(hours=1),
                        entity_set=["valsatrex"], event_keys=[])
    decision = engine.process_entry(b, vec(0))
    assert decision["method"] == "content_hash"
    assert decision["is_syndicated"] is True
    assert len(store.episodes) == 1


def test_near_dup_folds():
    store = FakeStore()
    engine = make_engine(store)
    # vec= stores the embedding on the entry (the runner's update_entry_features
    # does this in production), so recent_embedded() can serve the near-dup tier
    a = store.add_entry(title="t", content_hash="h1", published_at=T0,
                        entity_set=["valsatrex"], event_keys=[], vec=vec(0))
    engine.process_entry(a, vec(0))
    b = store.add_entry(title="t2", content_hash="h2",
                        published_at=T0 + timedelta(hours=2),
                        entity_set=["valsatrex"], event_keys=[])
    decision = engine.process_entry(b, vec(0))  # identical vector -> cosine 1.0
    assert decision["method"] == "near_dup"
    assert len(store.episodes) == 1


def test_event_key_joins_open_episode():
    store = FakeStore()
    engine = make_engine(store)
    a = store.add_entry(title="EPA docket opens", content_hash="h1", published_at=T0,
                        entity_set=[], event_keys=["epa-hq-2026-0001"])
    engine.process_entry(a, vec(1))
    b = store.add_entry(title="Comment period", content_hash="h2",
                        published_at=T0 + timedelta(hours=3),
                        entity_set=[], event_keys=["epa-hq-2026-0001"])
    decision = engine.process_entry(b, vec(2))  # dissimilar vector; key still wins
    assert decision["method"] == "event_key"
    assert len(store.episodes) == 1


def test_template_twin_splits_via_entity_gate_and_adjudicator():
    store = FakeStore()
    engine = make_engine(store, SayNoModels())
    a = store.add_entry(title="FDA recalls Valsatrex", content_hash="h1", published_at=T0,
                        entity_set=["valsatrex"], event_keys=[])
    engine.process_entry(a, vec(0))
    twin_vec = vec(0) * 0.9 + vec(1) * 0.1  # above join threshold, below near-dup
    twin_vec /= np.linalg.norm(twin_vec)
    b = store.add_entry(title="FDA recalls Oxprenol", content_hash="h2",
                        published_at=T0 + timedelta(hours=1),
                        entity_set=["oxprenol"], event_keys=[])
    decision = engine.process_entry(b, twin_vec)
    assert decision["method"] == "adjudicated_new"
    assert len(store.episodes) == 2


def test_entity_overlap_auto_joins_without_adjudicator():
    store = FakeStore()
    engine = make_engine(store, SayNoModels())  # adjudicator would say no; must not be asked
    a = store.add_entry(title="FDA recalls Valsatrex", content_hash="h1", published_at=T0,
                        entity_set=["valsatrex"], event_keys=[])
    engine.process_entry(a, vec(0))
    joiner = vec(0) * 0.9 + vec(1) * 0.1
    joiner /= np.linalg.norm(joiner)
    b = store.add_entry(title="Valsatrex recall expands", content_hash="h2",
                        published_at=T0 + timedelta(hours=1),
                        entity_set=["valsatrex", "sundexo"], event_keys=[])
    decision = engine.process_entry(b, joiner)
    assert decision["method"] == "centroid_join"
    assert len(store.episodes) == 1


def test_dormancy_close_in_event_time():
    store = FakeStore()
    engine = make_engine(store)
    a = store.add_entry(title="t", content_hash="h1", published_at=T0,
                        entity_set=["valsatrex"], event_keys=[])
    engine.process_entry(a, vec(0))
    assert engine.close_due(T0 + timedelta(hours=3)) == []
    closed = engine.close_due(T0 + timedelta(hours=5))
    assert len(closed) == 1
    assert store.episodes[closed[0]["id"]]["status"] == "dormant"
