"""In-RAM rolling event-time window for replay runs.

Serves the two per-entry dedupe reads (content_hash_dup, recent_embedded)
from a deque instead of ~6.5k window queries against Postgres. The runner
feeds it after every attach and advances it with the event clock.
"""

from __future__ import annotations

from collections import deque
from datetime import datetime, timedelta

import numpy as np

from pipeline.store import Store


class ReplayWindow:
    def __init__(self, window_hours: float) -> None:
        self.window_hours = window_hours
        self._entries: deque[dict] = deque()  # ordered by published_at ascending

    def add(self, entry_id: str, episode_id: str, content_hash: str,
            published_at: datetime, vec: np.ndarray | None) -> None:
        self._entries.append({
            "id": entry_id, "episode_id": episode_id, "content_hash": content_hash,
            "published_at": published_at, "embedding": vec,
        })

    def advance(self, t: datetime) -> None:
        cutoff = t - timedelta(hours=self.window_hours)
        while self._entries and self._entries[0]["published_at"] <= cutoff:
            self._entries.popleft()

    def content_hash_dup(self, hash_: str, t: datetime, window_hours: float) -> dict | None:
        cutoff = t - timedelta(hours=window_hours)
        for row in reversed(self._entries):  # newest first
            if row["content_hash"] == hash_ and row["published_at"] > cutoff:
                return {"id": row["id"], "episode_id": row["episode_id"]}
        return None

    def recent_embedded(self, t: datetime, window_hours: float) -> list[dict]:
        cutoff = t - timedelta(hours=window_hours)
        return [
            {"id": r["id"], "episode_id": r["episode_id"], "embedding": r["embedding"]}
            for r in self._entries
            if r["embedding"] is not None and r["published_at"] > cutoff
        ]


class ReplayStore(Store):
    """Store with the two window reads served from RAM; everything else hits Postgres."""

    def __init__(self, db, window: ReplayWindow) -> None:
        super().__init__(db)
        self.window = window

    def content_hash_dup(self, hash_: str, t: datetime, window_hours: float) -> dict | None:
        return self.window.content_hash_dup(hash_, t, window_hours)

    def recent_embedded(self, t: datetime, window_hours: float) -> list[dict]:
        return self.window.recent_embedded(t, window_hours)
