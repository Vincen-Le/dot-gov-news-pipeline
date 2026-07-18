"""Stage 4 — topic themes: incremental nearest-centroid over storyline
overview embeddings, LLM-adjudicated joins with naming folded into the same
call. Assignment at first overview, hysteresis re-check on refresh."""

from __future__ import annotations

import numpy as np

from pipeline.config import Config
from pipeline.vectors import cosine, pack_fp16

_TOP_K = 10
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
                return  # hysteresis: still fits, no LLM
            self._assign(storyline_id, state, vec, method="reassigned")
            return
        self._assign(storyline_id, state, vec, method=None)

    # -- assignment -----------------------------------------------------

    def _assign(self, storyline_id: str, state: dict, vec: np.ndarray,
                method: str | None) -> None:
        storyline = {"headline": state.get("headline") or "(no card)",
                     "summary": state.get("summary") or ""}
        scored = sorted(
            ((cosine(vec, t["centroid"]), t) for t in self.store.all_themes()
             if t["centroid"] is not None),
            key=lambda pair: -pair[0])
        candidates = [(sim, t) for sim, t in scored
                      if sim >= self.cfg.theme_sim_floor][:_TOP_K]

        if not candidates:
            self._spawn(storyline_id, storyline, vec,
                        name=storyline["headline"][:_MAX_NAME],
                        method=method or "new_theme",
                        similarity=None, reason="no theme above sim floor")
            return

        payload = [{"id": str(t["id"]), "display_name": t["display_name"],
                    "headlines": self.store.theme_headlines(str(t["id"])),
                    "similarity": sim}
                   for sim, t in candidates]
        verdict = self.models.adjudicate_theme(storyline, payload)
        by_id = {str(t["id"]): (sim, t) for sim, t in candidates}
        chosen = by_id.get(str(verdict.get("theme_id") or ""))

        if chosen is None:
            name = (verdict.get("updated_name") or storyline["headline"])[:_MAX_NAME]
            self._spawn(storyline_id, storyline, vec, name=name,
                        method=method or "new_theme",
                        similarity=candidates[0][0], reason=verdict["reason"])
            return

        sim, theme = chosen
        old_theme_id = state.get("theme_id")
        members = self.store.theme_member_centroids(str(theme["id"]))
        new_centroid = np.mean(members + [vec], axis=0) if members else vec
        rename = verdict.get("updated_name")
        self.store.assign_theme(
            storyline_id, str(theme["id"]),
            method="adjudicated_join" if method is None else method,
            similarity=sim, reason=verdict["reason"],
            theme_centroid=pack_fp16(new_centroid),
            theme_display_name=rename[:_MAX_NAME] if rename else None)
        if old_theme_id is not None and str(old_theme_id) != str(theme["id"]):
            self._refresh_centroid(str(old_theme_id))
        if theme.get("category_id") is None:
            self._classify(str(theme["id"]), theme["display_name"], storyline)

    def _spawn(self, storyline_id: str, storyline: dict, vec: np.ndarray,
               name: str, method: str, similarity: float | None,
               reason: str) -> None:
        theme_id = self.store.create_theme(
            name, pack_fp16(vec), category_id=None,
            name_model=getattr(self.cfg, "adjudicator_model", None))
        self.store.assign_theme(storyline_id, theme_id, method=method,
                                similarity=similarity, reason=reason,
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
