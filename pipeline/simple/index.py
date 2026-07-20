"""In-memory storyline index for the spine replay.

Retrieval is max cosine against MEMBER embeddings (research amendment #1:
overview vectors drift and hub; members do not). Centroids are kept only as
episode-attach metadata for the attach_entry RPC. Deterministic: candidate
ties break on insertion order, never on ids.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np

from pipeline.shared.vectors import cosine, running_mean


@dataclass
class LiveStoryline:
    id: str
    order: int
    member_vecs: list = field(default_factory=list)
    centroid: np.ndarray | None = None
    entities: set = field(default_factory=set)
    newest_entry_at: datetime | None = None
    open_episode_id: str | None = None
    open_episode_newest_at: datetime | None = None
    open_episode_centroid: np.ndarray | None = None
    open_episode_count: int = 0
    episode_count: int = 0


class StorylineIndex:
    def __init__(self) -> None:
        self._stories: dict[str, LiveStoryline] = {}

    def register(self, storyline_id: str, episode_id: str, vec: np.ndarray,
                 entities: set, t: datetime) -> LiveStoryline:
        story = LiveStoryline(id=storyline_id, order=len(self._stories))
        self._stories[storyline_id] = story
        self.new_episode(storyline_id, episode_id, vec, entities, t)
        return story

    def restore(self, storyline_id: str, member_vecs: list, entities: set,
                newest_entry_at: datetime, episode_count: int) -> LiveStoryline:
        """Rebuild a storyline from persisted state (anchored continuation).

        All persisted episodes are closed, so the storyline is restored
        dormant: retrievable as a candidate, but a same-story article opens a
        new episode rather than reviving a finalized one.
        """
        story = LiveStoryline(id=storyline_id, order=len(self._stories))
        self._stories[storyline_id] = story
        story.member_vecs = list(member_vecs)
        story.centroid = None
        for i, vec in enumerate(story.member_vecs):
            story.centroid = running_mean(story.centroid, i, vec)
        story.entities = set(entities)
        story.newest_entry_at = newest_entry_at
        story.episode_count = episode_count
        return story

    def new_episode(self, storyline_id: str, episode_id: str, vec: np.ndarray,
                    entities: set, t: datetime) -> None:
        s = self._stories[storyline_id]
        s.open_episode_id = episode_id
        s.open_episode_centroid = None
        s.open_episode_count = 0
        s.episode_count += 1
        self._absorb(s, vec, entities, t)

    def add_member(self, storyline_id: str, vec: np.ndarray, entities: set,
                   t: datetime) -> None:
        self._absorb(self._stories[storyline_id], vec, entities, t)

    def _absorb(self, s: LiveStoryline, vec: np.ndarray, entities: set,
                t: datetime) -> None:
        s.member_vecs.append(vec)
        s.centroid = running_mean(s.centroid, len(s.member_vecs) - 1, vec)
        s.open_episode_centroid = running_mean(
            s.open_episode_centroid, s.open_episode_count, vec)
        s.open_episode_count += 1
        s.entities |= set(entities)
        s.newest_entry_at = t
        s.open_episode_newest_at = t

    def top_candidates(self, vec: np.ndarray, k: int,
                       floor: float) -> list[tuple[LiveStoryline, float]]:
        scored = []
        for s in self._stories.values():
            sim = max(cosine(vec, m) for m in s.member_vecs)
            if sim >= floor:
                scored.append((s, sim))
        scored.sort(key=lambda pair: (-pair[1], pair[0].order))
        return scored[:k]

    def episode_active(self, story: LiveStoryline, t: datetime,
                       gap_hours: float) -> bool:
        return (story.open_episode_id is not None
                and story.open_episode_newest_at is not None
                and t - story.open_episode_newest_at
                <= timedelta(hours=gap_hours))

    def due_closes(self, t: datetime, gap_hours: float) -> list[LiveStoryline]:
        return [s for s in self._stories.values()
                if s.open_episode_id is not None
                and not self.episode_active(s, t, gap_hours)]

    def mark_closed(self, storyline_id: str) -> None:
        s = self._stories[storyline_id]
        s.open_episode_id = None
        s.open_episode_newest_at = None
        s.open_episode_centroid = None
        s.open_episode_count = 0

    def all(self) -> list[LiveStoryline]:
        return list(self._stories.values())
