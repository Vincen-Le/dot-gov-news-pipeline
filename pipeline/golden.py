"""Human-curated chronological anchor tooling.

``golden_news_entries`` is the durable source of truth.  The regular
episode/storyline/theme tables remain a disposable workspace: before every
curation batch (and later, every anchored experiment) reviewed gold rows are
materialized into that workspace with fresh aggregates derived from the
current entry features.
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

import numpy as np

from pipeline.shared.bench import assert_local_dsn, reset_clusters
from pipeline.shared.config import Config
from pipeline.shared.preparation import valid_enrichment
from pipeline.runner import cluster
from pipeline.shared.store import Store
from pipeline.shared.vectors import pack_fp16, running_mean, unpack_fp16

GOLDEN_START = datetime(2025, 7, 1, tzinfo=timezone.utc)
GOLDEN_BEFORE = datetime(2025, 9, 1, tzinfo=timezone.utc)
GOLDEN_BATCH_SIZE = 50
DEFAULT_EXPORT_PATH = "docs/eval/golden-news-entries.jsonl"


class GoldenValidationError(RuntimeError):
    """Raised when a golden operation would make the anchor inconsistent."""


def _require_local(db) -> None:
    assert_local_dsn(db.conn.info.dsn)


def initialize(
    db,
    start: datetime = GOLDEN_START,
    before: datetime = GOLDEN_BEFORE,
    batch_size: int = GOLDEN_BATCH_SIZE,
) -> dict:
    """Freeze the chronological July-August corpus membership into batches."""
    _require_local(db)
    if start >= before:
        raise GoldenValidationError("golden start must be before the exclusive end")
    if batch_size < 1:
        raise GoldenValidationError("golden batch size must be positive")

    existing = db.one(
        "select count(*)::integer as n from public.golden_news_entries")
    if existing is not None and existing["n"] > 0:
        out = status(db)
        out["initialized"] = False
        return out

    with db.conn.transaction():
        db.conn.execute(
            """
            insert into public.golden_news_entries (
                news_entry_id, content_hash_at_review, ordinal, batch_number
            )
            select id, content_hash, ordinal,
                   ((ordinal - 1) / %(batch_size)s) + 1
            from (
                select id, content_hash,
                       row_number() over (order by published_at, id)::integer as ordinal
                from public.news_entries
                where published_at >= %(start)s
                  and published_at < %(before)s
            ) selected
            order by ordinal
            """,
            {"start": start, "before": before, "batch_size": batch_size},
        )

    out = status(db)
    if out["total"] == 0:
        raise GoldenValidationError("no news entries exist in the golden time slice")
    out.update({
        "initialized": True,
        "start": start,
        "before": before,
        "batch_size": batch_size,
    })
    return out


def status(db) -> dict:
    totals = db.one(
        """
        select count(*)::integer as total,
               count(*) filter (where review_status = 'pending')::integer as pending,
               count(*) filter (where review_status = 'proposed')::integer as proposed,
               count(*) filter (where review_status = 'reviewed')::integer as reviewed,
               count(distinct batch_number)::integer as batches,
               min(batch_number) filter (where review_status <> 'reviewed')::integer
                   as next_batch
        from public.golden_news_entries
        """
    )
    date_range = db.one(
        """
        select min(ne.published_at) as first_published_at,
               max(ne.published_at) as last_published_at
        from public.golden_news_entries g
        join public.news_entries ne on ne.id = g.news_entry_id
        """
    )
    batches = db.all(
        """
        select batch_number,
               count(*)::integer as entries,
               count(*) filter (where review_status = 'pending')::integer as pending,
               count(*) filter (where review_status = 'proposed')::integer as proposed,
               count(*) filter (where review_status = 'reviewed')::integer as reviewed
        from public.golden_news_entries
        group by batch_number order by batch_number
        """
    )
    totals = totals or {
        "total": 0, "pending": 0, "proposed": 0,
        "reviewed": 0, "batches": 0, "next_batch": None,
    }
    return {**totals, **(date_range or {}), "batch_status": batches}


def show_batch(db, batch_number: int) -> dict:
    if batch_number < 1:
        raise GoldenValidationError("batch number must be positive")
    rows = db.all(
        """
        select g.ordinal, g.batch_number, g.review_status,
               g.news_entry_id, ne.published_at, ne.title, ne.url,
               nsp.publisher_key as publisher,
               g.gold_episode_id, g.gold_episode_label,
               g.gold_storyline_id, g.gold_storyline_label,
               g.gold_theme_id, g.gold_theme_name,
               g.gold_category_id, tc.display_name as category_name,
               g.is_syndicated, g.notes
        from public.golden_news_entries g
        join public.news_entries ne on ne.id = g.news_entry_id
        left join public.news_source_publishers nsp
          on nsp.news_source_id = ne.news_source_id
        left join public.topic_categories tc on tc.id = g.gold_category_id
        where g.batch_number = %(batch)s
        order by g.ordinal
        """,
        {"batch": batch_number},
    )
    if not rows:
        raise GoldenValidationError(f"golden batch {batch_number} does not exist")
    return {"batch": batch_number, "entries": len(rows), "items": rows}


def _labeled_rows(db, *, batch_number: int | None = None,
                  reviewed_only: bool = False) -> list[dict]:
    status_sql = "and g.review_status = 'reviewed'" if reviewed_only else \
        "and g.review_status in ('proposed', 'reviewed')"
    batch_sql = "and g.batch_number = %(batch)s" if batch_number is not None else ""
    return db.all(
        f"""
        select g.*, ne.content_hash, ne.published_at, ne.title, ne.summary,
               ne.embedding, ne.embedding_model, ne.entity_set, ne.event_keys,
               ne.news_source_id, nsp.publisher_key as agency,
               tc.origin as category_origin
        from public.golden_news_entries g
        join public.news_entries ne on ne.id = g.news_entry_id
        left join public.news_source_publishers nsp
          on nsp.news_source_id = ne.news_source_id
        left join public.topic_categories tc on tc.id = g.gold_category_id
        where true {status_sql} {batch_sql}
        order by g.ordinal
        """,
        {"batch": batch_number} if batch_number is not None else None,
    )


def _required_label_errors(rows: Iterable[dict]) -> list[str]:
    errors: list[str] = []
    # theme is optional (cannot exist before enough storylines accumulate)
    # but must be labeled as a pair — id and name together or not at all
    required = (
        "gold_episode_id", "gold_episode_label",
        "gold_storyline_id", "gold_storyline_label",
        "gold_category_id",
    )
    for row in rows:
        missing = [field for field in required if row.get(field) is None]
        if missing:
            errors.append(
                f"entry {row['news_entry_id']} is missing {', '.join(missing)}")
        if (row.get("gold_theme_id") is None) != (row.get("gold_theme_name") is None):
            errors.append(
                f"entry {row['news_entry_id']} must set gold_theme_id and "
                "gold_theme_name together")
        if row.get("content_hash") != row.get("content_hash_at_review"):
            errors.append(f"entry {row['news_entry_id']} content hash changed")
        if row.get("agency") is None:
            errors.append(f"entry {row['news_entry_id']} has no publisher attribution")
        if row.get("embedding") is None:
            errors.append(f"entry {row['news_entry_id']} has no embedding")
        if row.get("category_origin") != "seed":
            errors.append(
                f"entry {row['news_entry_id']} category must be a seeded category")
    return errors


def _one_parent_errors(rows: Iterable[dict]) -> list[str]:
    errors: list[str] = []

    def require_one(mapping: dict[object, set[object]], relation: str) -> None:
        for child, parents in mapping.items():
            if child is not None and len(parents) != 1:
                errors.append(
                    f"{relation} {child} maps to {len(parents)} parent values")

    episode_storylines: dict[object, set[object]] = defaultdict(set)
    episode_labels: dict[object, set[object]] = defaultdict(set)
    storyline_themes: dict[object, set[object]] = defaultdict(set)
    storyline_labels: dict[object, set[object]] = defaultdict(set)
    theme_categories: dict[object, set[object]] = defaultdict(set)
    theme_names: dict[object, set[object]] = defaultdict(set)
    for row in rows:
        episode_storylines[row.get("gold_episode_id")].add(
            row.get("gold_storyline_id"))
        episode_labels[row.get("gold_episode_id")].add(
            row.get("gold_episode_label"))
        storyline_themes[row.get("gold_storyline_id")].add(
            row.get("gold_theme_id"))
        storyline_labels[row.get("gold_storyline_id")].add(
            row.get("gold_storyline_label"))
        theme_categories[row.get("gold_theme_id")].add(
            row.get("gold_category_id"))
        theme_names[row.get("gold_theme_id")].add(row.get("gold_theme_name"))

    require_one(episode_storylines, "episode")
    require_one(episode_labels, "episode label")
    require_one(storyline_themes, "storyline")
    require_one(storyline_labels, "storyline label")
    require_one(theme_categories, "theme")
    require_one(theme_names, "theme name")
    return errors


def validate(db, *, complete: bool = False) -> dict:
    all_status = status(db)
    rows = _labeled_rows(db)
    errors = _required_label_errors(rows) + _one_parent_errors(rows)
    is_complete = (
        all_status["total"] > 0
        and all_status["reviewed"] == all_status["total"]
    )
    if all_status["total"] == 0:
        errors.append("golden dataset has not been initialized")
    if complete and all_status["total"] > 0 and not is_complete:
        errors.append(
            f"golden dataset has {all_status['total'] - all_status['reviewed']} "
            "unreviewed entries")
    return {
        "valid": not errors,
        "errors": errors,
        "labeled": len(rows),
        "total": all_status["total"],
        "reviewed": all_status["reviewed"],
        "complete": is_complete,
    }


def _require_batch_progress(db, batch_number: int) -> None:
    row = db.one(
        """
        select count(*) filter (
                   where batch_number < %(batch)s and review_status <> 'reviewed'
               )::integer as earlier_unreviewed,
               count(*) filter (where batch_number = %(batch)s)::integer as entries
        from public.golden_news_entries
        """,
        {"batch": batch_number},
    )
    if row is None or row["entries"] == 0:
        raise GoldenValidationError(f"golden batch {batch_number} does not exist")
    if row["earlier_unreviewed"]:
        raise GoldenValidationError(
            f"cannot process batch {batch_number}: earlier batches are not reviewed")


def _invalid_feature_rows(db, batch_number: int | None = None) -> list[dict]:
    batch_sql = "and g.batch_number = %(batch)s" if batch_number is not None else ""
    rows = db.all(
        f"""
        select g.news_entry_id, g.ordinal, g.batch_number, g.review_status,
               ne.enriched_text, ne.embedding
        from public.golden_news_entries g
        join public.news_entries ne on ne.id = g.news_entry_id
        where ne.enriched_text is not null {batch_sql}
        order by g.ordinal
        """,
        {"batch": batch_number} if batch_number is not None else None,
    )
    return [row for row in rows if not valid_enrichment(row["enriched_text"])]


def clear_invalid_features(db, batch_number: int | None = None) -> dict:
    """Clear only reconstructible features with non-semantic enrichment."""
    _require_local(db)
    rows = _invalid_feature_rows(db, batch_number)
    ids = [row["news_entry_id"] for row in rows]
    if not ids:
        return {"cleared": 0, "batches": []}
    with db.conn.transaction():
        db.conn.execute(
            """
            update public.news_entries set
                enriched_text = null, enricher_version = null,
                embedding = null, embedding_model = null
            where id = any(%(ids)s::uuid[])
            """,
            {"ids": ids},
        )
        db.conn.execute(
            """
            update public.golden_news_entries set
                review_status = 'pending',
                gold_episode_id = null, gold_episode_label = null,
                gold_storyline_id = null, gold_storyline_label = null,
                gold_theme_id = null, gold_theme_name = null,
                gold_category_id = null, is_syndicated = false,
                proposed_at = null, reviewed_at = null, updated_at = now()
            where news_entry_id = any(%(ids)s::uuid[])
              and review_status = 'proposed'
            """,
            {"ids": ids},
        )
    return {
        "cleared": len(ids),
        "batches": sorted({row["batch_number"] for row in rows}),
        "ordinals": [row["ordinal"] for row in rows],
    }


def capture_batch(db, batch_number: int) -> dict:
    """Copy the disposable pipeline proposal into the durable review rows."""
    _require_local(db)
    _require_batch_progress(db, batch_number)
    proposals = db.all(
        """
        select g.news_entry_id, ne.episode_id as gold_episode_id,
               ep.storyline_id as gold_storyline_id,
               s.theme_id as gold_theme_id,
               tt.display_name as gold_theme_name,
               case when tc.origin = 'seed' then tt.category_id end as gold_category_id,
               ee.is_syndicated,
               left(coalesce(
                   (select c.headline from public.event_cards c
                    where c.episode_id = ep.id and c.kind = 'episode'
                    order by c.version desc limit 1),
                   (select member.title from public.episode_entries member_link
                    join public.news_entries member on member.id = member_link.entry_id
                    where member_link.episode_id = ep.id
                    order by member.published_at, member.id limit 1),
                   '(untitled episode)'
               ), 512) as gold_episode_label,
               left(coalesce(
                   (select c.headline from public.event_cards c
                    where c.storyline_id = s.id and c.kind = 'overview'
                    order by c.version desc limit 1),
                   (select member.title from public.episodes member_episode
                    join public.episode_entries member_link
                      on member_link.episode_id = member_episode.id
                    join public.news_entries member on member.id = member_link.entry_id
                    where member_episode.storyline_id = s.id
                    order by member.published_at, member.id limit 1),
                   '(untitled storyline)'
               ), 512) as gold_storyline_label
        from public.golden_news_entries g
        join public.news_entries ne on ne.id = g.news_entry_id
        left join public.episodes ep on ep.id = ne.episode_id
        left join public.storylines s on s.id = ep.storyline_id
        left join public.topic_themes tt on tt.id = s.theme_id
        left join public.topic_categories tc on tc.id = tt.category_id
        left join public.episode_entries ee
          on ee.episode_id = ne.episode_id and ee.entry_id = ne.id
        where g.batch_number = %(batch)s
        order by g.ordinal
        """,
        {"batch": batch_number},
    )
    missing = [str(row["news_entry_id"]) for row in proposals
               if row["gold_episode_id"] is None or row["gold_storyline_id"] is None]
    if missing:
        raise GoldenValidationError(
            "batch proposal is incomplete; unclustered entries: " + ", ".join(missing[:5]))

    with db.conn.transaction():
        for row in proposals:
            db.conn.execute(
                """
                update public.golden_news_entries set
                    review_status = 'proposed',
                    gold_episode_id = %(gold_episode_id)s,
                    gold_episode_label = %(gold_episode_label)s,
                    gold_storyline_id = %(gold_storyline_id)s,
                    gold_storyline_label = %(gold_storyline_label)s,
                    gold_theme_id = %(gold_theme_id)s,
                    gold_theme_name = %(gold_theme_name)s,
                    gold_category_id = %(gold_category_id)s,
                    is_syndicated = coalesce(%(is_syndicated)s, false),
                    proposed_at = now(), reviewed_at = null, updated_at = now()
                where news_entry_id = %(news_entry_id)s
                """,
                row,
            )
    return {
        "batch": batch_number,
        "captured": len(proposals),
        "missing_themes": sum(row["gold_theme_id"] is None for row in proposals),
        "missing_categories": sum(row["gold_category_id"] is None for row in proposals),
    }


def _resolve_source_run_id(db, requested: str | None = None):
    """Return the one simple_v1 run whose global cards equal live state."""
    rows = db.all(
        """
        with live_cards as (
            select s.latest_card_id as card_id
            from public.storylines s
            where s.merged_into is null and s.latest_card_id is not null
        )
        select r.id as source_run_id
        from public.simple_v1_experiment_runs r
        where (%(requested)s::uuid is null or r.id = %(requested)s::uuid)
          and exists (select 1 from live_cards)
          and not exists (
              select 1 from live_cards live
              where not exists (
                  select 1 from public.simple_v1_rank_snapshots snapshot
                  where snapshot.run_id = r.id
                    and snapshot.facet_type = 'global'
                    and snapshot.facet_key = ''
                    and snapshot.card_id = live.card_id
              )
          )
          and not exists (
              select 1 from public.simple_v1_rank_snapshots snapshot
              where snapshot.run_id = r.id
                and snapshot.facet_type = 'global'
                and snapshot.facet_key = ''
                and not exists (
                    select 1 from live_cards live
                    where live.card_id = snapshot.card_id
                )
          )
        order by r.created_at desc, r.id
        """,
        {"requested": requested},
    )
    if len(rows) == 1:
        return rows[0]["source_run_id"]
    if requested is not None:
        raise GoldenValidationError(
            f"simple_v1 run {requested} does not exactly match the current "
            "global ranked card set")
    if not rows:
        raise GoldenValidationError(
            "no simple_v1 run exactly matches the current global ranked card "
            "set; snapshot the run before golden promotion")
    raise GoldenValidationError(
        "multiple simple_v1 runs exactly match the current global ranked card "
        "set; pass --source-run explicitly")


def promote_clustered(db, source_run_id: str | None = None) -> dict:
    """Slice-based promotion: freeze the current QAed cluster image as gold.

    Batches (fixed 50-entry windows) do not align with replay slices, so this
    labels every anchor entry that is currently clustered — regardless of
    batch — and marks it reviewed. Category comes from the storyline (the
    surface the reviewer QAs); theme stays null until the theme layer has
    enough storylines to mint one. Call only after human review of the live
    cluster tables.
    """
    _require_local(db)
    source_run_id = _resolve_source_run_id(db, source_run_id)
    proposals = db.all(
        """
        select g.news_entry_id, g.review_status,
               ne.episode_id as gold_episode_id,
               ep.storyline_id as gold_storyline_id,
               s.theme_id as gold_theme_id,
               tt.display_name as gold_theme_name,
               case when tc.origin = 'seed' then s.category_id end
                   as gold_category_id,
               coalesce(ee.is_syndicated, false) as is_syndicated,
               left(coalesce(
                   (select c.headline from public.event_cards c
                    where c.episode_id = ep.id and c.kind = 'episode'
                    order by c.version desc limit 1),
                   ne.title, '(untitled episode)'), 512) as gold_episode_label,
               left(coalesce(
                   (select c.headline from public.event_cards c
                    where c.storyline_id = s.id and c.kind = 'overview'
                    order by c.version desc limit 1),
                   ne.title, '(untitled storyline)'), 512) as gold_storyline_label
        from public.golden_news_entries g
        join public.news_entries ne on ne.id = g.news_entry_id
        join public.episodes ep on ep.id = ne.episode_id
        join public.storylines s on s.id = ep.storyline_id
        left join public.topic_themes tt on tt.id = s.theme_id
        left join public.topic_categories tc on tc.id = s.category_id
        left join public.episode_entries ee
          on ee.episode_id = ne.episode_id and ee.entry_id = ne.id
        order by g.ordinal
        """)
    if not proposals:
        # nothing clustered yet — still refresh the render mirror
        with db.conn.transaction():
            mirrored = _mirror_render_tables(db, source_run_id)
        return {"promoted": 0, "mirrored": mirrored,
                "remaining_unreviewed": status(db)["pending"],
                "source_run_id": str(source_run_id)}
    unseeded = [str(row["news_entry_id"]) for row in proposals
                if row["gold_category_id"] is None]
    if unseeded:
        raise GoldenValidationError(
            "storyline category missing or not a seeded category for entries: "
            + ", ".join(unseeded[:5]))

    promoted = [row for row in proposals if row["review_status"] != "reviewed"]
    with db.conn.transaction():
        for row in proposals:
            # already-reviewed rows only refresh their derived fields — the
            # live surface is the post-QA source of truth and storylines keep
            # evolving across slices (labels, themes); review timestamps stay.
            newly_reviewed = row["review_status"] != "reviewed"
            db.conn.execute(
                f"""
                update public.golden_news_entries set
                    gold_episode_id = %(gold_episode_id)s,
                    gold_episode_label = %(gold_episode_label)s,
                    gold_storyline_id = %(gold_storyline_id)s,
                    gold_storyline_label = %(gold_storyline_label)s,
                    gold_theme_id = %(gold_theme_id)s,
                    gold_theme_name = %(gold_theme_name)s,
                    gold_category_id = %(gold_category_id)s,
                    is_syndicated = %(is_syndicated)s,
                    updated_at = now()
                    {", review_status = 'reviewed', proposed_at = now(), "
                     "reviewed_at = now()" if newly_reviewed else ""}
                where news_entry_id = %(news_entry_id)s
                """,
                row,
            )
        # validate inside the transaction so a bad promotion rolls back whole
        all_rows = _labeled_rows(db, reviewed_only=True)
        errors = _required_label_errors(all_rows) + _one_parent_errors(all_rows)
        if errors:
            raise GoldenValidationError("; ".join(errors[:20]))
        mirrored = _mirror_render_tables(db, source_run_id)
    return {"promoted": len(promoted),
            "refreshed": len(proposals) - len(promoted),
            "themes_labeled": sum(r["gold_theme_id"] is not None for r in proposals),
            "remaining_unreviewed": status(db)["total"] - status(db)["reviewed"],
            "mirrored": mirrored,
            "source_run_id": str(source_run_id)}


_MIRRORED_TABLES = ("topic_categories", "topic_themes", "storylines",
                    "episodes", "event_cards")


def _mirror_render_tables(db, source_run_id) -> dict:
    """Copy the live render surface into its golden_* twins (full rewrite).

    Golden mirrors are a perfect rendition of the QAed production tables —
    a reader can rebuild the dashboard view from golden_* alone. Guard:
    every reviewed gold storyline must still exist live, so a reset/blank
    workspace can never wipe an already-frozen image.
    """
    orphaned = db.one(
        """
        select count(*)::integer as n from public.golden_news_entries g
        where g.review_status = 'reviewed'
          and not exists (select 1 from public.storylines s
                          where s.id = g.gold_storyline_id)
        """)
    if orphaned["n"] > 0:
        raise GoldenValidationError(
            f"live tables are missing {orphaned['n']} reviewed gold "
            "storylines; refusing to overwrite the golden mirror")
    counts = {}
    for table in _MIRRORED_TABLES:
        db.conn.execute(f"delete from public.golden_{table}")
        columns = db.all(
            """
            select live.column_name
            from information_schema.columns live
            join information_schema.columns golden
              on golden.table_schema = 'public'
             and golden.table_name = %(golden_table)s
             and golden.column_name = live.column_name
            where live.table_schema = 'public' and live.table_name = %(table)s
            order by live.ordinal_position
            """,
            {"table": table, "golden_table": f"golden_{table}"},
        )
        names = ", ".join(f'"{row["column_name"]}"' for row in columns)
        if table == "event_cards":
            cursor = db.conn.execute(
                f"insert into public.golden_{table} ({names}, source_run_id) "
                f"select {names}, %(source_run_id)s from public.{table}",
                {"source_run_id": source_run_id},
            )
        else:
            cursor = db.conn.execute(
                f"insert into public.golden_{table} ({names}) "
                f"select {names} from public.{table}")
        counts[table] = cursor.rowcount
    return counts


def approve_batch(db, batch_number: int) -> dict:
    _require_local(db)
    _require_batch_progress(db, batch_number)
    batch_rows = _labeled_rows(db, batch_number=batch_number)
    if not batch_rows:
        raise GoldenValidationError(
            f"batch {batch_number} has no captured proposal to approve")
    if len(batch_rows) != show_batch(db, batch_number)["entries"]:
        raise GoldenValidationError(
            f"batch {batch_number} still contains pending entries")
    all_rows = _labeled_rows(db)
    errors = _required_label_errors(batch_rows) + _one_parent_errors(all_rows)
    if errors:
        raise GoldenValidationError("; ".join(errors[:20]))
    with db.conn.transaction():
        cursor = db.conn.execute(
            """
            update public.golden_news_entries set
                review_status = 'reviewed', reviewed_at = now(), updated_at = now()
            where batch_number = %(batch)s and review_status = 'proposed'
            """,
            {"batch": batch_number},
        )
    return {"batch": batch_number, "reviewed": cursor.rowcount}


def _mean(vectors: list[np.ndarray]) -> np.ndarray:
    if not vectors:
        raise GoldenValidationError("cannot build a centroid from zero vectors")
    return np.mean(np.stack(vectors), axis=0).astype(np.float32)


def apply_reviewed(db, cfg: Config, *, reset: bool = True,
                   include_proposed: bool = False) -> dict:
    """Rebuild disposable clustering state from golden memberships.

    Reviewed rows are the experiment anchor. ``include_proposed`` is a local
    dashboard preview only: it makes corrected, unapproved labels visible
    without changing their review status.
    """
    _require_local(db)
    rows = _labeled_rows(db, reviewed_only=not include_proposed)
    errors = _required_label_errors(rows) + _one_parent_errors(rows)
    if errors:
        raise GoldenValidationError("; ".join(errors[:20]))

    episode_rows: dict[object, list[dict]] = defaultdict(list)
    storyline_rows: dict[object, list[dict]] = defaultdict(list)
    theme_rows: dict[object, list[dict]] = defaultdict(list)
    for row in rows:
        episode_rows[row["gold_episode_id"]].append(row)
        storyline_rows[row["gold_storyline_id"]].append(row)
        # reviewed rows may be unthemed (gold_theme_id null); a null key here
        # would insert a null-id theme row
        if row["gold_theme_id"] is not None:
            theme_rows[row["gold_theme_id"]].append(row)

    cutoff = max((row["published_at"] for row in rows), default=None)
    store = Store(db)
    with db.conn.transaction():
        if reset:
            reset_clusters(db)

        for theme_id, members in theme_rows.items():
            first = members[0]
            db.conn.execute(
                """
                insert into public.topic_themes (
                    id, display_name, category_id, storyline_count,
                    first_storyline_at, newest_storyline_at, name_model
                ) values (
                    %(id)s, %(name)s, %(category)s, 0, null, null, 'golden-human'
                )
                on conflict (id) do nothing
                """,
                {"id": theme_id, "name": first["gold_theme_name"],
                 "category": first["gold_category_id"]},
            )

        episode_count_by_storyline = {
            storyline_id: len({row["gold_episode_id"] for row in members})
            for storyline_id, members in storyline_rows.items()
        }
        for storyline_id, members in storyline_rows.items():
            first = members[0]
            timestamps = [row["published_at"] for row in members]
            db.conn.execute(
                """
                insert into public.storylines (
                    id, topic, cluster_topic, first_entry_at, newest_entry_at,
                    episode_count, theme_id, theme_attach_method, theme_reason,
                    category_id, category_method, category_reason
                ) values (
                    %(id)s, %(topic)s, %(label)s, %(first_at)s, %(newest_at)s,
                    %(episodes)s, %(theme)s, 'new_theme', 'golden reviewed seed',
                    %(category)s, 'manual', 'golden reviewed seed'
                )
                on conflict (id) do nothing
                """,
                {"id": storyline_id, "topic": first["gold_theme_name"],
                 "label": first["gold_storyline_label"],
                 "first_at": min(timestamps), "newest_at": max(timestamps),
                 "episodes": episode_count_by_storyline[storyline_id],
                 "theme": first["gold_theme_id"],
                 "category": first["gold_category_id"]},
            )

        episodes_by_storyline: dict[object, list[tuple[object, list[dict]]]] = defaultdict(list)
        open_episode_ids: set[object] = set()
        for episode_id, members in episode_rows.items():
            episodes_by_storyline[members[0]["gold_storyline_id"]].append(
                (episode_id, members))
        for storyline_id, episodes in episodes_by_storyline.items():
            ordered = sorted(episodes, key=lambda item: min(
                row["published_at"] for row in item[1]))
            for position, (episode_id, members) in enumerate(ordered):
                timestamps = [row["published_at"] for row in members]
                newest = max(timestamps)
                is_open = (
                    cutoff is not None
                    and newest >= cutoff - timedelta(hours=cfg.episode_dormancy_hours)
                )
                if is_open:
                    open_episode_ids.add(episode_id)
                db.conn.execute(
                    """
                    insert into public.episodes (
                        id, storyline_id, status, first_entry_at, newest_entry_at,
                        attach_method, attach_reason
                    ) values (
                        %(id)s, %(storyline)s, %(status)s, %(first_at)s, %(newest_at)s,
                        %(method)s, 'golden reviewed seed'
                    )
                    on conflict (id) do nothing
                    """,
                    {"id": episode_id, "storyline": storyline_id,
                     "status": "open" if is_open else "dormant",
                     "first_at": min(timestamps), "newest_at": newest,
                     "method": "new_storyline" if position == 0
                     else "consolidation_merge"},
                )

        episode_means: dict[object, np.ndarray] = {}
        episode_counts: dict[object, int] = defaultdict(int)
        for row in sorted(rows, key=lambda item: (item["published_at"], item["news_entry_id"])):
            vec = unpack_fp16(row["embedding"])
            episode_id = row["gold_episode_id"]
            mean = running_mean(
                episode_means.get(episode_id), episode_counts[episode_id], vec)
            episode_means[episode_id] = mean
            episode_counts[episode_id] += 1
            store.attach_entry(
                str(row["news_entry_id"]), str(episode_id), row["agency"],
                bool(row["is_syndicated"]), "consolidation_merge",
                None, None, None, row["embedding_model"], pack_fp16(mean),
                row["published_at"],
                publisher_weight_version=cfg.publisher_weight_version,
            )
            store.touch_entities(
                list(row["entity_set"]) + list(row["event_keys"]),
                row["published_at"],
            )

        storyline_centroids: dict[object, np.ndarray] = {}
        for storyline_id, members in storyline_rows.items():
            centroid = _mean([unpack_fp16(row["embedding"]) for row in members])
            storyline_centroids[storyline_id] = centroid
            db.conn.execute(
                """
                update public.storylines
                set centroid = %(centroid)s, cluster_topic = %(label)s,
                    topic = %(theme_name)s
                where id = %(id)s
                """,
                {"centroid": pack_fp16(centroid), "id": storyline_id,
                 "label": members[0]["gold_storyline_label"],
                 "theme_name": members[0]["gold_theme_name"]},
            )

        for theme_id, members in theme_rows.items():
            storyline_ids = sorted({row["gold_storyline_id"] for row in members}, key=str)
            centroid = _mean([storyline_centroids[item] for item in storyline_ids])
            first_at = min(row["published_at"] for row in members)
            newest_at = max(row["published_at"] for row in members)
            db.conn.execute(
                """
                update public.topic_themes set
                    centroid = %(centroid)s,
                    storyline_count = %(count)s,
                    first_storyline_at = %(first_at)s,
                    newest_storyline_at = %(newest_at)s
                where id = %(id)s
                """,
                {"centroid": pack_fp16(centroid), "count": len(storyline_ids),
                 "first_at": first_at, "newest_at": newest_at, "id": theme_id},
            )

        # Deterministic human-label cards keep the dashboard useful after a
        # reset without spending model calls to regenerate text we already
        # curated. The normal pipeline will replace these in later replays.
        for episode_id, members in episode_rows.items():
            # Open episodes may receive more entries in the next batch. Their
            # immutable episode card is created only when the normal runner
            # closes them; pre-creating it would violate the one-card index.
            if episode_id in open_episode_ids:
                continue
            ordered = sorted(
                members, key=lambda row: (row["published_at"], row["news_entry_id"]))
            originals = [row for row in ordered if not row["is_syndicated"]]
            representative = (originals or ordered)[0]
            store.insert_card(
                storyline_id=str(representative["gold_storyline_id"]),
                episode_id=str(episode_id), kind="episode",
                headline=representative["gold_episode_label"],
                summary=(representative.get("summary")
                         or representative["title"])[:8192],
                timeline=None, rubric=None, rubric_version=None,
                interest_reason="golden human label",
                representative_entry_id=str(representative["news_entry_id"]),
                judge_model="golden-human", prompt_version=cfg.prompt_version,
                overview_embedding=None, tau=cfg.tau_seconds,
            )

        for storyline_id, members in storyline_rows.items():
            ordered = sorted(
                members, key=lambda row: (row["published_at"], row["news_entry_id"]))
            representative = ordered[0]
            episode_ids = sorted(
                {row["gold_episode_id"] for row in members},
                key=lambda episode_id: min(
                    row["published_at"] for row in episode_rows[episode_id]),
            )
            timeline = []
            episode_labels = []
            for episode_id in episode_ids:
                episode_members = episode_rows[episode_id]
                first = min(episode_members, key=lambda row: row["published_at"])
                episode_labels.append(first["gold_episode_label"])
                timeline.append({
                    "episode_id": str(episode_id),
                    "date": first["published_at"].date().isoformat(),
                    "text": first["gold_episode_label"],
                })
            store.insert_card(
                storyline_id=str(storyline_id), episode_id=None, kind="overview",
                headline=representative["gold_storyline_label"],
                summary=" / ".join(episode_labels)[:8192],
                timeline=timeline, rubric=None, rubric_version=None,
                interest_reason="golden human label",
                representative_entry_id=str(representative["news_entry_id"]),
                judge_model="golden-human", prompt_version=cfg.prompt_version,
                overview_embedding=pack_fp16(storyline_centroids[storyline_id]),
                tau=cfg.tau_seconds,
            )

    return {
        "materialized_entries": len(rows),
        "episodes": len(episode_rows),
        "storylines": len(storyline_rows),
        "themes": len(theme_rows),
        "through": cutoff,
        "included_proposed": include_proposed,
    }


def run_batch(db, store: Store, models, cfg: Config, batch_number: int) -> dict:
    _require_local(db)
    _require_batch_progress(db, batch_number)
    invalid = _invalid_feature_rows(db, batch_number)
    if invalid:
        ordinals = ", ".join(str(row["ordinal"]) for row in invalid[:10])
        raise GoldenValidationError(
            f"batch {batch_number} has {len(invalid)} entries with invalid "
            f"enrichment (ordinals {ordinals}); run golden repair-features "
            "and prepare them before replay")
    applied = apply_reviewed(db, cfg)
    # Topic labels are part of the required proposal even if the ordinary
    # experiment default has topic generation disabled.
    curation_cfg = replace(cfg, topics_enabled=True)
    report = cluster(
        store, models, curation_cfg, golden_batch=batch_number)
    captured = capture_batch(db, batch_number)
    return {"materialized": applied, "cluster": report, "proposal": captured}


def export_jsonl(db, path: str = DEFAULT_EXPORT_PATH) -> dict:
    rows = db.all(
        """
        select g.news_entry_id, g.content_hash_at_review, g.ordinal,
               g.batch_number, g.review_status, g.gold_episode_id,
               g.gold_episode_label, g.gold_storyline_id,
               g.gold_storyline_label, g.gold_theme_id, g.gold_theme_name,
               g.gold_category_id, g.is_syndicated, g.notes,
               g.proposed_at, g.reviewed_at,
               ne.published_at, ne.title, ne.url
        from public.golden_news_entries g
        join public.news_entries ne on ne.id = g.news_entry_id
        order by g.ordinal
        """
    )
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, default=str, sort_keys=True) + "\n")
    os.replace(temporary, target)
    return {"path": str(target), "exported": len(rows)}
