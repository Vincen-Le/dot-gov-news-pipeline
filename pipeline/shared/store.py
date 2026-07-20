from __future__ import annotations

from datetime import datetime

from psycopg.types.numeric import Float4

from pipeline.shared.db import Db
from pipeline.shared.vectors import unpack_fp16


def _require_publisher_attribution(rows: list[dict]) -> list[dict]:
    missing = [str(row.get("id")) for row in rows if not row.get("agency")]
    if missing:
        sample = ", ".join(missing[:5])
        raise RuntimeError(
            "publisher attribution is missing or conflicting for news entries: "
            f"{sample}"
        )
    return rows


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
                     episode_centroid: bytes | None, published_at: datetime,
                     publisher_weight_version: int = 1) -> None:
        self.db.rpc(
            "attach_entry_to_episode", p_entry_id=entry_id, p_episode_id=episode_id,
            p_agency=agency, p_is_syndicated=is_syndicated, p_attach_method=method,
            p_similarity=Float4(similarity) if similarity is not None else None,
            p_matched_entry_id=matched_entry_id,
            p_threshold_used=Float4(threshold) if threshold is not None else None,
            p_embedding_model=embedding_model,
            p_episode_centroid=episode_centroid, p_published_at=published_at,
            p_publisher_weight_version=publisher_weight_version)

    def touch_entities(self, tokens: list[str], t: datetime) -> None:
        if tokens:
            self.db.rpc("touch_entity_stats", p_tokens=tokens, p_event_time=t)

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
        rows = self.db.all(
            """
            select ne.id, ne.news_source_id, ne.url, ne.url_canonical, ne.title,
                   ne.summary, ne.body_text,
                   ne.published_at, ne.content_hash, ne.entity_set, ne.event_keys,
                   ne.enriched_text, ne.enricher_version, ne.embedding, ne.extractor_version,
                   nsp.publisher_key as agency
            from public.news_entries ne
            left join public.news_source_publishers nsp
              on nsp.news_source_id = ne.news_source_id
            where ne.episode_id is null and ne.published_at is not null
            order by ne.published_at, ne.id
            limit %(batch)s
            """,
            {"batch": batch},
        )
        return _require_publisher_attribution(rows)

    def content_hash_dup(self, hash_: str, t: datetime, window_hours: float) -> dict | None:
        return self.db.one(
            """
            select id, episode_id from public.news_entries
            where content_hash = %(h)s and episode_id is not null
              and published_at > %(t)s
                  - (%(w)s::double precision * interval '1 hour')
            order by published_at desc limit 1
            """,
            {"h": hash_, "t": t, "w": window_hours},
        )

    def recent_embedded(self, t: datetime, window_hours: float) -> list[dict]:
        rows = self.db.all(
            """
            select id, episode_id, embedding from public.news_entries
            where episode_id is not null and embedding is not null
              and published_at > %(t)s
                  - (%(w)s::double precision * interval '1 hour')
              and published_at <= %(t)s
            """,
            {"t": t, "w": window_hours},
        )
        return [dict(r, embedding=unpack_fp16(r["embedding"])) for r in rows]

    def clustered_window_before(self, t: datetime, entry_id: str,
                                window_hours: float) -> list[dict]:
        """Entries immediately preceding a resumed replay batch.

        ReplayWindow normally fills while one cluster invocation runs. Golden
        curation intentionally pauses every 50 rows, so a resumed invocation
        must restore the prior 72-hour tail or dedupe behavior changes at each
        artificial batch boundary.
        """
        rows = self.db.all(
            """
            select id, episode_id, content_hash, published_at, embedding
            from public.news_entries
            where episode_id is not null and embedding is not null
              and published_at > %(t)s
                  - (%(w)s::double precision * interval '1 hour')
              and (published_at < %(t)s
                   or (published_at = %(t)s and id < %(id)s::uuid))
            order by published_at, id
            """,
            {"t": t, "id": entry_id, "w": window_hours},
        )
        return [dict(row, embedding=unpack_fp16(row["embedding"])) for row in rows]

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

    def storylines_for_sweep(self) -> list[dict]:
        rows = self.db.all(
            """
            select s.id, s.centroid, s.theme_id,
                   coalesce(c.headline, '(no card)') as headline
            from public.storylines s
            left join public.event_cards c on c.id = s.latest_card_id
            where s.merged_into is null and s.centroid is not null
            order by s.first_entry_at, s.newest_entry_at, s.entity_set,
                     s.event_keys, s.centroid
            """
        )
        return [dict(r, centroid=unpack_fp16(r["centroid"])) for r in rows]

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

    def latest_storyline_entry(self, storyline_id: str) -> dict | None:
        return self.db.one(
            """
            select ne.id, ne.title, ne.summary
            from public.episodes e
            join public.episode_entries ee on ee.episode_id = e.id
            join public.news_entries ne on ne.id = ee.entry_id
            where e.storyline_id = %(s)s
            order by ne.published_at desc, ee.attached_at desc
            limit 1
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

    def entries_needing_features(self, limit: int | None = None,
                                 per_agency: int | None = None,
                                 agencies: list[str] | None = None) -> list[dict]:
        params = {"limit": limit, "agencies": agencies}
        if per_agency is None:
            return self.db.all(
                """
                select ne.id, ne.title, ne.summary, ne.body_text,
                       ne.published_at, ne.enriched_text, ne.enricher_version,
                       ne.entity_set, ne.event_keys
                from public.news_entries ne
                join public.news_source_publishers nsp
                  on nsp.news_source_id = ne.news_source_id
                where ne.embedding is null and ne.published_at is not null
                  and (%(agencies)s::text[] is null
                       or nsp.publisher_key = any(%(agencies)s::text[]))
                order by ne.published_at, ne.id
                limit %(limit)s
                """,
                params,
            )
        return self.db.all(
            """
            select id, title, summary, body_text, published_at, enriched_text,
                   enricher_version, entity_set, event_keys
            from (
                select ne.id, ne.title, ne.summary, ne.body_text, ne.published_at,
                       ne.enriched_text, ne.enricher_version, ne.entity_set,
                       ne.event_keys,
                       row_number() over (
                           partition by nsp.publisher_key
                           order by ne.published_at, ne.id
                       ) as agency_rank
                from public.news_entries ne
                join public.news_source_publishers nsp
                  on nsp.news_source_id = ne.news_source_id
                where ne.embedding is null and ne.published_at is not null
                  and (%(agencies)s::text[] is null
                       or nsp.publisher_key = any(%(agencies)s::text[]))
            ) ranked
            where agency_rank <= %(per_agency)s
            order by published_at, id
            limit %(limit)s
            """,
            {**params, "per_agency": per_agency},
        )

    def entries_needing_reextraction(self, version: int,
                                     limit: int | None = None) -> list[dict]:
        return self.db.all(
            """
            select id, title, summary, body_text
            from public.news_entries
            where extractor_version is null or extractor_version < %(v)s
            order by published_at, id
            limit %(limit)s
            """,
            {"v": version, "limit": limit},
        )

    def prepared_unclustered(self, limit: int | None = None,
                             since: "datetime | None" = None,
                             until: "datetime | None" = None,
                             per_agency: int | None = None,
                             topology_label_set_id: str | None = None,
                             multi_episode_percent: float | None = None,
                             multi_entry_single_episode_percent: float = 0.0,
                             topology_seed: str = "default",
                             golden_batch: int | None = None) -> list[dict]:
        if golden_batch is not None:
            if any((limit is not None, per_agency is not None,
                    topology_label_set_id is not None,
                    multi_episode_percent is not None,
                    multi_entry_single_episode_percent != 0.0,
                    since is not None, until is not None)):
                raise ValueError(
                    "golden batch selection cannot be combined with other input filters")
            rows = self.db.all(
                """
                select ne.id, ne.news_source_id, ne.title, ne.summary,
                       ne.body_text, ne.published_at, ne.content_hash,
                       ne.entity_set, ne.event_keys, ne.embedding,
                       nsp.publisher_key as agency
                from public.golden_news_entries golden
                join public.news_entries ne on ne.id = golden.news_entry_id
                left join public.news_source_publishers nsp
                  on nsp.news_source_id = ne.news_source_id
                where golden.batch_number = %(batch)s
                  and golden.review_status in ('pending', 'proposed')
                  and ne.embedding is not null and ne.episode_id is null
                order by golden.ordinal
                """,
                {"batch": golden_batch},
            )
            return _require_publisher_attribution(rows)
        if topology_label_set_id is not None:
            if limit is None:
                raise ValueError("topology curation requires a finite limit")
            if multi_episode_percent is None:
                raise ValueError(
                    "topology curation requires multi_episode_percent")
            if per_agency is not None:
                raise ValueError(
                    "topology curation and per_agency cannot be combined")
            if since is not None:
                raise ValueError(
                    "topology curation and since cannot be combined")
            rows = self.db.all(
                """
                select ne.id, ne.news_source_id, ne.title, ne.summary,
                       ne.body_text, ne.published_at, ne.content_hash,
                       ne.entity_set, ne.event_keys, ne.embedding,
                       nsp.publisher_key as agency,
                       curated.topology_class as expected_topology_class,
                       curated.proposed_storyline_key,
                       curated.proposed_episode_key,
                       curated.storyline_entry_count as expected_storyline_entry_count,
                       curated.storyline_episode_count as expected_storyline_episode_count,
                       curated.episode_entry_count as expected_episode_entry_count,
                       curated.is_multi_entry_episode as expected_multi_entry_episode
                from public.curate_news_entry_dataset_by_storyline_topology(
                    %(label_set_id)s::uuid,
                    %(limit)s::integer,
                    %(multi_episode_percent)s::numeric,
                    %(multi_entry_percent)s::numeric,
                    %(seed)s::text,
                    null::uuid[],
                    true,
                    true,
                    %(until)s::timestamptz
                ) curated
                join public.news_entries ne on ne.id = curated.news_entry_id
                left join public.news_source_publishers nsp
                  on nsp.news_source_id = ne.news_source_id
                order by ne.published_at, ne.id
                """,
                {
                    "label_set_id": topology_label_set_id,
                    "limit": limit,
                    "multi_episode_percent": multi_episode_percent,
                    "multi_entry_percent": multi_entry_single_episode_percent,
                    "seed": topology_seed,
                    "until": until,
                },
            )
            return _require_publisher_attribution(rows)
        if multi_episode_percent is not None:
            raise ValueError(
                "multi_episode_percent requires topology_label_set_id")
        if per_agency is None:
            rows = self.db.all(
                """
                select ne.id, ne.news_source_id, ne.title, ne.summary,
                       ne.body_text, ne.published_at,
                       ne.content_hash, ne.entity_set, ne.event_keys, ne.embedding,
                       nsp.publisher_key as agency
                from public.news_entries ne
                left join public.news_source_publishers nsp
                  on nsp.news_source_id = ne.news_source_id
                where ne.embedding is not null and ne.episode_id is null
                  and ne.published_at is not null
                  and (%(since)s::timestamptz is null or ne.published_at >= %(since)s)
                  and (%(until)s::timestamptz is null or ne.published_at <= %(until)s)
                order by ne.published_at, ne.id
                limit %(limit)s
                """,
                {"limit": limit, "since": since, "until": until},
            )
            return _require_publisher_attribution(rows)
        # balanced sample: walk newest -> oldest capping each agency at
        # per_agency until limit entries are picked; replay itself runs asc
        rows = self.db.all(
            """
            select id, news_source_id, title, summary, body_text, published_at,
                   content_hash, entity_set, event_keys, embedding, agency
            from (
                select * from (
                    select ne.id, ne.news_source_id, ne.title, ne.summary,
                           ne.body_text, ne.published_at, ne.content_hash,
                           ne.entity_set, ne.event_keys, ne.embedding,
                           nsp.publisher_key as agency,
                           row_number() over (
                               partition by nsp.publisher_key
                               order by ne.published_at desc, ne.id desc
                           ) as agency_rank
                    from public.news_entries ne
                    left join public.news_source_publishers nsp
                      on nsp.news_source_id = ne.news_source_id
                    where ne.embedding is not null and ne.episode_id is null
                      and ne.published_at is not null
                      and (%(since)s::timestamptz is null
                           or ne.published_at >= %(since)s)
                      and (%(until)s::timestamptz is null or ne.published_at <= %(until)s)
                ) ranked
                where agency_rank <= %(per_agency)s
                order by published_at desc, id desc
                limit %(limit)s
            ) picked
            order by published_at, id
            """,
            {"limit": limit, "since": since, "until": until,
             "per_agency": per_agency},
        )
        return _require_publisher_attribution(rows)

    # -- topics (stage 4) ----------------------------------------------
    def manual_theme_ids(self) -> set[str]:
        """Human-curated themes (golden QA) — exempt from sweep demotion."""
        rows = self.db.all(
            """
            select id from public.topic_themes
            where merged_into is null and name_model = 'golden-human'
            """)
        return {str(row["id"]) for row in rows}

    def all_themes(self) -> list[dict]:
        rows = self.db.all(
            """
            select id, display_name, centroid, category_id, storyline_count,
                   inclusion_criterion, newest_storyline_at, created_at
            from public.topic_themes
            where merged_into is null and demoted_at is null
            order by display_name, first_storyline_at, storyline_count, centroid
            """
        )
        return [dict(r, centroid=unpack_fp16(r["centroid"]) if r["centroid"] is not None else None)
                for r in rows]

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
            select s.centroid, s.theme_id, s.category_id, s.newest_entry_at,
                   c.headline, c.summary
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
                    theme_id=str(row["theme_id"]) if row["theme_id"] else None,
                    category_id=str(row["category_id"])
                    if row["category_id"] else None)

    def unthemed_storyline_ids(self) -> list[str]:
        return [
            str(r["id"]) for r in self.db.all(
                "select id from public.storylines "
                "where merged_into is null and theme_id is null and centroid is not null "
                "order by first_entry_at, id")
        ]

    def theme_recent_headlines(self, theme_id: str, limit: int = 3) -> list[str]:
        rows = self.db.all(
            """
            select c.headline from public.storylines s
            join public.event_cards c on c.id = s.latest_card_id
            where s.theme_id = %(t)s and s.merged_into is null
            order by s.newest_entry_at desc nulls last
            limit %(n)s
            """,
            {"t": theme_id, "n": limit},
        )
        return [r["headline"] for r in rows]

    def all_categories(self) -> list[dict]:
        return [dict(r, id=str(r["id"]))
                for r in self.db.all(
                    "select id, display_name, origin from public.topic_categories "
                    "order by display_name")]

    def create_theme(self, display_name: str, centroid: bytes,
                     category_id: str | None, name_model: str | None,
                     inclusion_criterion: str | None) -> str:
        return str(self.db.rpc("create_topic_theme", p_display_name=display_name,
                               p_centroid=centroid, p_category_id=category_id,
                               p_name_model=name_model,
                               p_inclusion_criterion=inclusion_criterion))

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

    def set_storyline_category(self, storyline_id: str, category_id: str,
                               method: str, reason: str | None) -> None:
        self.db.rpc("set_storyline_category", p_storyline_id=storyline_id,
                    p_category_id=category_id, p_method=method, p_reason=reason)

    def demote_theme(self, theme_id: str) -> None:
        self.db.rpc("demote_topic_theme", p_theme_id=theme_id)

    def uncategorized_storyline_ids(self) -> list[str]:
        return [
            str(r["id"]) for r in self.db.all(
                "select id from public.storylines "
                "where merged_into is null and category_id is null "
                "and centroid is not null "
                "order by first_entry_at, id")
        ]

    def categorized_unthemed(self) -> list[dict]:
        rows = self.db.all(
            """
            select s.id, s.category_id, s.centroid, s.first_entry_at,
                   c.headline, c.summary
            from public.storylines s
            left join public.event_cards c on c.id = s.latest_card_id
            where s.merged_into is null and s.theme_id is null
              and s.category_id is not null and s.centroid is not null
            order by s.first_entry_at, s.id
            """
        )
        return [dict(r, id=str(r["id"]), category_id=str(r["category_id"]),
                     centroid=unpack_fp16(r["centroid"])) for r in rows]
