import numpy as np

from pipeline.config import Config
from pipeline.stub import StubModels
from pipeline.topics import ThemeEngine
from pipeline.vectors import pack_fp16
from tests.fakes import FakeStore

CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             topics_enabled=True)


def vec(*hot):
    v = np.zeros(8, dtype=np.float32)
    for i in hot:
        v[i] = 1.0
    return v


def add_storyline(store, headline, v, theme_id=None):
    sid = f"s-{len(store.storylines)}"
    store.storylines[sid] = {
        "id": sid, "entity_set": [], "event_keys": [], "episode_count": 1,
        "centroid": pack_fp16(v), "headline": headline, "summary": "",
        "theme_id": theme_id, "newest_entry_at": None,
    }
    return sid


def test_first_storyline_spawns_theme_named_from_headline():
    store = FakeStore()
    sid = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(sid)
    assert len(store.themes) == 1
    theme = next(iter(store.themes.values()))
    assert theme["display_name"] == "FDA recalls Valsatrex"
    assert store.storylines[sid]["theme_id"] == theme["id"]
    assert store.storylines[sid]["theme_attach_method"] == "new_theme"


def test_similar_storyline_joins_via_adjudicator():
    store = FakeStore()
    engine = ThemeEngine(store, StubModels(), CFG)
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    engine.sync(first)
    second = add_storyline(store, "FDA recalls expand to Xarnib", vec(0, 1, 2))
    engine.sync(second)
    assert len(store.themes) == 1  # stub joins on shared "recalls" token
    assert store.storylines[second]["theme_attach_method"] == "adjudicated_join"
    assert store.storylines[second]["theme_similarity"] is not None
    theme = next(iter(store.themes.values()))
    assert theme["storyline_count"] == 2


def test_dissimilar_storyline_below_floor_spawns_without_llm():
    class ExplodingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            raise AssertionError("no candidates above floor -> no LLM call")

    store = FakeStore()
    engine = ThemeEngine(store, ExplodingModels(), CFG)
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "SSA closes offices", vec(6, 7))  # orthogonal
    engine.sync(second)
    assert len(store.themes) == 2


def test_adjudicator_no_join_spawns_with_proposed_name():
    store = FakeStore()
    engine = ThemeEngine(store, StubModels(), CFG)
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    engine.sync(first)
    # similar vector (above floor) but disjoint tokens -> stub says no join
    second = add_storyline(store, "USDA beef contamination alert", vec(0, 1))
    engine.sync(second)
    assert len(store.themes) == 2
    names = {t["display_name"] for t in store.themes.values()}
    assert "USDA beef contamination alert" in names


def test_stick_floor_keeps_assignment_without_llm():
    class ExplodingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            raise AssertionError("above stick floor -> no re-adjudication")

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    # refresh with the same centroid: still fits its own theme
    ThemeEngine(store, ExplodingModels(), CFG).sync(first)
    assert store.storylines[first]["theme_attach_method"] == "new_theme"  # unchanged


def test_drift_below_stick_floor_reassigns():
    store = FakeStore()
    engine = ThemeEngine(store, StubModels(), CFG)
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    engine.sync(first)
    other = add_storyline(store, "SSA closes offices statewide", vec(6, 7))
    engine.sync(other)
    # storyline drifts fully onto the SSA vector and headline
    store.storylines[first]["centroid"] = pack_fp16(vec(6, 7))
    store.storylines[first]["headline"] = "SSA closes offices in Tulsa"
    engine.sync(first)
    assert store.storylines[first]["theme_id"] == store.storylines[other]["theme_id"]
    assert store.storylines[first]["theme_attach_method"] == "reassigned"


def test_adjudicator_failure_falls_back_to_spawn():
    class FailingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            return {"theme_id": None, "updated_name": None,
                    "reason": "adjudicator_error: boom"}

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "FDA recalls expand again", vec(0, 1))
    ThemeEngine(store, FailingModels(), CFG).sync(second)
    assert store.storylines[second]["theme_id"] is not None
    assert len(store.themes) == 2  # fallback spawned rather than joined
    assert store.storylines[second]["theme_reason"].startswith("adjudicator_error")


def test_new_theme_gets_category_seed_match_or_llm_proposal():
    store = FakeStore()
    store.categories["c-1"] = {"id": "c-1", "display_name": "Drug Safety",
                               "origin": "seed"}
    engine = ThemeEngine(store, StubModels(), CFG)
    drug = add_storyline(store, "FDA recalls Valsatrex drug", vec(0, 1))
    engine.sync(drug)
    theme = next(iter(store.themes.values()))
    assert theme["category_id"] == "c-1"
    ssa = add_storyline(store, "SSA closes offices", vec(6, 7))
    engine.sync(ssa)
    proposed = [c for c in store.categories.values() if c["origin"] == "llm"]
    assert [c["display_name"] for c in proposed] == ["General Government"]


def test_invalid_theme_id_from_llm_treated_as_spawn():
    class LyingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            return {"theme_id": "not-a-real-theme", "updated_name": None,
                    "reason": "hallucinated"}

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "FDA recalls expand", vec(0, 1))
    ThemeEngine(store, LyingModels(), CFG).sync(second)
    assert len(store.themes) == 2
    assert store.storylines[second]["theme_id"] != "not-a-real-theme"
