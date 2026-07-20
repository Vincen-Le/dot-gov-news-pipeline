"""Stage 1 — episode formation (v1 pipeline, event-time windows).

Tier order per entry: content-hash dedupe -> near-dup -> event-key/centroid
candidate pool -> adjudicator -> new episode (storyline attach delegated to
the resolver). Only duplicate detection can attach without adjudication.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Callable, Protocol

import numpy as np

from pipeline.shared.config import Config
from pipeline.shared.vectors import cosine, pack_fp16, running_mean


class ModelClient(Protocol):
    def adjudicate_same_event(self, a: dict, b: dict, context: str) -> tuple[bool, str]: ...


StorylineResolver = Callable[
    [dict, np.ndarray], tuple[str | None, str, float | None, str | None, str | None]
]


class EpisodeEngine:
    def __init__(self, store, models: ModelClient, cfg: Config,
                 storyline_resolver: StorylineResolver) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg
        self.resolve_storyline = storyline_resolver
        self._open: list[dict] | None = None  # lazy cache of open episodes

    # -- open-episode cache --------------------------------------------
    def _open_episodes(self) -> list[dict]:
        if self._open is None:
            self._open = self.store.open_episodes()
        return self._open

    def _refresh_episode(self, episode_id: str, entry: dict, vec: np.ndarray,
                         published_at: datetime) -> None:
        for ep in self._open_episodes():
            if str(ep["id"]) == str(episode_id):
                ep["centroid"] = running_mean(ep.get("centroid"), ep["entry_count"], vec)
                ep["entry_count"] += 1
                ep["newest_entry_at"] = max(ep["newest_entry_at"], published_at)
                ep["entity_set"] = sorted(set(ep["entity_set"]) | set(entry["entity_set"]))
                ep["event_keys"] = sorted(set(ep["event_keys"]) | set(entry["event_keys"]))
                return

    def _attach(self, entry: dict, episode: dict, method: str, similarity: float | None,
                matched_entry_id: str | None, threshold: float | None,
                vec: np.ndarray, is_syndicated: bool) -> dict:
        new_centroid = running_mean(episode.get("centroid"), episode["entry_count"], vec)
        self.store.attach_entry(
            entry["id"], str(episode["id"]), entry["agency"], is_syndicated, method,
            similarity, matched_entry_id, threshold, self.cfg.embedding_model,
            pack_fp16(new_centroid), entry["published_at"],
            publisher_weight_version=self.cfg.publisher_weight_version)
        self._refresh_episode(str(episode["id"]), entry, vec, entry["published_at"])
        return {"entry_id": entry["id"], "episode_id": str(episode["id"]), "method": method,
                "similarity": similarity, "matched_entry_id": matched_entry_id,
                "threshold": threshold, "is_syndicated": is_syndicated}

    def _episode_by_id(self, episode_id: str) -> dict:
        for ep in self._open_episodes():
            if str(ep["id"]) == str(episode_id):
                return ep
        # dup matched a since-closed episode within the dedupe window: attach anyway
        return {"id": episode_id, "entry_count": 0, "centroid": None,
                "entity_set": [], "event_keys": [], "newest_entry_at": None,
                "first_entry_at": None, "storyline_id": None}

    def _candidate_evidence(self, episode: dict) -> tuple[dict, str | None]:
        members = self.store.episode_members(str(episode["id"]))
        latest = members[-1] if members else None
        if latest is None:
            return ({"title": "(episode)",
                     "summary": "No member entry is available.",
                     "entities": sorted(episode["entity_set"])}, None)
        return ({"title": latest["title"],
                 "summary": latest.get("summary"),
                 "entities": sorted(episode["entity_set"])},
                str(latest["id"]))

    def _adjudicate_candidates(self, entry: dict, vec: np.ndarray,
                               candidates: list[tuple[dict, float | None, str]]) -> dict | None:
        seen: set[str] = set()
        for candidate, similarity, signal in candidates:
            candidate_id = str(candidate["id"])
            if candidate_id in seen:
                continue
            seen.add(candidate_id)
            shared_entities = sorted(
                set(entry["entity_set"]) & set(candidate["entity_set"]))
            shared_event_keys = sorted(
                set(entry["event_keys"]) & set(candidate["event_keys"]))
            evidence, matched_entry_id = self._candidate_evidence(candidate)
            same, _reason = self.models.adjudicate_same_event(
                {"title": entry["title"], "summary": entry.get("summary"),
                 "entities": sorted(entry["entity_set"])},
                evidence,
                context=(
                    "Decide whether the new item belongs to this same concrete "
                    "in-progress episode. Candidate signals nominate only and "
                    f"are not proof: {signal}; shared event keys "
                    f"{shared_event_keys or '(none)'}; shared entities "
                    f"{shared_entities or '(none)'}; semantic similarity "
                    f"{f'{similarity:.3f}' if similarity is not None else '(none)'}."
                ))
            if same:
                return self._attach(
                    entry, candidate, "adjudicated_join", similarity,
                    matched_entry_id,
                    self.cfg.cluster_join_threshold if similarity is not None else None,
                    vec, False)
        return None

    # -- main entry point ------------------------------------------------
    def process_entry(self, entry: dict, vec: np.ndarray) -> dict:
        t = entry["published_at"]

        # tier 1: verbatim syndication (72 h, decoupled from dormancy)
        dup = self.store.content_hash_dup(entry["content_hash"], t, self.cfg.dedupe_window_hours)
        if dup and str(dup["id"]) != str(entry["id"]):
            episode = self._episode_by_id(str(dup["episode_id"]))
            return self._attach(entry, episode, "content_hash", None, str(dup["id"]),
                                None, vec, True)

        # tier 2: fuzzy near-dup vs recent embedded entries
        best_sim, best_row = 0.0, None
        for row in self.store.recent_embedded(t, self.cfg.dedupe_window_hours):
            if str(row["id"]) == str(entry["id"]):
                continue
            sim = cosine(vec, row["embedding"])
            if sim > best_sim:
                best_sim, best_row = sim, row
        if best_row is not None and best_sim >= self.cfg.near_dup_threshold:
            episode = self._episode_by_id(str(best_row["episode_id"]))
            return self._attach(entry, episode, "near_dup", best_sim, str(best_row["id"]),
                                self.cfg.near_dup_threshold, vec, True)

        # tiers 3-4: deterministic signals nominate candidates only. Event-key
        # matches lead, then semantic candidates follow by similarity. Every
        # non-duplicate join still requires an affirmative judge verdict.
        candidates: list[tuple[dict, float | None, str]] = []
        if entry["event_keys"]:
            for ep in self._open_episodes():
                if set(entry["event_keys"]) & set(ep["event_keys"]):
                    candidates.append((ep, None, "event-key match"))

        semantic_candidates: list[tuple[float, dict]] = []
        for ep in self._open_episodes():
            if ep.get("centroid") is None:
                continue
            sim = cosine(vec, ep["centroid"])
            if sim >= self.cfg.cluster_join_threshold:
                semantic_candidates.append((sim, ep))
        for sim, ep in sorted(semantic_candidates, key=lambda pair: -pair[0])[:3]:
            candidates.append((ep, sim, "semantic threshold match"))

        joined = self._adjudicate_candidates(entry, vec, candidates)
        if joined is not None:
            return joined
        method = "adjudicated_new" if candidates else "new_cluster"

        # tier 5: new episode; resolver decides the storyline
        storyline_id, s_method, s_sim, s_reason, s_model = self.resolve_storyline(entry, vec)
        episode_id, storyline_id = self.store.create_episode(
            storyline_id, s_method, s_sim, s_reason, s_model, t)
        episode = {"id": episode_id, "storyline_id": storyline_id, "status": "open",
                   "centroid": None, "entity_set": [], "event_keys": [],
                   "entry_count": 0, "first_entry_at": t, "newest_entry_at": t}
        self._open_episodes().append(episode)
        return self._attach(entry, episode, method, None, None, None, vec, False)

    # -- dormancy ---------------------------------------------------------
    def close_due(self, t: datetime) -> list[dict]:
        closed: list[dict] = []
        cutoff = t - timedelta(hours=self.cfg.episode_dormancy_hours)
        for ep in list(self._open_episodes()):
            if ep["newest_entry_at"] is not None and ep["newest_entry_at"] < cutoff:
                if self.store.close_episode(str(ep["id"])):
                    ep["status"] = "dormant"
                    closed.append(ep)
                self._open_episodes().remove(ep)
        return closed
