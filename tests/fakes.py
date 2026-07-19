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
        self.emas: dict[str, float] = {}
        self.themes: dict[str, dict] = {}
        self.categories: dict[str, dict] = {}
        self.touches: list = []

    def entity_emas(self, entities):
        return {e: self.emas.get(e, 0.0) for e in entities}

    def touch_entities(self, tokens, t):
        self.touches.append((tokens, t))
        for token in tokens:
            self.emas[token] = self.emas.get(token, 0.0) + 1.0

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
                     episode_centroid, published_at, publisher_weight_version=1):
        self.attaches.append({"entry_id": entry_id, "episode_id": episode_id,
                              "method": method, "similarity": similarity,
                              "is_syndicated": is_syndicated})
        ep = self.episodes[episode_id]
        entry = self.entries.setdefault(
            entry_id, {"id": entry_id, "entity_set": [], "event_keys": [],
                      "content_hash": None, "published_at": published_at,
                      "embedding": None})
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

    def insert_card(self, storyline_id, episode_id, kind, headline, summary,
                    timeline, rubric, rubric_version, interest_reason,
                    representative_entry_id, judge_model, prompt_version,
                    overview_embedding, tau):
        card = {"storyline_id": storyline_id, "episode_id": episode_id,
                "kind": kind, "headline": headline, "summary": summary,
                "timeline": timeline, "rubric": rubric,
                "rubric_version": rubric_version,
                "interest_reason": interest_reason,
                "representative_entry_id": representative_entry_id,
                "judge_model": judge_model, "prompt_version": prompt_version,
                "overview_embedding": overview_embedding, "tau": tau}
        self.cards.append(card)
        return f"card-{len(self.cards)}"

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

    def episode_members(self, episode_id):
        return [
            {"id": e["id"], "title": e["title"], "summary": e.get("summary"),
             "published_at": e["published_at"], "is_syndicated": False}
            for e in self.entries.values() if e.get("episode_id") == episode_id
        ]

    def latest_overview(self, storyline_id):
        for c in reversed(self.cards):
            if c["storyline_id"] == storyline_id:
                return {"headline": c["headline"], "summary": c["summary"]}
        return None

    def latest_storyline_entry(self, storyline_id):
        members = [
            e for e in self.entries.values()
            if e.get("episode_id") in self.episodes
            and self.episodes[e["episode_id"]]["storyline_id"] == storyline_id
        ]
        if not members:
            return None
        latest = max(members, key=lambda e: e["published_at"])
        return {"id": latest["id"], "title": latest["title"],
                "summary": latest.get("summary")}

    def storylines_for_sweep(self):
        return [
            {"id": s["id"], "centroid": unpack_fp16(s["centroid"]),
             "theme_id": s.get("theme_id"),
             "headline": s.get("headline", "(no card)")}
            for s in self.storylines.values()
            if s.get("merged_into") is None and s.get("centroid") is not None
        ]

    # -- topics ----------------------------------------------------------
    def all_themes(self):
        return [dict(t, centroid=unpack_fp16(t["centroid"]) if t["centroid"] is not None else None)
                for t in self.themes.values()
                if t.get("merged_into") is None and t.get("demoted_at") is None]

    def theme_member_centroids(self, theme_id):
        return [unpack_fp16(s["centroid"]) for s in self.storylines.values()
                if s.get("theme_id") == theme_id and s.get("centroid") is not None]

    def storyline_theme_state(self, storyline_id):
        s = self.storylines.get(storyline_id)
        if s is None:
            return None
        return {"centroid": unpack_fp16(s["centroid"]) if s.get("centroid") is not None else None,
                "theme_id": s.get("theme_id"),
                "category_id": s.get("category_id"),
                "newest_entry_at": s.get("newest_entry_at"),
                "headline": s.get("headline", ""), "summary": s.get("summary", "")}

    def unthemed_storyline_ids(self):
        return [
            s["id"] for s in self.storylines.values()
            if s.get("theme_id") is None and s.get("centroid") is not None
        ]

    def all_categories(self):
        return list(self.categories.values())

    def create_theme(self, display_name, centroid, category_id, name_model,
                     inclusion_criterion):
        theme_id = str(uuid.uuid4())
        self.themes[theme_id] = {"id": theme_id, "display_name": display_name,
                                 "centroid": centroid, "category_id": category_id,
                                 "storyline_count": 0, "merged_into": None,
                                 "demoted_at": None,
                                 "inclusion_criterion": inclusion_criterion,
                                 "newest_storyline_at": None,
                                 "created_at": len(self.themes)}
        return theme_id

    def assign_theme(self, storyline_id, theme_id, method, similarity, reason,
                     theme_centroid, theme_display_name):
        s = self.storylines[storyline_id]
        s.update(theme_id=theme_id, theme_attach_method=method,
                 theme_similarity=similarity, theme_reason=reason)
        theme = self.themes[theme_id]
        if theme_display_name is not None:
            theme["display_name"] = theme_display_name
        if theme_centroid is not None:
            theme["centroid"] = theme_centroid
        for t in self.themes.values():
            t["storyline_count"] = sum(
                1 for x in self.storylines.values() if x.get("theme_id") == t["id"])
        theme["newest_storyline_at"] = max(
            (x.get("newest_entry_at") for x in self.storylines.values()
             if x.get("theme_id") == theme_id
             and x.get("newest_entry_at") is not None),
            default=theme.get("newest_storyline_at"))

    def update_theme(self, theme_id, display_name=None, centroid=None, category_id=None):
        theme = self.themes[theme_id]
        if display_name is not None:
            theme["display_name"] = display_name
        if centroid is not None:
            theme["centroid"] = centroid
        if category_id is not None:
            theme["category_id"] = category_id

    def upsert_category(self, display_name, origin, proposal_reason):
        for cat in self.categories.values():
            if cat["display_name"].casefold() == display_name.casefold():
                return cat["id"]
        cat_id = str(uuid.uuid4())
        self.categories[cat_id] = {"id": cat_id, "display_name": display_name,
                                   "origin": origin}
        return cat_id

    def theme_recent_headlines(self, theme_id, limit=3):
        heads = [s.get("headline", "") for s in self.storylines.values()
                 if s.get("theme_id") == theme_id]
        return list(reversed(heads))[:limit]

    def set_storyline_category(self, storyline_id, category_id, method, reason):
        self.storylines[storyline_id].update(
            category_id=category_id, category_method=method,
            category_reason=reason)

    def demote_theme(self, theme_id):
        for s in self.storylines.values():
            if s.get("theme_id") == theme_id:
                s.update(theme_id=None, theme_attach_method=None,
                         theme_similarity=None,
                         theme_reason=f"demoted from theme {theme_id}")
        self.themes[theme_id].update(demoted_at=True, storyline_count=0)

    def uncategorized_storyline_ids(self):
        return [s["id"] for s in self.storylines.values()
                if s.get("category_id") is None
                and s.get("centroid") is not None]

    def categorized_unthemed(self):
        return [{"id": s["id"], "category_id": s["category_id"],
                 "centroid": unpack_fp16(s["centroid"]),
                 "first_entry_at": s.get("first_entry_at"),
                 "headline": s.get("headline", ""),
                 "summary": s.get("summary", "")}
                for s in self.storylines.values()
                if s.get("theme_id") is None
                and s.get("category_id") is not None
                and s.get("centroid") is not None]

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
