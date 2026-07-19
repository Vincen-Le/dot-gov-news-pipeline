from datetime import datetime, timedelta, timezone

import numpy as np

from pipeline.config import Config
from pipeline.promotion import PromotionSweep
from pipeline.stub import StubModels
from pipeline.topics import ThemeEngine
from pipeline.vectors import pack_fp16
from tests.fakes import FakeStore

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             topics_enabled=True, theme_promotion_min_storylines=3,
             theme_promotion_min_active_days=2,
             theme_promotion_cohesion_floor=0.5,
             theme_promotion_cluster_floor=0.5,
             theme_demotion_cohesion_floor=0.6)


def vec(*hot):
    v = np.zeros(8, dtype=np.float32)
    for i in hot:
        v[i] = 1.0
    return v


def add_storyline(store, headline, v, day=0, category_id="c-health"):
    sid = f"s-{len(store.storylines)}"
    t = T0 + timedelta(days=day)
    store.storylines[sid] = {
        "id": sid, "entity_set": [], "event_keys": [], "episode_count": 1,
        "centroid": pack_fp16(v), "headline": headline, "summary": "",
        "theme_id": None, "category_id": category_id,
        "newest_entry_at": t, "first_entry_at": t,
    }
    return sid


def sweep(store, models=None, cfg=CFG):
    models = models or StubModels()
    return PromotionSweep(store, models, cfg,
                          ThemeEngine(store, models, cfg)).run(
        as_of=T0 + timedelta(days=10))


def test_cluster_crossing_gate_is_promoted_with_criterion():
    store = FakeStore()
    ids = [add_storyline(store, f"measles outbreak update {i}", vec(0, 1), day=i)
           for i in range(3)]
    report = sweep(store)
    assert report["promoted"] == 1
    theme = next(iter(store.themes.values()))
    assert theme["inclusion_criterion"].startswith("stub:")
    assert all(store.storylines[s]["theme_id"] == theme["id"] for s in ids)
    assert store.storylines[ids[0]]["theme_attach_method"] == "promoted"


def test_small_cluster_stays_category_resident():
    store = FakeStore()
    add_storyline(store, "measles outbreak update", vec(0, 1), day=0)
    add_storyline(store, "measles outbreak follow-up", vec(0, 1), day=1)
    report = sweep(store)
    assert report["promoted"] == 0
    assert store.themes == {}


def test_single_day_burst_fails_persistence_gate():
    store = FakeStore()
    for i in range(4):
        add_storyline(store, f"measles outbreak update {i}", vec(0, 1), day=0)
    assert sweep(store)["promoted"] == 0


def test_cluster_matching_existing_theme_attaches_instead_of_duplicating():
    class JudgeOnlyModels(StubModels):
        def adjudicate_membership(self, storyline, candidates):
            return {"theme_id": None, "reason": "defer to promotion judge"}

    store = FakeStore()
    theme_id = store.create_theme(
        "Measles Outbreak Response", pack_fp16(vec(0, 1)), "c-health", None,
        "storylines about the measles outbreak")
    ids = [add_storyline(store, f"measles outbreak update {i}", vec(0, 1), day=i)
           for i in range(3)]
    report = sweep(store, models=JudgeOnlyModels())
    assert report["attached_existing"] == 1
    assert len(store.themes) == 1
    assert all(store.storylines[s]["theme_id"] == theme_id for s in ids)
    assert store.storylines[ids[0]]["theme_attach_method"] == "sweep_join"


def test_judge_failure_promotes_nothing():
    class BrokenJudge(StubModels):
        def judge_promotion(self, dossier):
            raise RuntimeError("judge boom")

    store = FakeStore()
    for i in range(3):
        add_storyline(store, f"measles outbreak update {i}", vec(0, 1), day=i)
    report = sweep(store, models=BrokenJudge())
    assert report["promoted"] == 0
    assert store.themes == {}


def test_low_cohesion_theme_is_demotion_reviewed_and_demoted():
    class AlwaysDemote(StubModels):
        def review_theme(self, dossier):
            return {"verdict": "demote", "reason": "test"}

    store = FakeStore()
    theme_id = store.create_theme("Scattered Grab Bag", pack_fp16(vec(0)),
                                  "c-health", None, "unrelated things")
    a = add_storyline(store, "alpha", vec(0))
    b = add_storyline(store, "omega", vec(7))
    store.assign_theme(a, theme_id, "promoted", None, "seed", None, None)
    store.assign_theme(b, theme_id, "promoted", None, "seed", None, None)
    report = sweep(store, models=AlwaysDemote())
    assert report["demoted"] == 1
    assert store.all_themes() == []
    assert store.storylines[a]["theme_id"] is None


def test_review_failure_never_demotes():
    class BrokenReview(StubModels):
        def review_theme(self, dossier):
            raise RuntimeError("review boom")

    store = FakeStore()
    theme_id = store.create_theme("Scattered Grab Bag", pack_fp16(vec(0)),
                                  "c-health", None, "unrelated things")
    a = add_storyline(store, "alpha", vec(0))
    b = add_storyline(store, "omega", vec(7))
    store.assign_theme(a, theme_id, "promoted", None, "seed", None, None)
    store.assign_theme(b, theme_id, "promoted", None, "seed", None, None)
    assert sweep(store, models=BrokenReview())["demoted"] == 0
    assert len(store.all_themes()) == 1
