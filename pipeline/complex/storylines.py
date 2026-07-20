"""Stage 2 — storyline attachment.

Event keys and entity overlap only nominate candidates.  The adjudicator is
the sole authority allowed to attach a new episode to an existing storyline.
Failures are split-biased and create a new storyline.
"""

from __future__ import annotations

import numpy as np

from pipeline.shared.config import Config
from pipeline.shared.vectors import cosine

_TOP_K = 3


class StorylineEngine:
    def __init__(self, store, models, cfg: Config) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg

    def _rank_candidates(self, entry: dict, candidates: list[dict]) -> list[dict]:
        emas = self.store.entity_emas(entry["entity_set"])
        scored = []
        for cand in candidates:
            shared = set(entry["entity_set"]) & set(cand["entity_set"])
            score = sum(1.0 / (1.0 + emas.get(e, 0.0)) for e in shared)
            scored.append((score, len(shared), cand))
        # no id tie-break: ids regenerate every run, which made tie order —
        # and attach decisions — vary across identical replays. Stable sort
        # preserves the store's content-ordered input for ties instead.
        scored.sort(key=lambda x: (-x[0], -x[1]))
        return [c for _, _, c in scored]

    def resolve(self, entry: dict, vec: np.ndarray
                ) -> tuple[str | None, str, float | None, str | None, str | None]:
        # Candidate generation only. Event-key matches lead because they are
        # usually the strongest identity signal, then EMA-ranked entity
        # matches fill the pool. A candidate present in both surfaces is judged
        # once. Neither signal can attach without an affirmative LLM verdict.
        event_candidates = (
            self.store.storylines_by_event_keys(entry["event_keys"])
            if entry["event_keys"] else []
        )
        entity_candidates = self._rank_candidates(
            entry, self.store.storylines_by_entities(entry["entity_set"])
        ) if entry["entity_set"] else []
        candidates: list[dict] = []
        seen: set[str] = set()
        for cand in [*event_candidates, *entity_candidates]:
            candidate_id = str(cand["id"])
            if candidate_id not in seen:
                seen.add(candidate_id)
                candidates.append(cand)

        for cand in candidates[:_TOP_K]:
            sim = (cosine(vec, cand["centroid"])
                   if cand.get("centroid") is not None else None)
            shared_entities = sorted(
                set(entry["entity_set"]) & set(cand["entity_set"]))
            shared_event_keys = sorted(
                set(entry["event_keys"]) & set(cand["event_keys"]))
            overview = self.store.latest_overview(str(cand["id"]))
            latest_member = (None if overview is not None else
                             self.store.latest_storyline_entry(str(cand["id"])))
            evidence = overview or latest_member or {}
            gap_days = (entry["published_at"] - cand["newest_entry_at"]).days
            context = (
                f"The storyline's current evidence: "
                f"{evidence.get('headline') or evidence.get('title') or '(none)'} — "
                f"{evidence.get('summary') or '(no summary)'} "
                f"Last activity {gap_days} days before the new item. "
                f"Candidate signals only (not proof): shared event keys "
                f"{shared_event_keys or '(none)'}, shared entities "
                f"{shared_entities or '(none)'}, semantic similarity "
                f"{f'{sim:.3f}' if sim is not None else '(none)'}. "
                "Is the new item a development of this same historical event chain?"
            )
            same, reason = self.models.adjudicate_same_event(
                {"title": entry["title"], "summary": entry.get("summary"),
                 "entities": entry["entity_set"]},
                {"title": evidence.get("headline") or evidence.get("title") or "(storyline)",
                 "summary": evidence.get("summary", ""),
                 "entities": sorted(cand["entity_set"])[:32]},
                context=context)
            if same:
                return (str(cand["id"]), "adjudicated_join", sim, reason,
                        self.cfg.adjudicator_model)

        return None, "new_storyline", None, None, None
