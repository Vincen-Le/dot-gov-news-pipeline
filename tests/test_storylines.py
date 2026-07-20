from datetime import datetime, timezone

import numpy as np

from pipeline.shared.config import Config
from pipeline.complex.storylines import StorylineEngine

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


class StorylineFakeStore:
    """Read-only storyline surface used by StorylineEngine.resolve."""

    def __init__(self, storylines, emas=None, overview=None, latest_member=None):
        self._storylines = storylines
        self._emas = emas or {}
        self._overview = overview
        self._latest_member = latest_member

    def storylines_by_event_keys(self, keys):
        return [s for s in self._storylines if set(s["event_keys"]) & set(keys)]

    def storylines_by_entities(self, entities):
        return [s for s in self._storylines if set(s["entity_set"]) & set(entities)]

    def entity_emas(self, entities):
        return {e: self._emas.get(e, 0.0) for e in entities}

    def latest_overview(self, storyline_id):
        return self._overview

    def latest_storyline_entry(self, storyline_id):
        return self._latest_member


class SayYes:
    def adjudicate_same_event(self, a, b, context):
        return True, "same chain"


class SayNo:
    def adjudicate_same_event(self, a, b, context):
        return False, "different"


class RecordingNo:
    def __init__(self):
        self.calls = []

    def adjudicate_same_event(self, a, b, context):
        self.calls.append((a, b, context))
        return False, "different concrete events"


class JoinValsatrexCandidate:
    def __init__(self):
        self.calls = 0

    def adjudicate_same_event(self, a, b, context):
        self.calls += 1
        same = "valsatrex" in b["entities"]
        return same, "matching recall chain" if same else "different chain"


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


def test_event_key_match_is_only_a_candidate_and_judge_can_reject_it():
    store = StorylineFakeStore([storyline(event_keys=["z-2026-0143"])])
    engine = StorylineEngine(store, SayNo(), CFG)
    sid, method, sim, _, _ = engine.resolve(entry(event_keys=["z-2026-0143"]), unit(0))
    assert sid is None and method == "new_storyline" and sim is None


def test_event_key_match_joins_only_after_judge_approval():
    store = StorylineFakeStore(
        [storyline(event_keys=["z-2026-0143"])],
        overview={"headline": "Valsatrex recall", "summary": "FDA recall ongoing."},
    )
    sid, method, sim, reason, model = StorylineEngine(
        store, SayYes(), CFG).resolve(entry(event_keys=["z-2026-0143"]), unit(0))
    assert sid == "s1" and method == "adjudicated_join"
    assert sim is not None and sim > 0.9
    assert reason == "same chain" and model == CFG.adjudicator_model


def test_event_key_join_requires_centroid_sanity_when_centroid_exists():
    """Regression: storyline aeded190 — colliding boilerplate key 'no. 23-01'
    glued Employment Cost Index (cosine 0.578) onto State Employment."""
    store = StorylineFakeStore([storyline(event_keys=["no. 23-01"],
                                          entity_set=["metropolitan"])])
    engine = StorylineEngine(store, SayNo(), CFG)
    e = entry(event_keys=["no. 23-01"], entity_set=["cost", "index"])
    sid, method, _, _, _ = engine.resolve(e, unit(3))  # orthogonal content
    assert method == "new_storyline" and sid is None


def test_event_key_candidate_without_centroid_still_requires_judge():
    store = StorylineFakeStore([storyline(event_keys=["ir-2025-106"], centroid=None)])
    engine = StorylineEngine(store, SayNo(), CFG)
    sid, method, sim, _, _ = engine.resolve(entry(event_keys=["ir-2025-106"]), unit(3))
    assert (sid, method, sim) == (None, "new_storyline", None)


def test_strong_entity_candidate_cannot_bypass_judge():
    store = StorylineFakeStore([storyline(entity_set=["valsatrex", "sundexo"])])
    engine = StorylineEngine(store, SayNo(), CFG)
    sid, method, sim, _, _ = engine.resolve(entry(), unit(0))
    assert sid is None and method == "new_storyline" and sim is None


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


def test_cardless_candidate_is_judged_against_latest_real_entry_not_placeholder():
    models = RecordingNo()
    store = StorylineFakeStore(
        [storyline(entity_set=["america", "weekend"], latest_card_id=None)],
        latest_member={
            "title": "Holiday cookout food-safety guidance",
            "summary": "USDA explains safe food handling for Independence Day.",
        },
    )
    candidate = entry(
        title="Plan a visit to Zion over Independence Day weekend",
        summary="NPS warns about heat, crowds, and fire restrictions.",
        entity_set=["america", "weekend", "zion"],
    )
    sid, method, _, _, _ = StorylineEngine(store, models, CFG).resolve(
        candidate, unit(0))
    assert sid is None and method == "new_storyline"
    judged_candidate = models.calls[0][1]
    assert judged_candidate["title"] == "Holiday cookout food-safety guidance"
    assert "food handling" in judged_candidate["summary"]
    assert judged_candidate["title"] != "(storyline)"


def test_similarity_floor_only_ranks_candidates_and_does_not_veto_judge():
    store = StorylineFakeStore(
        [storyline()],
        overview={"headline": "Valsatrex recall", "summary": "FDA recall ongoing."},
    )
    sid, method, sim, _, _ = StorylineEngine(
        store, SayYes(), CFG).resolve(entry(), unit(3))
    assert sid == "s1" and method == "adjudicated_join"
    assert sim == 0.0


def test_event_and_entity_signals_form_one_deduplicated_candidate_pool():
    candidate = storyline(event_keys=["z-2026-0143"],
                          entity_set=["valsatrex", "sundexo"])
    models = JoinValsatrexCandidate()
    sid, method, _, _, _ = StorylineEngine(
        StorylineFakeStore([candidate]), models, CFG,
    ).resolve(entry(event_keys=["z-2026-0143"]), unit(0))
    assert sid == "s1" and method == "adjudicated_join"
    assert models.calls == 1


def test_judge_can_reject_event_key_candidate_then_accept_entity_candidate():
    event_match = storyline(id="event", event_keys=["z-2026-0143"],
                            entity_set=["unrelated"])
    entity_match = storyline(id="entity", entity_set=["valsatrex"])
    models = JoinValsatrexCandidate()
    sid, method, _, _, _ = StorylineEngine(
        StorylineFakeStore([event_match, entity_match]), models, CFG,
    ).resolve(entry(event_keys=["z-2026-0143"]), unit(0))
    assert sid == "entity" and method == "adjudicated_join"
    assert models.calls == 2


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
