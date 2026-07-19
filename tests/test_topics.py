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


def test_similar_storyline_joins_via_adjudicator():
    class NoNamerModels(StubModels):
        def name_theme(self, storyline):
            raise AssertionError("join must not call the namer")

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "FDA recalls expand to Xarnib", vec(0, 1, 2))
    ThemeEngine(store, NoNamerModels(), CFG).sync(second)
    assert len(store.themes) == 1
    assert store.storylines[second]["theme_id"] == store.storylines[first]["theme_id"]
    assert store.storylines[second]["theme_attach_method"] == "adjudicated_join"
    assert store.storylines[second]["theme_similarity"] is not None
    assert store.storylines[second]["theme_reason"] == "stub: nearest candidate theme"
    theme = next(iter(store.themes.values()))
    assert theme["storyline_count"] == 2


def test_adjudicator_failure_falls_back_to_knn_majority_vote():
    class BrokenAdjudicator(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            raise RuntimeError("adjudicator boom")

    store = FakeStore()
    seed_engine = ThemeEngine(store, StubModels(), CFG)
    a1 = add_storyline(store, "IRS delays filing deadline", vec(0, 1))
    seed_engine.sync(a1)
    a2 = add_storyline(store, "IRS extends deadline again", vec(0, 1))
    seed_engine.sync(a2)
    theme_a = store.storylines[a1]["theme_id"]
    b1 = add_storyline(store, "Treasury sanctions update", vec(0, 1, 2))
    b_theme = store.create_theme("Treasury sanctions", pack_fp16(vec(0, 1, 2)), None, None)
    store.assign_theme(b1, b_theme, "new_theme", None, "seed", None, None)

    new = add_storyline(store, "IRS deadline moves once more", vec(0, 1, 2))
    ThemeEngine(store, BrokenAdjudicator(), CFG).sync(new)
    # 2 A-votes beat 1 B-vote in the storyline-knn fallback
    assert store.storylines[new]["theme_id"] == theme_a
    assert store.storylines[new]["theme_attach_method"] == "knn_join"
    assert "adjudicator_error" in store.storylines[new]["theme_reason"]


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


def test_drift_below_stick_floor_reassigns_via_adjudicator():
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


def test_hallucinated_theme_id_treated_as_spawn():
    class HallucinatingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            return {"decision": "join", "theme_id": "not-a-real-theme",
                    "new_theme_name": None, "merge_theme_ids": [],
                    "reason": "made it up"}

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "FDA recalls expand", vec(0, 1, 2))
    ThemeEngine(store, HallucinatingModels(), CFG).sync(second)
    assert len(store.themes) == 2
    assert store.storylines[second]["theme_attach_method"] == "new_theme"


def test_adjudicator_spawn_uses_provided_name_without_namer_call():
    class SpawningModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            return {"decision": "spawn", "theme_id": None,
                    "new_theme_name": "Harvard exchange program",
                    "merge_theme_ids": [],
                    "reason": "different subject than candidates"}

        def name_theme(self, storyline):
            raise AssertionError("adjudicator provided the name")

    store = FakeStore()
    first = add_storyline(store, "Visa restrictions on Brazilian officials", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "Harvard exchange investigation", vec(0, 1, 2))
    ThemeEngine(store, SpawningModels(), CFG).sync(second)
    assert len(store.themes) == 2
    names = {t["display_name"] for t in store.themes.values()}
    assert "Harvard exchange program" in names
    assert store.storylines[second]["theme_attach_method"] == "new_theme"
    assert store.storylines[second]["theme_reason"] == "different subject than candidates"


def make_merging_models(merge_ids, join_id):
    class MergingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            return {"decision": "join", "theme_id": join_id,
                    "new_theme_name": None, "merge_theme_ids": merge_ids,
                    "reason": "same subject; candidates duplicate"}
    return MergingModels()


def seed_two_close_themes(store):
    """Two themes on nearby vectors, theme A with 2 members, theme B with 1."""
    engine = ThemeEngine(store, StubModels(), CFG)
    a1 = add_storyline(store, "Houthi petroleum sanctions", vec(0, 1))
    engine.sync(a1)
    a2 = add_storyline(store, "Houthi network sanctions expand", vec(0, 1))
    engine.sync(a2)
    theme_a = store.storylines[a1]["theme_id"]
    b1 = add_storyline(store, "Treasury sanctions Houthi smugglers", vec(0, 1, 2))
    theme_b = store.create_theme("Houthi smuggling", pack_fp16(vec(0, 1, 2)), None, None)
    store.assign_theme(b1, theme_b, "new_theme", None, "seed", None, None)
    return theme_a, theme_b


def test_merge_directive_tombstones_loser_and_join_lands_on_survivor():
    store = FakeStore()
    theme_a, theme_b = seed_two_close_themes(store)
    new = add_storyline(store, "New Houthi sanctions action", vec(0, 1, 2))
    models = make_merging_models([theme_a, theme_b], join_id=theme_b)
    ThemeEngine(store, models, CFG).sync(new)
    # winner by storyline_count is theme_a; join into loser theme_b redirects
    assert store.themes[theme_b]["merged_into"] == theme_a
    assert store.themes[theme_b]["storyline_count"] == 0
    assert store.storylines[new]["theme_id"] == theme_a
    assert all(s.get("theme_id") != theme_b for s in store.storylines.values())
    assert store.themes[theme_a]["centroid"] is not None
    # merged theme is gone from the candidate surface
    assert all(t["id"] != theme_b for t in store.all_themes())


def test_merge_with_fewer_than_two_valid_ids_is_ignored():
    store = FakeStore()
    theme_a, theme_b = seed_two_close_themes(store)
    new = add_storyline(store, "New Houthi sanctions action", vec(0, 1, 2))
    models = make_merging_models([theme_a, "hallucinated-id"], join_id=theme_a)
    ThemeEngine(store, models, CFG).sync(new)
    assert store.themes[theme_b].get("merged_into") is None
    assert store.storylines[new]["theme_id"] == theme_a
