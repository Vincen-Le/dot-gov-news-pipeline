"""Stage 3 — cards. Episode card once at close (immutable); overview
compression + rubric in one call, cited timeline validated, rank_key at birth
(inside the insert_event_card RPC)."""

from __future__ import annotations

from pipeline.config import Config
from pipeline.prompts import validate_timeline
from pipeline.vectors import pack_fp16

# event_cards_headline_bounded / event_cards_summary_bounded db check constraints.
_MAX_HEADLINE = 512
_MAX_SUMMARY = 8192


class CardEngine:
    def __init__(self, store, models, cfg: Config) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg
        # Corpus embedding dimension (e.g. 1024 for bge-m3, 256 for the stub
        # bag-of-words embedder). Set by the replay driver (pipeline/runner.py,
        # spine/replay.py) from the first prepared row's stored embedding.
        # None means "unknown" (e.g. a finalize-only invocation with zero new
        # rows) and must never be treated as "trust the embedding" -- the
        # guard below is fail-safe: unverified dimension always skips.
        self.corpus_dim: int | None = None
        # Count of overview embeddings skipped because either corpus_dim is
        # unverified (None) or models.embed() returned a different dimension
        # than corpus_dim -- e.g. a --stub run over a db seeded with real
        # embeddings. storylines.centroid started at corpus_dim
        # (news_entries.embedding); overwriting it with a mismatched vector
        # would corrupt every downstream pairwise cosine (spine/themes.py
        # cluster_storylines). Passing overview_embedding None keeps the
        # existing centroid (insert_event_card does
        # `coalesce(p_overview_embedding, centroid)`).
        self.skipped_overview_embeddings = 0

    def on_episode_closed(self, episode: dict) -> None:
        members = self.store.episode_members(str(episode["id"]))
        originals = [m for m in members if not m["is_syndicated"]] or members
        representative = originals[0]
        syndicated_count = sum(1 for m in members if m["is_syndicated"])
        summary = (representative.get("summary") or representative["title"]).strip()
        suffix = f" (+{syndicated_count} republications)" if syndicated_count else ""
        headline = representative["title"][:_MAX_HEADLINE]
        summary = summary[:_MAX_SUMMARY - len(suffix)] + suffix

        self.store.insert_card(
            storyline_id=str(episode["storyline_id"]), episode_id=str(episode["id"]),
            kind="episode", headline=headline, summary=summary,
            timeline=None, rubric=None, rubric_version=None, interest_reason=None,
            representative_entry_id=str(representative["id"]),
            judge_model=None, prompt_version=self.cfg.prompt_version,
            overview_embedding=None, tau=self.cfg.tau_seconds)

        self._regenerate_overview(str(episode["storyline_id"]),
                                  representative_entry_id=str(representative["id"]))

    def _regenerate_overview(self, storyline_id: str, representative_entry_id: str) -> None:
        episode_cards = self.store.episode_cards_for(storyline_id)
        try:
            card = self.models.compress_overview({"id": storyline_id}, episode_cards)
        except Exception as exc:
            # LLM failure never blocks a close (spec: judge failure -> prior points).
            # Deterministic fallback: latest headline, concatenated chain, cited bullets,
            # rubric None so the card scores the unjudged prior until a future rejudge.
            card = {
                "headline": episode_cards[-1]["headline"],
                "summary": " / ".join(c["headline"] for c in episode_cards),
                "timeline": [{"episode_id": str(c["episode_id"]), "date": c["date"],
                              "text": c["headline"]} for c in episode_cards],
                "rubric": None,
                "reason": f"compressor_error: {exc}",
            }
        card["headline"] = card["headline"][:_MAX_HEADLINE]
        card["summary"] = card["summary"][:_MAX_SUMMARY]
        valid_ids = {str(c["episode_id"]) for c in episode_cards}
        timeline = validate_timeline(card.get("timeline", []), valid_ids)
        overview_vec = self.models.embed([card["summary"]])[0]
        if self.corpus_dim is not None and len(overview_vec) == self.corpus_dim:
            overview_embedding = pack_fp16(overview_vec)
        else:
            self.skipped_overview_embeddings += 1
            overview_embedding = None

        self.store.insert_card(
            storyline_id=storyline_id, episode_id=None, kind="overview",
            headline=card["headline"], summary=card["summary"], timeline=timeline,
            rubric=card["rubric"], rubric_version=self.cfg.rubric_version,
            interest_reason=(card.get("reason") or "")[:2048] or None,
            representative_entry_id=representative_entry_id,
            judge_model=self.cfg.judge_model, prompt_version=self.cfg.prompt_version,
            overview_embedding=overview_embedding, tau=self.cfg.tau_seconds)
