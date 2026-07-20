from datetime import datetime, timezone

import numpy as np

from pipeline.shared.config import Config
from pipeline.shared.stub import StubModels
from pipeline.complex.topics import ThemeEngine, valid_theme_name
from pipeline.shared.vectors import pack_fp16
from tests.fakes import FakeStore

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             topics_enabled=True)


def vec(*hot):
    v = np.zeros(8, dtype=np.float32)
    for i in hot:
        v[i] = 1.0
    return v


def add_storyline(store, headline, v, theme_id=None, category_id="c-any"):
    sid = f"s-{len(store.storylines)}"
    store.storylines[sid] = {
        "id": sid, "entity_set": [], "event_keys": [], "episode_count": 1,
        "centroid": pack_fp16(v), "headline": headline, "summary": "",
        "theme_id": theme_id, "category_id": category_id,
        "newest_entry_at": T0, "first_entry_at": T0,
    }
    return sid


def add_theme(store, name, v, criterion):
    return store.create_theme(name, pack_fp16(v), "c-any", None, criterion)


def test_no_theme_above_floor_leaves_storyline_category_only():
    store = FakeStore()
    sid = add_storyline(store, "FDA recalls Valsatrex lots", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] is None
    assert store.themes == {}


def test_storyline_joins_theme_whose_criterion_it_satisfies():
    store = FakeStore()
    theme_id = add_theme(store, "Drug Recall Enforcement", vec(0, 1),
                         "recalls of specific drugs after FDA safety reviews")
    sid = add_storyline(store, "FDA recalls Valsatrex lots", vec(0, 1, 2))
    ThemeEngine(store, StubModels(), CFG).sync(sid)
    s = store.storylines[sid]
    assert s["theme_id"] == theme_id
    assert s["theme_attach_method"] == "criterion_join"
    assert s["theme_similarity"] is not None
    assert store.themes[theme_id]["storyline_count"] == 1


def test_attach_is_cross_category():
    store = FakeStore()
    theme_id = store.create_theme(
        "Drug Recall Enforcement", pack_fp16(vec(0, 1)), "c-health", None,
        "recalls of specific drugs after FDA safety reviews")
    sid = add_storyline(store, "FDA recalls Valsatrex lots", vec(0, 1, 2),
                        category_id="c-justice")
    ThemeEngine(store, StubModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] == theme_id


def test_attached_storyline_is_sticky():
    class ExplodingModels(StubModels):
        def adjudicate_membership(self, storyline, candidates):
            raise AssertionError("attached storylines must not re-adjudicate")

    store = FakeStore()
    theme_id = add_theme(store, "Drug Recall Enforcement", vec(0, 1),
                         "recalls of specific drugs")
    sid = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1),
                        theme_id=theme_id)
    ThemeEngine(store, ExplodingModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] == theme_id


def test_adjudicator_failure_attaches_nothing():
    class BrokenModels(StubModels):
        def adjudicate_membership(self, storyline, candidates):
            raise RuntimeError("membership boom")

    store = FakeStore()
    add_theme(store, "Drug Recall Enforcement", vec(0, 1),
              "recalls of specific drugs")
    sid = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1, 2))
    ThemeEngine(store, BrokenModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] is None


def test_hallucinated_theme_id_attaches_nothing():
    class HallucinatingModels(StubModels):
        def adjudicate_membership(self, storyline, candidates):
            return {"theme_id": "t-invented", "reason": "made up"}

    store = FakeStore()
    add_theme(store, "Drug Recall Enforcement", vec(0, 1),
              "recalls of specific drugs")
    sid = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1, 2))
    ThemeEngine(store, HallucinatingModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] is None


def test_none_verdict_leaves_storyline_unattached():
    class NoneModels(StubModels):
        def adjudicate_membership(self, storyline, candidates):
            return {"theme_id": None, "reason": "does not satisfy criterion"}

    store = FakeStore()
    add_theme(store, "Drug Recall Enforcement", vec(0, 1),
              "recalls of specific drugs")
    sid = add_storyline(store, "IRS deadline moves", vec(0, 1))
    ThemeEngine(store, NoneModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] is None


def test_valid_theme_name_rules():
    assert valid_theme_name("Drug Recall Enforcement")
    assert not valid_theme_name("One")
    assert not valid_theme_name("way too many words in this label")
