"""Global theme sweep: average-linkage clustering + LLM confirm/name +
persistent-ID reconciliation. Batching rejected per design amendment #5 —
global visibility avoids batch-boundary duplicate themes; merge/split are
byproducts of reconciliation, not separate machinery."""

from __future__ import annotations

import numpy as np

from pipeline.simple.theme_clustering.average_linkage import cluster_storylines
from pipeline.simple.theme_clustering.reconciliation import reconcile
from pipeline.shared.vectors import cosine, pack_fp16

# storylines.theme_attach_method_valid (see
# supabase/migrations/20260719110000_lazy_theme_promotion.sql) does not
# include a "spine_sweep" value — the closest legal value for a sweep-time
# assignment is "sweep_join".
_THEME_ATTACH_METHOD = "sweep_join"


def sweep(store, models, cfg) -> dict:
    result = {"themes_created": 0, "themes_kept": 0, "themes_demoted": 0,
              "storylines_assigned": 0}
    rows = store.storylines_for_sweep()
    if len(rows) < cfg.spine_theme_min_size:
        return result
    clusters_idx = cluster_storylines(
        [r["centroid"] for r in rows], cfg.spine_theme_link_sim)
    clusters_idx = [c for c in clusters_idx
                    if len(c) >= cfg.spine_theme_min_size]

    confirmed = []
    protected_theme_ids: set[str] = set()
    for cluster in clusters_idx:
        mean = np.mean([rows[i]["centroid"] for i in cluster], axis=0)
        ranked = sorted(cluster, key=lambda i: (-cosine(rows[i]["centroid"],
                                                        mean), i))
        verdict = models.induce_theme(
            [{"headline": rows[i]["headline"]} for i in ranked[:15]])
        if verdict.get("theme"):
            confirmed.append((cluster, mean, verdict))
        elif (verdict.get("reason") or "").startswith("adjudicator_error"):
            # transient LLM failure, not a real "no theme" verdict: leave
            # the cluster unresolved this sweep, but don't let its silence
            # demote members' existing themes (they'd just churn back next
            # sweep with a new id/label).
            for i in cluster:
                theme_id = rows[i]["theme_id"]
                if theme_id is not None:
                    protected_theme_ids.add(str(theme_id))

    existing: dict[str, set[str]] = {}
    for r in rows:
        if r["theme_id"] is not None:
            existing.setdefault(str(r["theme_id"]), set()).add(str(r["id"]))

    id_clusters = [[str(rows[i]["id"]) for i in cluster]
                   for cluster, _, _ in confirmed]
    matched = reconcile(id_clusters, existing, cfg.spine_theme_keep_overlap)

    kept_ids = set()
    for (theme_id, members), (cluster, mean, verdict) in zip(matched, confirmed):
        if theme_id is None:
            theme_id = store.create_theme(
                verdict.get("name") or "Unnamed theme", pack_fp16(mean),
                None, cfg.judge_model, None)
            result["themes_created"] += 1
        else:
            store.update_theme(theme_id, centroid=pack_fp16(mean))
            result["themes_kept"] += 1
        kept_ids.add(theme_id)
        member_theme = {str(rows[i]["id"]): rows[i]["theme_id"]
                        for i in cluster}
        for i, sid in zip(cluster, members):
            if str(member_theme.get(sid)) != str(theme_id):
                store.assign_theme(
                    sid, theme_id, method=_THEME_ATTACH_METHOD,
                    similarity=cosine(rows[i]["centroid"], mean),
                    reason=(verdict.get("reason") or "")[:512],
                    theme_centroid=None, theme_display_name=None)
                result["storylines_assigned"] += 1

    # human-curated themes sit outside the confirm-or-demote cycle: they can
    # legitimately be smaller than spine_theme_min_size and must not churn
    protected_theme_ids |= {str(t) for t in store.manual_theme_ids()}
    for theme_id in existing:
        if theme_id not in kept_ids and theme_id not in protected_theme_ids:
            store.demote_theme(theme_id)
            result["themes_demoted"] += 1
    return result
