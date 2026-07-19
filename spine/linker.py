"""Spine decision tree: dup -> retrieve -> judge -> act.

Only the content-hash dup attaches without the LLM. The judge sees a
listwise shortlist with time gaps and entity overlap stated as facts
(research amendment #3); category never filters candidates (#4). A master
node (overview card) exists from storyline birth (design requirement).
"""

from __future__ import annotations

from datetime import datetime

from pipeline.vectors import pack_fp16
from spine.index import StorylineIndex

_MAX_HEADLINE = 512
_MAX_SUMMARY = 8192

# DB-facing vocabulary is fixed by CHECK constraints (and, for the null-
# storyline case, a RAISE in the RPC itself) — see
# supabase/migrations/20260718000600_create_storylines_episodes.sql
# (episodes_attach_method_valid, episode_entries_attach_method_valid) and
# 20260718100100_create_clustering_write_rpcs.sql (create_episode_with_storyline).
# Spine's richer observability labels (returned as `method` from
# process_entry, consumed by spine/replay.py and tests/test_spine_linker.py)
# must be translated to the closest legal DB value before hitting an RPC.
# Keep that mapping here, in one place, so no call site re-invents it.
_EPISODE_ATTACH_METHOD = {
    # episodes.attach_method_valid: event_key, entity_candidate,
    # adjudicated_join, new_storyline, consolidation_merge
    "new_storyline_no_candidates": "new_storyline",
    "new_storyline": "new_storyline",
    "judge_new_episode": "adjudicated_join",
}

_ENTRY_ATTACH_METHOD = {
    # episode_entries.attach_method_valid: exact_url, content_hash, near_dup,
    # event_key, centroid_join, entity_community, adjudicated_join,
    # adjudicated_new, new_cluster, consolidation_merge, consolidation_split
    "syndicated_dup": "content_hash",
    "new_storyline_no_candidates": "new_cluster",
    "new_storyline": "adjudicated_new",
    "judge_same_dev": "adjudicated_join",
    "judge_new_episode": "adjudicated_new",
}


class Linker:
    def __init__(self, store, models, cfg, index: StorylineIndex,
                 category_engine) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg
        self.index = index
        self.categories = category_engine

    def process_entry(self, row: dict, vec) -> dict:
        t: datetime = row["published_at"]
        dup = self.store.content_hash_dup(
            row["content_hash"], t, self.cfg.dedupe_window_hours)
        if dup is not None:
            self._attach(row, str(dup["episode_id"]), "syndicated_dup", 1.0,
                         matched=str(dup["id"]), syndicated=True,
                         episode_centroid=None)
            return {"episode_id": str(dup["episode_id"]),
                    "storyline_id": "", "method": "syndicated_dup"}

        candidates = self.index.top_candidates(
            vec, self.cfg.spine_top_k, self.cfg.spine_sim_floor)
        if not candidates:
            return self._new_storyline(row, vec, t, "new_storyline_no_candidates")

        payloads = [self._candidate_payload(s, sim, row, t)
                    for s, sim in candidates]
        verdict = self.models.link_storyline(self._entry_payload(row), payloads)
        match = verdict.get("match")
        if match is None:
            return self._new_storyline(row, vec, t, "new_storyline",
                                       reason=verdict.get("reason"))

        story, sim = candidates[match]
        if verdict.get("same_development") and self.index.episode_active(
                story, t, self.cfg.spine_episode_gap_hours):
            self._attach(row, story.open_episode_id, "judge_same_dev", sim,
                         matched=None, syndicated=False,
                         episode_centroid=pack_fp16(story.open_episode_centroid))
            self.index.add_member(story.id, vec, set(row["entity_set"]), t)
            return {"episode_id": story.open_episode_id,
                    "storyline_id": story.id, "method": "judge_same_dev"}

        # capture before index.new_episode clobbers it: the storyline's
        # current open episode (if any) is being replaced and must be
        # closed by the driver (spine/replay.py), which owns CardEngine.
        replaced_episode_id = story.open_episode_id
        episode_id, _ = self.store.create_episode(
            story.id, _EPISODE_ATTACH_METHOD["judge_new_episode"], sim,
            (verdict.get("reason") or "")[:512] or None,
            self.cfg.adjudicator_model, t)
        self.index.new_episode(story.id, episode_id, vec,
                               set(row["entity_set"]), t)
        self._attach(row, episode_id, "judge_new_episode", sim,
                     matched=None, syndicated=False,
                     episode_centroid=pack_fp16(vec))
        return {"episode_id": episode_id, "storyline_id": story.id,
                "method": "judge_new_episode",
                "replaced_episode_id": replaced_episode_id}

    # -- helpers --------------------------------------------------------

    def _entry_payload(self, row: dict) -> dict:
        return {"title": row["title"], "enriched_text": row.get("enriched_text"),
                "published_at": str(row["published_at"]),
                "entity_set": list(row.get("entity_set") or []),
                "content_hash": row["content_hash"]}

    def _candidate_payload(self, story, sim: float, row: dict,
                           t: datetime) -> dict:
        overview = self.store.latest_overview(story.id) or {}
        gap_hours = round(
            (t - story.newest_entry_at).total_seconds() / 3600, 1)
        shared = sorted(story.entities & set(row.get("entity_set") or []))
        return {"headline": overview.get("headline", ""),
                "summary": overview.get("summary", ""),
                "newest_entry_at": str(story.newest_entry_at),
                "gap_hours": gap_hours, "shared_entities": shared,
                "episode_count": story.episode_count}

    def _new_storyline(self, row: dict, vec, t: datetime, method: str,
                       reason: str | None = None) -> dict:
        attach_reason = reason
        if method == "new_storyline_no_candidates":
            attach_reason = "no_candidates" + (f": {reason}" if reason else "")
        episode_id, storyline_id = self.store.create_episode(
            None, _EPISODE_ATTACH_METHOD[method], None,
            (attach_reason or "")[:512] or None,
            self.cfg.adjudicator_model, t)
        self.index.register(storyline_id, episode_id, vec,
                            set(row["entity_set"]), t)
        self._attach(row, episode_id, method, None, matched=None,
                     syndicated=False, episode_centroid=pack_fp16(vec))
        summary = (row.get("enriched_text") or row.get("summary")
                   or row["title"]).strip()[:_MAX_SUMMARY]
        self.store.insert_card(
            storyline_id=storyline_id, episode_id=None, kind="overview",
            headline=row["title"][:_MAX_HEADLINE], summary=summary,
            timeline=None, rubric=None, rubric_version=None,
            interest_reason="spine_initial_overview",
            representative_entry_id=str(row["id"]),
            judge_model=None, prompt_version=self.cfg.prompt_version,
            overview_embedding=pack_fp16(vec), tau=self.cfg.tau_seconds)
        # category assignment is deferred to the driver's end-of-run batch
        # (spine/replay.py): it never gates linking, and inline LLM calls
        # were the second-largest per-entry cost in the replay loop
        return {"episode_id": episode_id, "storyline_id": storyline_id,
                "method": method}

    def _attach(self, row: dict, episode_id: str, method: str,
                similarity: float | None, matched: str | None,
                syndicated: bool, episode_centroid: bytes | None) -> None:
        self.store.attach_entry(
            str(row["id"]), episode_id, row["agency"], syndicated,
            _ENTRY_ATTACH_METHOD[method],
            similarity, matched, self.cfg.spine_sim_floor,
            self.cfg.embedding_model, episode_centroid, row["published_at"],
            self.cfg.publisher_weight_version)
