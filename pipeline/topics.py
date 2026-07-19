"""Stage 4 — topic themes, attach-only stream path.

Themes are born offline by the promotion sweep (pipeline/promotion.py); the
stream path may only attach a storyline to an existing theme whose inclusion
criterion it satisfies. Attachment is cross-category and sticky: attached
storylines never re-adjudicate; only demotion detaches. Failure bias: a
failed or hallucinated verdict never attaches.
"""

from __future__ import annotations

import numpy as np

from pipeline.config import Config
from pipeline.vectors import cosine, pack_fp16


def valid_theme_name(name: str) -> bool:
    words = name.split()
    if not 2 <= len(words) <= 5:
        return False
    return all(
        word[0].isalnum() and word.replace("&", "").replace("-", "").isalnum()
        for word in words
    )


class ThemeEngine:
    def __init__(self, store, models, cfg: Config) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg

    def sync(self, storyline_id: str) -> None:
        state = self.store.storyline_theme_state(storyline_id)
        if (state is None or state["centroid"] is None
                or state["theme_id"] is not None):
            return  # sticky: attached storylines never move on the stream path
        vec = state["centroid"]
        themes = [t for t in self.store.all_themes()
                  if t["centroid"] is not None]
        scored = sorted(((cosine(vec, t["centroid"]), t) for t in themes),
                        key=lambda pair: -pair[0])
        top = [(sim, t) for sim, t in scored
               if sim >= self.cfg.theme_sim_floor][:self.cfg.theme_knn_k]
        if not top:
            return  # category-only; the promotion sweep owns theme creation

        storyline = {"headline": state.get("headline") or "(no card)",
                     "summary": state.get("summary") or ""}
        candidates = [self._shape_candidate(t, state.get("newest_entry_at"))
                      for _, t in top]
        try:
            verdict = self.models.adjudicate_membership(storyline, candidates)
        except Exception:
            return  # none-biased: a failed verdict never attaches
        target = verdict.get("theme_id")
        if target in {c["theme_id"] for c in candidates}:
            self.attach(storyline_id, vec, target, "criterion_join",
                        verdict.get("reason") or "criterion satisfied")

    def attach(self, storyline_id: str, vec: np.ndarray, theme_id: str,
               method: str, reason: str) -> None:
        theme = next((t for t in self.store.all_themes()
                      if str(t["id"]) == theme_id), None)
        sim = (cosine(vec, theme["centroid"])
               if theme is not None and theme["centroid"] is not None else None)
        members = self.store.theme_member_centroids(theme_id)
        new_centroid = np.mean(members + [vec], axis=0) if members else vec
        self.store.assign_theme(
            storyline_id, theme_id, method=method, similarity=sim,
            reason=reason, theme_centroid=pack_fp16(new_centroid),
            theme_display_name=None)

    def _shape_candidate(self, theme: dict, event_time) -> dict:
        days = None
        newest = theme.get("newest_storyline_at")
        if event_time is not None and newest is not None:
            days = max(0, int((event_time - newest).total_seconds() // 86400))
        return {"theme_id": str(theme["id"]), "name": theme["display_name"],
                "inclusion_criterion": theme.get("inclusion_criterion") or "",
                "storyline_count": theme["storyline_count"],
                "recent_headlines": self.store.theme_recent_headlines(
                    str(theme["id"])),
                "days_since_active": days}
