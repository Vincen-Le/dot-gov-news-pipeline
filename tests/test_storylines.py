from datetime import datetime, timezone

import numpy as np

from pipeline.config import Config
from pipeline.storylines import StorylineEngine

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


class StorylineFakeStore:
    """Read-only storyline surface used by StorylineEngine.resolve."""

    def __init__(self, storylines, emas=None, overview=None):
        self._storylines = storylines
        self._emas = emas or {}
        self._overview = overview

    def storylines_by_event_keys(self, keys):
        return [s for s in self._storylines if set(s["event_keys"]) & set(keys)]

    def storylines_by_entities(self, entities):
        return [s for s in self._storylines if set(s["entity_set"]) & set(entities)]

    def entity_emas(self, entities):
        return {e: self._emas.get(e, 0.0) for e in entities}

    def latest_overview(self, storyline_id):
        return self._overview


class SayYes:
    def adjudicate_same_event(self, a, b, context):
        return True, "same chain"


class SayNo:
    def adjudicate_same_event(self, a, b, context):
        return False, "different"


def entry(**kw):
    return {"id": "n1", "title": "Valsatrex recall expands", "summary": "s",
            "entity_set": ["valsatrex", "sundexo"], "event_keys": [],
            "published_at": T0, **kw}


def unit(axis):
    v = np.zeros(8, dtype=np.float32)
    v[axis] = 1.0
    return v


def storyline(**kw):
    return {"id": "s1", "entity_set": ["valsatrex"], "event_keys": [],
            "centroid": unit(0), "episode_count": 2, "newest_entry_at": T0,
            "latest_card_id": "c1", **kw}


def test_event_key_tier_wins_without_llm():
    store = StorylineFakeStore([storyline(event_keys=["z-2026-0143"])])
    engine = StorylineEngine(store, SayNo(), CFG)
    sid, method, _, _, _ = engine.resolve(entry(event_keys=["z-2026-0143"]), unit(3))
    assert sid == "s1" and method == "event_key"


def test_strong_entity_candidate_auto_joins():
    store = StorylineFakeStore([storyline(entity_set=["valsatrex", "sundexo"])])
    engine = StorylineEngine(store, SayNo(), CFG)  # adjudicator must not be consulted
    sid, method, sim, _, _ = engine.resolve(entry(), unit(0))
    assert sid == "s1" and method == "entity_candidate"
    assert sim is not None and sim >= CFG.cluster_join_threshold


def test_weak_candidate_adjudicated_against_overview():
    store = StorylineFakeStore(
        [storyline()],
        overview={"id": "c1", "headline": "Valsatrex recall", "summary": "FDA recall ongoing."},
    )
    mixed = unit(0) * 0.7 + unit(1) * 0.3
    mixed /= np.linalg.norm(mixed)
    sid, method, _, reason, _ = StorylineEngine(store, SayYes(), CFG).resolve(entry(), mixed)
    assert sid == "s1" and method == "adjudicated_join" and reason == "same chain"
    sid, method, _, _, _ = StorylineEngine(store, SayNo(), CFG).resolve(entry(), mixed)
    assert sid is None and method == "new_storyline"


def test_ambient_entities_downweighted():
    # 'washington' is ambient (high EMA); the storyline sharing only it must rank
    # below the one sharing the rare entity.
    rare = storyline(id="rare", entity_set=["valsatrex"])
    ambient = storyline(id="ambient", entity_set=["washington"], centroid=unit(0))
    store = StorylineFakeStore([ambient, rare], emas={"washington": 50.0, "valsatrex": 0.2})
    engine = StorylineEngine(store, SayNo(), CFG)
    e = entry(entity_set=["valsatrex", "washington", "sundexo"])
    ranked = engine._rank_candidates(e, [ambient, rare])
    assert ranked[0]["id"] == "rare"


def test_no_candidates_new_storyline():
    engine = StorylineEngine(StorylineFakeStore([]), SayNo(), CFG)
    sid, method, _, _, _ = engine.resolve(entry(), unit(0))
    assert sid is None and method == "new_storyline"


def test_strong_join_requires_rare_shared_entities():
    # two shared entities, both ambient -> no deterministic entity_candidate join
    ambient_story = storyline(entity_set=["washington", "announces-x"])
    store = StorylineFakeStore(
        [ambient_story],
        emas={"washington": 50.0, "announces-x": 40.0},
    )
    engine = StorylineEngine(store, SayNo(), CFG)
    e = entry(entity_set=["washington", "announces-x", "kestrel"])
    sid, method, _, _, _ = engine.resolve(e, unit(0))
    assert method != "entity_candidate"
    assert sid is None and method == "new_storyline"


def test_rank_candidates_ties_keep_input_order_not_id_order():
    # Storyline ids regenerate every run (gen_random_uuid), so an id tie-break
    # makes candidate order — and therefore attach decisions — vary across
    # otherwise identical replays. Ties must preserve the store's stable,
    # content-ordered input instead.
    first = storyline(id="zzz-first", entity_set=["valsatrex"])
    second = storyline(id="aaa-second", entity_set=["valsatrex"])
    engine = StorylineEngine(StorylineFakeStore([first, second]), SayNo(), CFG)
    ranked = engine._rank_candidates(entry(), [first, second])
    assert [c["id"] for c in ranked] == ["zzz-first", "aaa-second"]
