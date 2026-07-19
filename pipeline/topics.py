"""Stage 4 — topic themes.

Centroids and names nominate candidates; LLM verdicts decide assignment and
merging. Failures are split-biased: a failed verdict can spawn a fully valid
theme or defer assignment, but can never turn a nearest neighbor into truth.
"""

from __future__ import annotations

from difflib import SequenceMatcher
import re

import numpy as np

from pipeline.config import Config
from pipeline.vectors import cosine, pack_fp16

_MAX_NAME = 256
_METADATA_ATTEMPTS = 2
_MERGE_STOPWORDS = {
    "advances", "development", "efforts", "events", "federal", "government",
    "national", "program", "programs", "services", "support", "updates", "us",
}


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
                if theme.get("category_id") is None:
                    self._repair_category(
                        str(theme["id"]), theme["display_name"],
                        {"headline": state.get("headline") or "(no card)",
                         "summary": state.get("summary") or ""})
                return  # hysteresis: still fits, no work
            self._assign(storyline_id, state, vec, method="reassigned")
            return
        self._assign(storyline_id, state, vec, method=None)

    # -- assignment -----------------------------------------------------

    def _assign(self, storyline_id: str, state: dict, vec: np.ndarray,
                method: str | None) -> None:
        storyline = {"headline": state.get("headline") or "(no card)",
                     "summary": state.get("summary") or ""}
        themes = [t for t in self.store.all_themes()
                  if t["centroid"] is not None]
        scored = sorted(((cosine(vec, t["centroid"]), t) for t in themes),
                        key=lambda pair: -pair[0])
        top = [(sim, t) for sim, t in scored
               if sim >= self.cfg.theme_sim_floor][:self.cfg.theme_knn_k]

        if not top:
            self._spawn(storyline_id, storyline, vec,
                        method=method or "new_theme",
                        reason="no theme above sim floor")
            return

        candidates = [
            {"theme_id": str(t["id"]), "name": t["display_name"],
             "storyline_count": t["storyline_count"],
             "recent_headlines": self.store.theme_recent_headlines(str(t["id"]))}
            for _, t in top
        ]
        categories = self._seed_categories()
        try:
            verdict = self.models.adjudicate_theme(
                storyline, candidates, categories)
        except Exception as exc:
            self._spawn(
                storyline_id, storyline, vec,
                method=method or "new_theme",
                reason=f"adjudicator_error: {exc}; split_biased_spawn")
            return

        valid = [c["theme_id"] for c in candidates]
        merge_ids = list(dict.fromkeys(
            i for i in verdict.get("merge_theme_ids") or [] if i in valid))
        survivor = self._merge(merge_ids, top) if len(merge_ids) >= 2 else None

        target = verdict.get("theme_id")
        if verdict.get("decision") == "join" and target in valid:
            if survivor is not None and target in merge_ids:
                target = survivor
            self._join(storyline_id, state, vec, target, method,
                       verdict.get("reason") or "adjudicated join", storyline)
            return
        # spawn verdict, or hallucinated/missing theme_id on a join verdict
        self._spawn(storyline_id, storyline, vec,
                    method=method or "new_theme",
                    reason=verdict.get("reason") or "adjudicator spawn",
                    name=verdict.get("new_theme_name"),
                    category_id=verdict.get("category_id"))

    def _join(self, storyline_id: str, state: dict, vec: np.ndarray,
              theme_id: str, method: str | None, reason: str,
              storyline: dict) -> None:
        old_theme_id = state.get("theme_id")
        theme = next((t for t in self.store.all_themes()
                      if str(t["id"]) == theme_id), None)
        sim = (cosine(vec, theme["centroid"])
               if theme is not None and theme["centroid"] is not None else None)
        members = self.store.theme_member_centroids(theme_id)
        new_centroid = np.mean(members + [vec], axis=0) if members else vec
        self.store.assign_theme(
            storyline_id, theme_id,
            method="adjudicated_join" if method is None else method,
            similarity=sim, reason=reason,
            theme_centroid=pack_fp16(new_centroid),
            theme_display_name=None)
        if old_theme_id is not None and str(old_theme_id) != theme_id:
            self._refresh_centroid(str(old_theme_id))
        if theme is not None and theme.get("category_id") is None:
            self._repair_category(theme_id, theme["display_name"], storyline)

    def _merge(self, merge_ids: list[str], top) -> str:
        themes = {str(t["id"]): t for _, t in top}
        ordered = sorted(merge_ids,
                         key=lambda i: (-themes[i]["storyline_count"],
                                        themes[i]["created_at"]))
        winner = ordered[0]
        for loser in ordered[1:]:
            self.store.merge_theme(loser, winner)
        self._refresh_centroid(winner)
        return winner

    def _spawn(self, storyline_id: str, storyline: dict, vec: np.ndarray,
               method: str, reason: str, name: str | None = None,
               category_id: str | None = None) -> bool:
        name, category_id, metadata_note = self._resolve_theme_metadata(
            storyline, name, category_id)
        if metadata_note:
            reason = f"{reason}; {metadata_note}"
        if name is None:
            return False
        if self._seed_categories() and category_id is None:
            return False
        theme_id = self.store.create_theme(
            name, pack_fp16(vec),
            category_id=category_id,
            name_model=getattr(self.cfg, "judge_model", None))
        self.store.assign_theme(storyline_id, theme_id, method=method,
                                similarity=None, reason=reason,
                                theme_centroid=None, theme_display_name=None)
        return True

    def _refresh_centroid(self, theme_id: str) -> None:
        members = self.store.theme_member_centroids(theme_id)
        if members:
            self.store.update_theme(theme_id,
                                    centroid=pack_fp16(np.mean(members, axis=0)))

    def _seed_categories(self) -> list[dict]:
        return [c for c in self.store.all_categories()
                if c.get("origin") == "seed"]

    def _resolve_theme_metadata(
            self, storyline: dict, name: str | None,
            category_id: str | None) -> tuple[str | None, str | None, str | None]:
        """Validate adjudicator metadata or fill it with the creator prompt."""
        categories = self._seed_categories()
        valid = {str(c["id"]) for c in categories}
        chosen_category = (str(category_id)
                           if category_id is not None
                           and str(category_id) in valid else None)
        proposed_name = str(name).strip()[:_MAX_NAME] if name else ""
        chosen_name = proposed_name if self._valid_theme_name(proposed_name) else ""
        notes: list[str] = []

        for _attempt in range(_METADATA_ATTEMPTS):
            category_complete = chosen_category is not None or not categories
            if chosen_name and category_complete:
                break
            try:
                metadata = self.models.create_theme_metadata(
                    storyline, categories)
                if not chosen_name:
                    candidate_name = str(
                        metadata.get("theme_name") or "").strip()[:_MAX_NAME]
                    if self._valid_theme_name(candidate_name):
                        chosen_name = candidate_name
                    else:
                        notes.append("theme_creator_error: invalid theme name")
                proposed_category = metadata.get("category_id")
                if (chosen_category is None and proposed_category is not None
                        and str(proposed_category) in valid):
                    chosen_category = str(proposed_category)
                metadata_reason = str(metadata.get("reason") or "").strip()
                if metadata_reason:
                    notes.append(f"theme_metadata: {metadata_reason}")
            except Exception as exc:
                notes.append(f"theme_creator_error: {exc}")

        if not chosen_name:
            notes.append("theme_assignment_deferred: no valid reusable name")
        if categories and chosen_category is None:
            notes.append("theme_assignment_deferred: no valid seeded category")
        return (chosen_name or None, chosen_category,
                "; ".join(dict.fromkeys(notes)) or None)

    @staticmethod
    def _valid_theme_name(name: str) -> bool:
        words = name.split()
        if not 2 <= len(words) <= 5:
            return False
        return all(
            word[0].isalnum() and word.replace("&", "").replace("-", "").isalnum()
            for word in words
        )

    def _repair_category(self, theme_id: str, theme_name: str,
                         storyline: dict) -> None:
        _, category_id, _ = self._resolve_theme_metadata(
            storyline, theme_name, None)
        if category_id is not None:
            self.store.update_theme(theme_id, category_id=category_id)

    @staticmethod
    def _merge_terms(theme: dict, headlines: list[str]) -> set[str]:
        text = " ".join([theme["display_name"], *headlines]).casefold()
        return {
            token for token in re.findall(r"[a-z0-9]+", text)
            if len(token) >= 3 and token not in _MERGE_STOPWORDS
        }

    def _merge_candidate(self, a: dict, b: dict,
                         a_heads: list[str], b_heads: list[str]) -> bool:
        shared = self._merge_terms(a, a_heads) & self._merge_terms(b, b_heads)
        name_ratio = SequenceMatcher(
            None, a["display_name"].casefold(), b["display_name"].casefold()).ratio()
        semantic = (cosine(a["centroid"], b["centroid"])
                    if a.get("centroid") is not None
                    and b.get("centroid") is not None else 0.0)
        return len(shared) >= 2 or (shared and name_ratio >= 0.55) or semantic >= 0.72

    def reconcile_all(self) -> None:
        """LLM-judge likely duplicate themes after assignment is complete."""
        themes = self.store.all_themes()
        categories = self._seed_categories()
        valid_categories = {str(c["id"]) for c in categories}
        headlines = {
            str(t["id"]): self.store.theme_recent_headlines(str(t["id"]), limit=5)
            for t in themes
        }
        active = {str(t["id"]) for t in themes}
        for index, a in enumerate(themes):
            a_id = str(a["id"])
            if a_id not in active:
                continue
            for b in themes[index + 1:]:
                b_id = str(b["id"])
                if b_id not in active:
                    continue
                if not self._merge_candidate(
                        a, b, headlines[a_id], headlines[b_id]):
                    continue
                shaped_a = {
                    "theme_id": a_id, "name": a["display_name"],
                    "category_id": (str(a["category_id"])
                                    if a.get("category_id") else None),
                    "storyline_count": a["storyline_count"],
                    "recent_headlines": headlines[a_id],
                }
                shaped_b = {
                    "theme_id": b_id, "name": b["display_name"],
                    "category_id": (str(b["category_id"])
                                    if b.get("category_id") else None),
                    "storyline_count": b["storyline_count"],
                    "recent_headlines": headlines[b_id],
                }
                try:
                    verdict = self.models.adjudicate_theme_pair(
                        shaped_a, shaped_b, categories)
                except Exception:
                    continue
                if not verdict.get("same_theme"):
                    continue
                winner, loser = sorted(
                    (a, b),
                    key=lambda theme: (-theme["storyline_count"],
                                       theme["created_at"]))
                winner_id, loser_id = str(winner["id"]), str(loser["id"])
                self.store.merge_theme(loser_id, winner_id)
                active.remove(loser_id)
                canonical_name = str(
                    verdict.get("canonical_name") or "").strip()[:_MAX_NAME]
                category_id = verdict.get("category_id")
                self.store.update_theme(
                    winner_id,
                    display_name=(canonical_name
                                  if self._valid_theme_name(canonical_name) else None),
                    category_id=(str(category_id)
                                 if str(category_id) in valid_categories else None))
                self._refresh_centroid(winner_id)
                if loser_id == a_id:
                    break
