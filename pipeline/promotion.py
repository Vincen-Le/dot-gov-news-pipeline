"""Stage 5 — theme promotion sweep.

Themes are born here, never on the stream. Cadence: the runner calls run()
every theme_sweep_interval_hours of event time and once at end of run.
Order per sweep: (1) mop-up — category-resident storylines get one more
criterion-membership pass against existing themes; (2) greedy within-category
clustering of what remains; (3) three-axis gate (size, persistence, cohesion)
filters clusters; (4) the promotion judge names the theme and writes its
inclusion criterion, or routes the cluster onto an existing theme instead of
minting a duplicate; (5) naive demotion review — themes whose member cohesion
collapsed get an LLM keep/demote verdict. Failure bias: judge or review
failure changes nothing.
"""

from __future__ import annotations

from datetime import datetime

import numpy as np

from pipeline.config import Config
from pipeline.topics import ThemeEngine, valid_theme_name
from pipeline.vectors import cosine, pack_fp16

_MAX_NAME = 256
_MAX_CRITERION = 1024
_EXISTING_THEME_CANDIDATES = 3
_DOSSIER_MEMBER_CAP = 12


class PromotionSweep:
    def __init__(self, store, models, cfg: Config,
                 theme_engine: ThemeEngine) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg
        self.theme_engine = theme_engine

    def run(self, as_of: datetime) -> dict:
        counts = {"mopped_up": 0, "promoted": 0, "attached_existing": 0,
                  "rejected": 0, "demoted": 0}
        self._mop_up(counts)
        residents = self.store.categorized_unthemed()
        by_category: dict[str, list[dict]] = {}
        for row in residents:
            by_category.setdefault(row["category_id"], []).append(row)
        for category_id, rows in by_category.items():
            others = [r for r in residents if r["category_id"] != category_id]
            for cluster in self._clusters(rows):
                cohesion = self._gate(cluster)
                if cohesion is None:
                    continue
                self._judge(cluster, cohesion, category_id, others, as_of,
                            counts)
        self._review_themes(counts)
        return counts

    def _mop_up(self, counts: dict) -> None:
        for row in self.store.categorized_unthemed():
            self.theme_engine.sync(row["id"])
            state = self.store.storyline_theme_state(row["id"])
            if state is not None and state["theme_id"] is not None:
                counts["mopped_up"] += 1

    def _clusters(self, rows: list[dict]) -> list[dict]:
        clusters: list[dict] = []
        for row in rows:
            best, best_sim = None, -1.0
            for cluster in clusters:
                sim = cosine(row["centroid"], cluster["centroid"])
                if sim > best_sim:
                    best, best_sim = cluster, sim
            if (best is not None
                    and best_sim >= self.cfg.theme_promotion_cluster_floor):
                best["members"].append(row)
                best["centroid"] = np.mean(
                    [m["centroid"] for m in best["members"]], axis=0)
            else:
                clusters.append({"members": [row],
                                 "centroid": row["centroid"]})
        return clusters

    def _gate(self, cluster: dict) -> float | None:
        members = cluster["members"]
        if len(members) < self.cfg.theme_promotion_min_storylines:
            return None
        days = {m["first_entry_at"].date() for m in members
                if m["first_entry_at"] is not None}
        if len(days) < self.cfg.theme_promotion_min_active_days:
            return None
        cohesion = float(np.mean(
            [cosine(m["centroid"], cluster["centroid"]) for m in members]))
        if cohesion < self.cfg.theme_promotion_cohesion_floor:
            return None
        return cohesion

    def _judge(self, cluster: dict, cohesion: float, category_id: str,
               others: list[dict], as_of: datetime, counts: dict) -> None:
        existing = self._existing_themes(cluster["centroid"], as_of)
        near_misses = [
            o for o in others
            if cosine(o["centroid"], cluster["centroid"])
            >= self.cfg.theme_promotion_cluster_floor
        ]
        dossier = {
            "members": [
                {"headline": m["headline"], "summary": (m["summary"] or "")[:400],
                 "first_entry_at": m["first_entry_at"]}
                for m in cluster["members"][:_DOSSIER_MEMBER_CAP]
            ],
            "member_count": len(cluster["members"]),
            "active_days": len({m["first_entry_at"].date()
                                for m in cluster["members"]
                                if m["first_entry_at"] is not None}),
            "cohesion": round(cohesion, 3),
            "cross_category_candidates": [
                {"headline": o["headline"]} for o in near_misses[:5]
            ],
            "existing_themes": existing,
        }
        try:
            verdict = self.models.judge_promotion(dossier)
        except Exception:
            counts["rejected"] += 1
            return
        if (verdict.get("verdict") == "attach_existing"
                and verdict.get("theme_id") in {
                    t["theme_id"] for t in existing}):
            for member in cluster["members"]:
                self.theme_engine.attach(
                    member["id"], member["centroid"], verdict["theme_id"],
                    "sweep_join",
                    verdict.get("reason") or "sweep: matched existing theme")
            counts["attached_existing"] += 1
            return
        if verdict.get("verdict") != "promote":
            counts["rejected"] += 1
            return
        name = (verdict.get("theme_name") or "").strip()[:_MAX_NAME]
        criterion = (verdict.get("inclusion_criterion") or "").strip()[
            :_MAX_CRITERION]
        if not valid_theme_name(name) or not criterion:
            counts["rejected"] += 1
            return
        theme_id = self.store.create_theme(
            name, pack_fp16(cluster["centroid"]), category_id=category_id,
            name_model=getattr(self.cfg, "judge_model", None),
            inclusion_criterion=criterion)
        for member in cluster["members"]:
            self.theme_engine.attach(
                member["id"], member["centroid"], theme_id, "promoted",
                verdict.get("reason") or
                "promotion sweep: cluster crossed gate")
        for other in near_misses:
            self.theme_engine.sync(other["id"])
        counts["promoted"] += 1

    def _existing_themes(self, centroid: np.ndarray,
                         as_of: datetime) -> list[dict]:
        themes = [t for t in self.store.all_themes()
                  if t["centroid"] is not None]
        scored = sorted(((cosine(centroid, t["centroid"]), t) for t in themes),
                        key=lambda pair: -pair[0])
        shaped = []
        for sim, theme in scored[:_EXISTING_THEME_CANDIDATES]:
            if sim < self.cfg.theme_sim_floor:
                break
            newest = theme.get("newest_storyline_at")
            days = (max(0, int((as_of - newest).total_seconds() // 86400))
                    if newest is not None else None)
            shaped.append({"theme_id": str(theme["id"]),
                           "name": theme["display_name"],
                           "inclusion_criterion":
                               theme.get("inclusion_criterion") or "",
                           "storyline_count": theme["storyline_count"],
                           "days_since_active": days})
        return shaped

    def _review_themes(self, counts: dict) -> None:
        for theme in self.store.all_themes():
            if theme["centroid"] is None or theme["storyline_count"] < 2:
                continue
            members = self.store.theme_member_centroids(str(theme["id"]))
            if not members:
                continue
            cohesion = float(np.mean(
                [cosine(v, theme["centroid"]) for v in members]))
            if cohesion >= self.cfg.theme_demotion_cohesion_floor:
                continue
            dossier = {"name": theme["display_name"],
                       "inclusion_criterion":
                           theme.get("inclusion_criterion") or "",
                       "cohesion": round(cohesion, 3),
                       "storyline_count": theme["storyline_count"],
                       "recent_headlines": self.store.theme_recent_headlines(
                           str(theme["id"]), limit=5)}
            try:
                verdict = self.models.review_theme(dossier)
            except Exception:
                continue
            if verdict.get("verdict") == "demote":
                self.store.demote_theme(str(theme["id"]))
                counts["demoted"] += 1
