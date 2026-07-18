from __future__ import annotations

from datetime import datetime

from psycopg.types.numeric import Float4

from pipeline.db import Db
from pipeline.vectors import unpack_fp16


class Store:
    """All SQL reads + RPC writes behind one seam. Tests use tests/fakes.FakeStore."""

    def __init__(self, db: Db) -> None:
        self.db = db

    # -- writes (RPCs) -------------------------------------------------
    def upsert_news_source(self, canonical_url: str, source_type: str, title: str | None) -> str:
        return self.db.rpc("upsert_news_source", p_canonical_url=canonical_url,
                           p_source_type=source_type, p_title=title)

    def ingest_entry(self, source_id: str, url: str, url_canonical: str, title: str | None,
                     summary: str | None, published_at: datetime, hash_: str,
                     entities: list[str], keys: list[str], extractor_version: int) -> str | None:
        return self.db.rpc("ingest_news_entry", p_news_source_id=source_id, p_url=url,
                           p_url_canonical=url_canonical, p_title=title, p_summary=summary,
                           p_published_at=published_at, p_content_hash=hash_,
                           p_entity_set=entities, p_event_keys=keys,
                           p_extractor_version=extractor_version)

    def update_entry_features(self, entry_id: str, enriched_text: str | None,
                              enricher_version: int | None, embedding: bytes | None,
                              embedding_model: str | None,
                              entity_set: list[str] | None = None,
                              event_keys: list[str] | None = None,
                              extractor_version: int | None = None) -> None:
        self.db.rpc("update_entry_features", p_entry_id=entry_id, p_enriched_text=enriched_text,
                    p_enricher_version=enricher_version, p_embedding=embedding,
                    p_embedding_model=embedding_model, p_entity_set=entity_set,
                    p_event_keys=event_keys, p_extractor_version=extractor_version)

    def create_episode(self, storyline_id: str | None, method: str, similarity: float | None,
                       reason: str | None, model: str | None, t: datetime) -> tuple[str, str]:
        row = self.db.rpc_row(
            "create_episode_with_storyline", p_storyline_id=storyline_id,
            p_attach_method=method,
            p_attach_similarity=Float4(similarity) if similarity is not None else None,
            p_attach_reason=reason, p_adjudicator_model=model, p_event_time=t)
        return str(row["episode_id"]), str(row["storyline_id"])

    def attach_entry(self, entry_id: str, episode_id: str, agency: str, is_syndicated: bool,
                     method: str, similarity: float | None, matched_entry_id: str | None,
                     threshold: float | None, embedding_model: str | None,
                     episode_centroid: bytes | None, published_at: datetime) -> None:
        self.db.rpc(
            "attach_entry_to_episode", p_entry_id=entry_id, p_episode_id=episode_id,
            p_agency=agency, p_is_syndicated=is_syndicated, p_attach_method=method,
            p_similarity=Float4(similarity) if similarity is not None else None,
            p_matched_entry_id=matched_entry_id,
            p_threshold_used=Float4(threshold) if threshold is not None else None,
            p_embedding_model=embedding_model,
            p_episode_centroid=episode_centroid, p_published_at=published_at)

    def close_episode(self, episode_id: str) -> bool:
        return bool(self.db.rpc("close_episode", p_episode_id=episode_id))

    def insert_card(self, storyline_id: str, episode_id: str | None, kind: str, headline: str,
                    summary: str, timeline: list | None, rubric: dict | None,
                    rubric_version: int | None, interest_reason: str | None,
                    representative_entry_id: str | None, judge_model: str | None,
                    prompt_version: int | None, overview_embedding: bytes | None,
                    tau: float) -> str:
        return self.db.rpc(
            "insert_event_card", p_storyline_id=storyline_id, p_episode_id=episode_id,
            p_kind=kind, p_headline=headline, p_summary=summary,
            p_timeline=self.db.jsonb(timeline) if timeline is not None else None,
            p_rubric=self.db.jsonb(rubric) if rubric is not None else None,
            p_rubric_version=rubric_version, p_interest_reason=interest_reason,
            p_representative_entry_id=representative_entry_id, p_judge_model=judge_model,
            p_prompt_version=prompt_version, p_overview_embedding=overview_embedding,
            p_tau=tau)

    # -- reads ----------------------------------------------------------
    def unprocessed_entries(self, batch: int = 500) -> list[dict]:
        return self.db.all(
            """
            select ne.id, ne.news_source_id, ne.url, ne.url_canonical, ne.title, ne.summary,
                   ne.published_at, ne.content_hash, ne.entity_set, ne.event_keys,
                   ne.enriched_text, ne.enricher_version, ne.embedding, ne.extractor_version,
                   split_part(ns.canonical_url, '/', 3) as agency
            from public.news_entries ne
            join public.news_sources ns on ns.id = ne.news_source_id
            where ne.episode_id is null and ne.published_at is not null
            order by ne.published_at, ne.id
            limit %(batch)s
            """,
            {"batch": batch},
        )

    def content_hash_dup(self, hash_: str, t: datetime, window_hours: float) -> dict | None:
        return self.db.one(
            """
            select id, episode_id from public.news_entries
            where content_hash = %(h)s and episode_id is not null
              and published_at > %(t)s - make_interval(hours => %(w)s)
            order by published_at desc limit 1
            """,
            {"h": hash_, "t": t, "w": window_hours},
        )

    def recent_embedded(self, t: datetime, window_hours: float) -> list[dict]:
        rows = self.db.all(
            """
            select id, episode_id, embedding from public.news_entries
            where episode_id is not null and embedding is not null
              and published_at > %(t)s - make_interval(hours => %(w)s)
              and published_at <= %(t)s
            """,
            {"t": t, "w": window_hours},
        )
        return [dict(r, embedding=unpack_fp16(r["embedding"])) for r in rows]

    def open_episodes(self) -> list[dict]:
        rows = self.db.all(
            """
            select id, storyline_id, status, centroid, entity_set, event_keys,
                   entry_count, first_entry_at, newest_entry_at
            from public.episodes where status = 'open'
            order by first_entry_at, newest_entry_at, entity_set, event_keys
            """
        )
        return [dict(r, centroid=unpack_fp16(r["centroid"]) if r["centroid"] is not None else None)
                for r in rows]

    def episode_members(self, episode_id: str) -> list[dict]:
        return self.db.all(
            """
            select ne.id, ne.title, ne.summary, ne.published_at, ee.is_syndicated
            from public.episode_entries ee
            join public.news_entries ne on ne.id = ee.entry_id
            where ee.episode_id = %(e)s
            order by ne.published_at
            """,
            {"e": episode_id},
        )

    def storylines_by_event_keys(self, keys: list[str]) -> list[dict]:
        if not keys:
            return []
        return self._storyline_rows("s.event_keys && %(keys)s::text[]", {"keys": keys})

    def storylines_by_entities(self, entities: list[str]) -> list[dict]:
        if not entities:
            return []
        return self._storyline_rows("s.entity_set && %(ents)s::text[]", {"ents": entities})

    def _storyline_rows(self, where: str, params: dict) -> list[dict]:
        # content-stable order (never id: ids regenerate every replay) so
        # candidate iteration — and replay outcomes — are reproducible
        rows = self.db.all(
            f"""
            select s.id, s.entity_set, s.event_keys, s.centroid, s.episode_count,
                   s.newest_entry_at, s.latest_card_id
            from public.storylines s
            where s.merged_into is null and {where}
            order by s.first_entry_at, s.newest_entry_at, s.entity_set,
                     s.event_keys, s.episode_count, s.entry_count, s.centroid
            """,
            params,
        )
        return [dict(r, centroid=unpack_fp16(r["centroid"]) if r["centroid"] is not None else None)
                for r in rows]

    def entity_emas(self, entities: list[str]) -> dict[str, float]:
        if not entities:
            return {}
        rows = self.db.all(
            "select entity, daily_ema from public.entity_stats where entity = any(%(e)s)",
            {"e": entities},
        )
        return {r["entity"]: float(r["daily_ema"]) for r in rows}

    def latest_overview(self, storyline_id: str) -> dict | None:
        return self.db.one(
            """
            select c.id, c.headline, c.summary from public.event_cards c
            join public.storylines s on s.latest_card_id = c.id
            where s.id = %(s)s
            """,
            {"s": storyline_id},
        )

    def episode_cards_for(self, storyline_id: str) -> list[dict]:
        return self.db.all(
            """
            select c.episode_id, c.headline, c.summary,
                   to_char(c.newest_entry_at, 'YYYY-MM-DD') as date
            from public.event_cards c
            where c.storyline_id = %(s)s and c.kind = 'episode'
            order by c.newest_entry_at
            """,
            {"s": storyline_id},
        )

    def entries_needing_features(self, limit: int | None = None) -> list[dict]:
        return self.db.all(
            """
            select id, title, summary, published_at, enriched_text, enricher_version,
                   entity_set, event_keys
            from public.news_entries
            where embedding is null and published_at is not null
            order by published_at, id
            limit %(limit)s
            """,
            {"limit": limit},
        )

    def prepared_unclustered(self, limit: int | None = None,
                             until: "datetime | None" = None) -> list[dict]:
        return self.db.all(
            """
            select ne.id, ne.news_source_id, ne.title, ne.summary, ne.published_at,
                   ne.content_hash, ne.entity_set, ne.event_keys, ne.embedding,
                   split_part(ns.canonical_url, '/', 3) as agency
            from public.news_entries ne
            join public.news_sources ns on ns.id = ne.news_source_id
            where ne.embedding is not null and ne.episode_id is null
              and ne.published_at is not null
              and (%(until)s::timestamptz is null or ne.published_at <= %(until)s)
            order by ne.published_at, ne.id
            limit %(limit)s
            """,
            {"limit": limit, "until": until},
        )
        return _require_publisher_attribution(rows)

    # -- topics (stage 4) ----------------------------------------------
    def all_themes(self) -> list[dict]:
        rows = self.db.all(
            """
            select id, display_name, centroid, category_id, storyline_count
            from public.topic_themes where merged_into is null
            order by display_name, first_storyline_at, storyline_count, centroid
            """
        )
        return [dict(r, centroid=unpack_fp16(r["centroid"]) if r["centroid"] is not None else None)
                for r in rows]

    def theme_headlines(self, theme_id: str, limit: int = 5) -> list[str]:
        rows = self.db.all(
            """
            select c.headline from public.storylines s
            join public.event_cards c on c.id = s.latest_card_id
            where s.theme_id = %(t)s
            order by s.newest_entry_at desc, c.headline limit %(limit)s
            """,
            {"t": theme_id, "limit": limit},
        )
        return [r["headline"] for r in rows]

    def theme_member_centroids(self, theme_id: str) -> list:
        rows = self.db.all(
            "select centroid from public.storylines "
            "where theme_id = %(t)s and centroid is not null",
            {"t": theme_id},
        )
        return [unpack_fp16(r["centroid"]) for r in rows]

    def storyline_theme_state(self, storyline_id: str) -> dict | None:
        row = self.db.one(
            """
            select s.centroid, s.theme_id, c.headline, c.summary
            from public.storylines s
            left join public.event_cards c on c.id = s.latest_card_id
            where s.id = %(s)s
            """,
            {"s": storyline_id},
        )
        if row is None:
            return None
        return dict(row, centroid=unpack_fp16(row["centroid"])
                    if row["centroid"] is not None else None,
                    theme_id=str(row["theme_id"]) if row["theme_id"] else None)

    def all_categories(self) -> list[dict]:
        return [dict(r, id=str(r["id"]))
                for r in self.db.all(
                    "select id, display_name, origin from public.topic_categories "
                    "order by display_name")]

    def create_theme(self, display_name: str, centroid: bytes,
                     category_id: str | None, name_model: str | None) -> str:
        return str(self.db.rpc("create_topic_theme", p_display_name=display_name,
                               p_centroid=centroid, p_category_id=category_id,
                               p_name_model=name_model))

    def assign_theme(self, storyline_id: str, theme_id: str, method: str,
                     similarity: float | None, reason: str | None,
                     theme_centroid: bytes | None,
                     theme_display_name: str | None) -> None:
        self.db.rpc("assign_storyline_theme", p_storyline_id=storyline_id,
                    p_theme_id=theme_id, p_method=method,
                    p_similarity=Float4(similarity) if similarity is not None else None,
                    p_reason=reason, p_theme_centroid=theme_centroid,
                    p_theme_display_name=theme_display_name)

    def update_theme(self, theme_id: str, display_name: str | None = None,
                     centroid: bytes | None = None,
                     category_id: str | None = None) -> None:
        self.db.rpc("update_topic_theme", p_theme_id=theme_id,
                    p_display_name=display_name, p_centroid=centroid,
                    p_category_id=category_id)

    def upsert_category(self, display_name: str, origin: str,
                        proposal_reason: str | None) -> str:
        return str(self.db.rpc("upsert_topic_category", p_display_name=display_name,
                               p_origin=origin, p_proposal_reason=proposal_reason))
