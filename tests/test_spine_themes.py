import numpy as np

from pipeline.config import Config
from pipeline.stub import StubModels
from pipeline.vectors import pack_fp16
from spine.themes import cluster_storylines, reconcile, sweep
from tests.fakes import FakeStore

# storylines.theme_attach_method_valid in
# supabase/migrations/20260719110000_lazy_theme_promotion.sql — the
# DB-legal vocabulary spine's theme sweep must map onto.
THEME_ATTACH_METHODS = {
    "adjudicated_join", "knn_join", "new_theme", "reassigned",
    "criterion_join", "promoted", "sweep_join",
}


def _v(x, y):
    return np.array([x, y], dtype=np.float32)


def test_average_linkage_two_groups():
    vecs = [_v(1, 0), _v(0.99, 0.14), _v(0, 1), _v(0.14, 0.99)]
    clusters = cluster_storylines(vecs, link_sim=0.9)
    assert sorted(sorted(c) for c in clusters) == [[0, 1], [2, 3]]


def test_no_merge_below_threshold():
    clusters = cluster_storylines([_v(1, 0), _v(0, 1)], link_sim=0.9)
    assert sorted(sorted(c) for c in clusters) == [[0], [1]]


def test_reconcile_keeps_id_on_majority_overlap():
    out = reconcile([["a", "b", "c", "d"]], {"t1": {"a", "b", "c"}},
                    keep_overlap=0.5)
    assert out == [("t1", ["a", "b", "c", "d"])]


def test_reconcile_split_keeps_id_on_best_fragment():
    existing = {"t1": {"a", "b", "c", "d", "e", "f"}}
    out = reconcile([["a", "b", "c", "d"], ["e", "f", "g", "h"]],
                    existing, keep_overlap=0.5)
    assert ("t1", ["a", "b", "c", "d"]) in out
    assert (None, ["e", "f", "g", "h"]) in out


def test_reconcile_merge_uses_larger_overlap_once():
    existing = {"t1": {"a", "b"}, "t2": {"c"}}
    out = reconcile([["a", "b", "c"]], existing, keep_overlap=0.5)
    assert out == [("t1", ["a", "b", "c"])]   # t2 unmatched -> demoted by sweep


def test_sweep_creates_theme_of_min_size():
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t",
                 spine_theme_min_size=3)
    store = FakeStore()
    base = _v(1, 0)
    for i in range(3):
        sid = f"s{i}"
        store.storylines[sid] = {
            "id": sid, "centroid": pack_fp16(base), "theme_id": None,
            "headline": f"FTC enforcement action {i}",
        }
    result = sweep(store, StubModels(), cfg)
    assert result["themes_created"] == 1
    assert result["storylines_assigned"] == 3
    for sid in ("s0", "s1", "s2"):
        assert store.storylines[sid]["theme_attach_method"] in THEME_ATTACH_METHODS
