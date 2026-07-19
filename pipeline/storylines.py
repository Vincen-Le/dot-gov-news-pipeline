"""Stage 2 — storyline attachment: entity-anchored candidates over unbounded
time, adjudicated against the chain's own latest overview. Split-biased."""

from __future__ import annotations

import numpy as np

from pipeline.config import Config
from pipeline.vectors import cosine

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
        # tier 1: hard event keys — deterministic chain identity, but a
        # colliding boilerplate key must not glue unrelated content: when the
        # chain has a centroid, demand minimal semantic sanity or fall through
        # to the entity/adjudicator tiers (storyline aeded190 regression).
        for cand in self.store.storylines_by_event_keys(entry["event_keys"]):
            if cand.get("centroid") is None:
                return str(cand["id"]), "event_key", None, None, None
            sim = cosine(vec, cand["centroid"])
            if sim >= self.cfg.storyline_sim_floor:
                return str(cand["id"]), "event_key", sim, None, None

        # tier 2/3: entity candidates via GIN, EMA-down-weighted
        emas = self.store.entity_emas(entry["entity_set"])
        candidates = self._rank_candidates(
            entry, self.store.storylines_by_entities(entry["entity_set"]))
        for cand in candidates[:_TOP_K]:
            sim = cosine(vec, cand["centroid"]) if cand.get("centroid") is not None else 0.0
            shared = set(entry["entity_set"]) & set(cand["entity_set"])
            shared_rare = [e for e in shared
                           if emas.get(e, 0.0) < self.cfg.ambient_ema_ceiling]

            # strong deterministic join: multiple RARE shared discriminators +
            # tight embedding — ambient entities never justify a join
            if len(shared_rare) >= 2 and sim >= self.cfg.cluster_join_threshold:
                return str(cand["id"]), "entity_candidate", sim, None, None

            if sim < self.cfg.storyline_sim_floor:
                continue

            overview = self.store.latest_overview(str(cand["id"]))
            gap_days = (entry["published_at"] - cand["newest_entry_at"]).days
            context = (
                f"The storyline's current overview: "
                f"{(overview or {}).get('headline', '(none)')} — "
                f"{(overview or {}).get('summary', '(no overview yet)')} "
                f"Last activity {gap_days} days before the new item. "
                "Is the new item a development of this same historical event chain?"
            )
            same, reason = self.models.adjudicate_same_event(
                {"title": entry["title"], "summary": entry.get("summary"),
                 "entities": entry["entity_set"]},
                {"title": (overview or {}).get("headline", "(storyline)"),
                 "summary": (overview or {}).get("summary", ""),
                 "entities": sorted(cand["entity_set"])[:32]},
                context=context)
            if same:
                return (str(cand["id"]), "adjudicated_join", sim, reason,
                        self.cfg.adjudicator_model)

        return None, "new_storyline", None, None, None
