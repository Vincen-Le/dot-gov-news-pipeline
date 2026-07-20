import numpy as np
import pytest

from pipeline.shared.config import Config
from pipeline.shared.stub import StubModels
from pipeline.shared.vectors import pack_fp16
from pipeline.simple.themes import cluster_storylines, reconcile, sweep
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


# Regression: a --stub run over a db with real embeddings can leave
# storylines.centroid at mixed dimensions (see test_cards.py's mixed-dim
# guard). Without a guard, np's pairwise cosine crashes with an opaque
# "shapes (256,) and (1024,) not aligned" three files removed from the
# actual cause. cluster_storylines must instead raise a clear, actionable
# error naming the mismatched dims.
def test_cluster_storylines_raises_clear_error_on_mixed_dimensions():
    vecs = [np.zeros(256, dtype=np.float32), np.zeros(1024, dtype=np.float32)]
    with pytest.raises(ValueError, match=r"256.*1024|1024.*256"):
        cluster_storylines(vecs, link_sim=0.9)


def test_sweep_raises_clear_error_on_mixed_dimension_centroids():
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t",
                 spine_theme_min_size=3)
    store = FakeStore()
    base = _v(1, 0)
    for i in range(2):
        sid = f"s{i}"
        store.storylines[sid] = {
            "id": sid, "centroid": pack_fp16(base), "theme_id": None,
            "headline": f"FTC enforcement action {i}",
        }
    # third storyline's centroid was overwritten by a mismatched-dim
    # overview embedding (the bug this guard prevents at the write site)
    store.storylines["s2"] = {
        "id": "s2", "centroid": pack_fp16(np.zeros(4, dtype=np.float32)),
        "theme_id": None, "headline": "FTC enforcement action 2",
    }
    with pytest.raises(ValueError, match="mixed embedding dimensions"):
        sweep(store, StubModels(), cfg)


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


class _ErrorModel(StubModels):
    """induce_theme always fails transiently — exercises the sweep-demotes-
    healthy-themes-on-LLM-error fix: an adjudicator_error verdict must not
    demote the cluster's existing theme, since that would just churn the
    theme (recreate under a new id/label) next sweep."""

    def induce_theme(self, members):
        return {"theme": False, "name": "", "reason": "adjudicator_error: boom"}


def test_sweep_protects_existing_theme_on_transient_llm_error():
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t",
                 spine_theme_min_size=3)
    store = FakeStore()
    base = _v(1, 0)
    theme_id = store.create_theme(
        "FTC Enforcement", pack_fp16(base), None, "m", None)
    for i in range(3):
        sid = f"s{i}"
        store.storylines[sid] = {
            "id": sid, "centroid": pack_fp16(base), "theme_id": theme_id,
            "headline": f"FTC enforcement action {i}",
        }
    result = sweep(store, _ErrorModel(), cfg)
    assert result["themes_created"] == 0
    assert result["themes_demoted"] == 0
    assert store.themes[theme_id]["demoted_at"] is None
    for sid in ("s0", "s1", "s2"):
        assert store.storylines[sid]["theme_id"] == theme_id


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


def test_sweep_never_demotes_manual_theme():
    """Human-curated themes (name_model='golden-human') sit outside the
    sweep's confirm-or-demote cycle: a 2-member manual theme below
    spine_theme_min_size must survive the sweep with members intact."""
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t",
                 spine_theme_min_size=3)
    store = FakeStore()
    manual_vec, other_vec = _v(0, 1), _v(1, 0)
    manual_id = store.create_theme(
        "VA Weekly Research Briefs", pack_fp16(manual_vec), None,
        "golden-human", None)
    for i in range(2):
        sid = f"m{i}"
        store.storylines[sid] = {
            "id": sid, "centroid": pack_fp16(manual_vec),
            "theme_id": manual_id, "headline": f"VA research wrap up {i}",
        }
    for i in range(3):
        sid = f"s{i}"
        store.storylines[sid] = {
            "id": sid, "centroid": pack_fp16(other_vec), "theme_id": None,
            "headline": f"FTC enforcement action {i}",
        }
    result = sweep(store, StubModels(), cfg)
    assert result["themes_created"] == 1          # the FTC cluster
    assert result["themes_demoted"] == 0
    assert store.themes[manual_id]["demoted_at"] is None
    for sid in ("m0", "m1"):
        assert store.storylines[sid]["theme_id"] == manual_id
