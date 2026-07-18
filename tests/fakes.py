"""In-memory Store fake mirroring Store's read/write surface for engine unit tests."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from pipeline.vectors import pack_fp16, unpack_fp16


class FakeStore:
    def __init__(self) -> None:
        self.entries: dict[str, dict] = {}
        self.episodes: dict[str, dict] = {}
        self.storylines: dict[str, dict] = {}
        self.attaches: list[dict] = []
        self.cards: list[dict] = []

    # -- writes --------------------------------------------------------
    def create_episode(self, storyline_id, method, similarity, reason, model, t):
        if storyline_id is None:
            storyline_id = str(uuid.uuid4())
            self.storylines[storyline_id] = {
                "id": storyline_id, "entity_set": [], "event_keys": [],
                "centroid": None, "episode_count": 0, "newest_entry_at": t,
            }
        episode_id = str(uuid.uuid4())
        self.episodes[episode_id] = {
            "id": episode_id, "storyline_id": storyline_id, "status": "open",
            "centroid": None, "entity_set": [], "event_keys": [],
            "entry_count": 0, "first_entry_at": t, "newest_entry_at": t,
            "attach_method": method,
        }
        self.storylines[storyline_id]["episode_count"] += 1
        return episode_id, storyline_id

    def attach_entry(self, entry_id, episode_id, agency, is_syndicated, method,
                     similarity, matched_entry_id, threshold, embedding_model,
                     episode_centroid, published_at):
        self.attaches.append({"entry_id": entry_id, "episode_id": episode_id,
                              "method": method, "similarity": similarity,
                              "is_syndicated": is_syndicated})
        ep = self.episodes[episode_id]
        entry = self.entries[entry_id]
        ep["entry_count"] += 1
        ep["newest_entry_at"] = max(ep["newest_entry_at"], published_at)
        ep["centroid"] = episode_centroid
        ep["entity_set"] = sorted(set(ep["entity_set"]) | set(entry["entity_set"]))
        ep["event_keys"] = sorted(set(ep["event_keys"]) | set(entry["event_keys"]))
        entry["episode_id"] = episode_id
        story = self.storylines[ep["storyline_id"]]
        story["entity_set"] = sorted(set(story["entity_set"]) | set(entry["entity_set"]))
        story["event_keys"] = sorted(set(story["event_keys"]) | set(entry["event_keys"]))
        story["newest_entry_at"] = max(story["newest_entry_at"], published_at)

    def close_episode(self, episode_id):
        ep = self.episodes[episode_id]
        was_open = ep["status"] == "open"
        ep["status"] = "dormant"
        return was_open

    # -- reads ---------------------------------------------------------
    def content_hash_dup(self, hash_, t, window_hours):
        for e in self.entries.values():
            if (e.get("episode_id") and e["content_hash"] == hash_
                    and e["published_at"] > t - timedelta(hours=window_hours)):
                return {"id": e["id"], "episode_id": e["episode_id"]}
        return None

    def recent_embedded(self, t, window_hours):
        return [
            {"id": e["id"], "episode_id": e["episode_id"],
             "embedding": unpack_fp16(e["embedding"])}
            for e in self.entries.values()
            if e.get("episode_id") and e.get("embedding") is not None
            and e["published_at"] > t - timedelta(hours=window_hours)
        ]

    def open_episodes(self):
        return [dict(e, centroid=unpack_fp16(e["centroid"]) if e["centroid"] is not None else None)
                for e in self.episodes.values() if e["status"] == "open"]

    # -- test helpers ----------------------------------------------------
    def add_entry(self, **kw: Any) -> dict:
        vec = kw.pop("vec", None)
        entry = {
            "id": str(uuid.uuid4()), "episode_id": None, "embedding": None,
            "entity_set": [], "event_keys": [], "agency": "x.gov",
            "news_source_id": "src", **kw,
        }
        if vec is not None:
            entry["embedding"] = pack_fp16(vec)
        self.entries[entry["id"]] = entry
        return entry
