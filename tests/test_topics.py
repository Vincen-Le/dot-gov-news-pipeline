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


def test_first_storyline_spawns_theme_with_short_llm_name():
    store = FakeStore()
    sid = add_storyline(store, "FDA recalls Valsatrex lots after contamination review", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(sid)
    assert len(store.themes) == 1
    theme = next(iter(store.themes.values()))
    assert theme["display_name"] == "FDA recalls Valsatrex lots after"  # stub: first 5 words
    assert store.storylines[sid]["theme_id"] == theme["id"]
    assert store.storylines[sid]["theme_attach_method"] == "new_theme"


def test_similar_storyline_joins_nearest_neighbor_theme_without_llm():
    class NoNamerModels(StubModels):
        def name_theme(self, storyline):
            raise AssertionError("knn join must not call the namer")

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "FDA recalls expand to Xarnib", vec(0, 1, 2))
    ThemeEngine(store, NoNamerModels(), CFG).sync(second)
    assert len(store.themes) == 1
    assert store.storylines[second]["theme_id"] == store.storylines[first]["theme_id"]
    assert store.storylines[second]["theme_attach_method"] == "knn_join"
    assert store.storylines[second]["theme_similarity"] is not None
    assert store.storylines[second]["theme_reason"].startswith("knn:")
    theme = next(iter(store.themes.values()))
    assert theme["storyline_count"] == 2


def test_knn_majority_vote_beats_single_nearest():
    store = FakeStore()
    engine = ThemeEngine(store, StubModels(), CFG)
    # theme A: two members on vec(0,1); theme B: one member slightly closer
    a1 = add_storyline(store, "IRS delays filing deadline", vec(0, 1))
    engine.sync(a1)
    a2 = add_storyline(store, "IRS extends deadline again", vec(0, 1))
    engine.sync(a2)  # joins a1's theme via knn
    theme_a = store.storylines[a1]["theme_id"]
    b1 = add_storyline(store, "Treasury sanctions update", vec(0, 1, 2))
    store.storylines[b1]["theme_id"] = None
    # force b1 into its own theme first (orthogonal enough not to matter here)
    b_theme = store.create_theme("Treasury sanctions", pack_fp16(vec(0, 1, 2)), None, None)
    store.assign_theme(b1, b_theme, "new_theme", None, "seed", None, None)
    # new storyline equidistant-ish: 2 A-votes outnumber 1 B-vote
    new = add_storyline(store, "IRS deadline moves once more", vec(0, 1, 2))
    engine.sync(new)
    assert store.storylines[new]["theme_id"] == theme_a


def test_dissimilar_storyline_below_floor_spawns():
    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "SSA closes offices", vec(6, 7))  # orthogonal
    ThemeEngine(store, StubModels(), CFG).sync(second)
    assert len(store.themes) == 2
    assert store.storylines[second]["theme_attach_method"] == "new_theme"


def test_stick_floor_keeps_assignment_without_work():
    class ExplodingModels(StubModels):
        def name_theme(self, storyline):
            raise AssertionError("above stick floor -> no calls at all")

        def classify_category(self, theme_name, storyline, categories):
            raise AssertionError("above stick floor -> no calls at all")

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    # refresh with the same centroid: still fits its own theme
    ThemeEngine(store, ExplodingModels(), CFG).sync(first)
    assert store.storylines[first]["theme_attach_method"] == "new_theme"  # unchanged


def test_drift_below_stick_floor_reassigns_via_knn():
    store = FakeStore()
    engine = ThemeEngine(store, StubModels(), CFG)
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    engine.sync(first)
    other = add_storyline(store, "SSA closes offices statewide", vec(6, 7))
    engine.sync(other)
    # storyline drifts fully onto the SSA vector
    store.storylines[first]["centroid"] = pack_fp16(vec(6, 7))
    store.storylines[first]["headline"] = "SSA closes offices in Tulsa"
    engine.sync(first)
    assert store.storylines[first]["theme_id"] == store.storylines[other]["theme_id"]
    assert store.storylines[first]["theme_attach_method"] == "reassigned"


def test_namer_failure_falls_back_to_headline():
    class FailingNamer(StubModels):
        def name_theme(self, storyline):
            raise RuntimeError("namer boom")

    store = FakeStore()
    sid = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, FailingNamer(), CFG).sync(sid)
    assert len(store.themes) == 1
    theme = next(iter(store.themes.values()))
    assert theme["display_name"] == "FDA recalls Valsatrex"  # headline fallback
    assert "namer_error" in store.storylines[sid]["theme_reason"]


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
