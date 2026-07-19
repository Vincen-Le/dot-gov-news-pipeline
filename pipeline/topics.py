"""Stage 4 — topic themes: KNN over themed storyline centroids adopts the
majority neighbor label (no LLM on join); spawns name a new theme via one
cheap LLM call. Assignment at first overview, hysteresis re-check on refresh."""

from __future__ import annotations

from collections import Counter

import numpy as np

from pipeline.config import Config
from pipeline.vectors import cosine, pack_fp16

_MAX_NAME = 256


class ThemeEngine:
    def __init__(self, store, models, cfg: Config) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg

    def sync(self, storyline_id: str) -> None:
        state = self.store.storyline_theme_state(storyline_id)
        if state is None or state["centroid"] is None:
            return
        vec = state["centroid"]
        if state["theme_id"] is not None:
            theme = next((t for t in self.store.all_themes()
                          if str(t["id"]) == str(state["theme_id"])), None)
            if theme is not None and theme["centroid"] is not None \
                    and cosine(vec, theme["centroid"]) >= self.cfg.theme_stick_floor:
                return  # hysteresis: still fits, no work
            self._assign(storyline_id, state, vec, method="reassigned")
            return
        self._assign(storyline_id, state, vec, method=None)

    # -- assignment -----------------------------------------------------

    def _assign(self, storyline_id: str, state: dict, vec: np.ndarray,
                method: str | None) -> None:
        storyline = {"headline": state.get("headline") or "(no card)",
                     "summary": state.get("summary") or ""}
        neighbors = sorted(
            ((cosine(vec, s["centroid"]), s)
             for s in self.store.themed_storylines()
             if str(s["id"]) != str(storyline_id)),
            key=lambda pair: -pair[0])
        top = [(sim, s) for sim, s in neighbors
               if sim >= self.cfg.theme_sim_floor][:self.cfg.theme_knn_k]

        if not top:
            self._spawn(storyline_id, storyline, vec,
                        method=method or "new_theme",
                        reason="no themed storyline above sim floor")
            return

        votes = Counter(str(s["theme_id"]) for _, s in top)
        # modal theme; ties resolve to the nearest neighbor's theme
        best_count = max(votes.values())
        winner = next(str(s["theme_id"]) for sim, s in top
                      if votes[str(s["theme_id"])] == best_count)
        sim = max(s for s, n in top if str(n["theme_id"]) == winner)

        old_theme_id = state.get("theme_id")
        members = self.store.theme_member_centroids(winner)
        new_centroid = np.mean(members + [vec], axis=0) if members else vec
        self.store.assign_theme(
            storyline_id, winner,
            method="knn_join" if method is None else method,
            similarity=sim,
            reason=f"knn: {votes[winner]}/{len(top)} nearest storylines",
            theme_centroid=pack_fp16(new_centroid),
            theme_display_name=None)
        if old_theme_id is not None and str(old_theme_id) != winner:
            self._refresh_centroid(str(old_theme_id))
        theme = next((t for t in self.store.all_themes()
                      if str(t["id"]) == winner), None)
        if theme is not None and theme.get("category_id") is None:
            self._classify(winner, theme["display_name"], storyline)

    def _spawn(self, storyline_id: str, storyline: dict, vec: np.ndarray,
               method: str, reason: str) -> None:
        try:
            name = self.models.name_theme(storyline)[:_MAX_NAME]
        except Exception as exc:  # naming never blocks: fall back to the headline
            name = storyline["headline"][:_MAX_NAME]
            reason = f"{reason}; namer_error: {exc}"
        theme_id = self.store.create_theme(
            name or storyline["headline"][:_MAX_NAME], pack_fp16(vec),
            category_id=None,
            name_model=getattr(self.cfg, "judge_model", None))
        self.store.assign_theme(storyline_id, theme_id, method=method,
                                similarity=None, reason=reason,
                                theme_centroid=None, theme_display_name=None)
        self._classify(theme_id, name, storyline)

    def _refresh_centroid(self, theme_id: str) -> None:
        members = self.store.theme_member_centroids(theme_id)
        if members:
            self.store.update_theme(theme_id,
                                    centroid=pack_fp16(np.mean(members, axis=0)))

    def _classify(self, theme_id: str, theme_name: str, storyline: dict) -> None:
        categories = self.store.all_categories()
        verdict = self.models.classify_category(theme_name, storyline, categories)
        valid = {str(c["id"]) for c in categories}
        category_id = verdict.get("category_id")
        if category_id is not None and str(category_id) in valid:
            self.store.update_theme(theme_id, category_id=str(category_id))
            return
        proposed = verdict.get("new_category_name")
        if proposed:
            new_id = self.store.upsert_category(
                proposed[:128], "llm", verdict.get("reason"))
            self.store.update_theme(theme_id, category_id=new_id)
        # classifier failure / nothing proposed: category stays null,
        # retried the next time a join touches this theme
