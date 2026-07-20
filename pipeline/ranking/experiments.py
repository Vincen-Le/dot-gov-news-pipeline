"""Reproducible v1 rank experiment calculation and persistence."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
import subprocess
from typing import Any, Iterable
from uuid import UUID, uuid4

from pipeline.golden import _require_local
from pipeline.ranking.contracts import (
    RANK_SYSTEM_V1,
    RankExperimentConfig,
    RankInputV1,
    RankTermsV1,
    canonical_hash,
    canonical_json,
    compute_rank_terms_v1,
)
from pipeline.shared.config import Config


RANK_SYSTEM_V1_ID = UUID("00000000-0000-4000-8000-00000000a001")


@dataclass(frozen=True)
class CalculatedRankRow:
    golden_event_card_id: UUID
    storyline_id: UUID
    category_id: UUID | None
    theme_id: UUID | None
    agency_ids: tuple[str, ...]
    global_position: int
    category_position: int | None
    primary_rank_key: float
    context_hash: str
    rank_input: RankInputV1
    rank_terms: RankTermsV1
    formula_trace: dict[str, Any]
    card_snapshot: dict[str, Any]
    context_snapshot: dict[str, Any]


def _json_value(value: Any) -> Any:
    return json.loads(canonical_json(value))


def _uuid(value: UUID | str | None) -> UUID | None:
    return None if value is None else UUID(str(value))


def _resolved_source_weight(
    agency_ids: Iterable[str], config: RankExperimentConfig
) -> float:
    return max(
        (float(config.publisher_weights.get(agency, 1.0)) for agency in agency_ids),
        default=1.0,
    )


def calculate_rank_rows(
    records: list[dict[str, Any]],
    config: RankExperimentConfig,
    freshness_cutoff_at: datetime,
) -> list[CalculatedRankRow]:
    """Calculate stable global/category positions from frozen golden records."""

    if freshness_cutoff_at.tzinfo is None:
        raise ValueError("rank experiment cutoff must be timezone-aware")
    staged: list[dict[str, Any]] = []
    for record in records:
        agencies = tuple(sorted(set(record["agency_ids"] or ())))
        rank_input = RankInputV1(
            rubric=record.get("rubric"),
            rubric_version=record.get("rubric_version"),
            distinct_agencies=len(agencies),
            distinct_feeds=int(record["distinct_feeds"]),
            source_weight_max=_resolved_source_weight(agencies, config),
            newest_entry_at=record["newest_entry_at"],
            freshness_cutoff_at=freshness_cutoff_at,
            tau_seconds=config.tau_seconds,
            publisher_weight_version=config.publisher_weight_version,
        )
        terms = compute_rank_terms_v1(rank_input, config)
        staged.append({
            **record,
            "agency_ids": agencies,
            "rank_input": rank_input,
            "rank_terms": terms,
            "primary_rank_key": terms.rank_key,
        })

    staged.sort(key=lambda row: (
        -row["primary_rank_key"],
        -row["newest_entry_at"].timestamp(),
        str(row["golden_event_card_id"]),
    ))
    category_counts: dict[UUID, int] = {}
    calculated: list[CalculatedRankRow] = []
    for global_position, row in enumerate(staged, 1):
        category_id = _uuid(row.get("category_id"))
        category_position = None
        if category_id is not None:
            category_position = category_counts.get(category_id, 0) + 1
            category_counts[category_id] = category_position
        rank_input = row["rank_input"]
        rank_terms = row["rank_terms"]
        calculated.append(CalculatedRankRow(
            golden_event_card_id=UUID(str(row["golden_event_card_id"])),
            storyline_id=UUID(str(row["storyline_id"])),
            category_id=category_id,
            theme_id=_uuid(row.get("theme_id")),
            agency_ids=row["agency_ids"],
            global_position=global_position,
            category_position=category_position,
            primary_rank_key=rank_terms.rank_key,
            context_hash=str(row["context_hash"]),
            rank_input=rank_input,
            rank_terms=rank_terms,
            formula_trace={
                "formula_key": RANK_SYSTEM_V1.formula_key,
                "config_hash": config.config_hash,
                "freshness_policy": "min(newest_entry_at, experiment_data_cutoff_at)",
                "ordered_terms": list(RANK_SYSTEM_V1.ordered_term_keys),
                "publisher_weight_version": config.publisher_weight_version,
            },
            card_snapshot=row["card_snapshot"],
            context_snapshot=row["context_snapshot"],
        ))
    return calculated


def _load_config(db, cfg: Config) -> RankExperimentConfig:
    rubric_rows = db.all(
        """
        select criterion, weight
        from public.rubric_weights
        where rubric_version = %(version)s
        order by criterion
        """,
        {"version": cfg.rubric_version},
    )
    if not rubric_rows:
        raise ValueError(f"rubric weight version {cfg.rubric_version} is empty")
    publisher_rows = db.all(
        """
        select publisher_key, weight
        from public.publisher_weights
        where weight_version = %(version)s
        order by publisher_key
        """,
        {"version": cfg.publisher_weight_version},
    )
    return RankExperimentConfig(
        tau_seconds=cfg.tau_seconds,
        publisher_weight_version=cfg.publisher_weight_version,
        rubric_weights={row["criterion"]: float(row["weight"]) for row in rubric_rows},
        publisher_weights={
            row["publisher_key"]: float(row["weight"]) for row in publisher_rows
        },
    )


def _load_golden_records(db) -> list[dict[str, Any]]:
    rows = db.all(
        """
        select card.id as golden_event_card_id, card.storyline_id,
               card.rubric, card.rubric_version, card.newest_entry_at,
               context.event_card_id as context_event_card_id,
               card.source_run_id, context.source_run_id as context_source_run_id,
               context.capture_method,
               context.agency_ids, context.distinct_feeds,
               context.category_id, context.theme_id, context.context_hash,
               context.knowledge_cutoff_at,
               to_jsonb(card) as card_snapshot,
               (to_jsonb(context) - 'captured_at')
               || pg_catalog.jsonb_build_object(
                   'episodes', coalesce((
                       select pg_catalog.jsonb_agg(
                           pg_catalog.jsonb_build_object(
                               'id', episode.id,
                               'first_entry_at', episode.first_entry_at,
                               'newest_entry_at', episode.newest_entry_at,
                               'headline', episode_card.headline,
                               'summary', episode_card.summary
                           ) order by episode.first_entry_at, episode.id
                       )
                       from public.golden_episodes episode
                       left join public.golden_event_cards episode_card
                         on episode_card.episode_id = episode.id
                        and episode_card.kind = 'episode'
                       where episode.id = any(context.episode_ids)
                   ), '[]'::jsonb),
                   'source_entries', coalesce((
                       select pg_catalog.jsonb_agg(
                           pg_catalog.jsonb_build_object(
                               'id', entry.id,
                               'episode_id', membership.episode_id,
                               'title', entry.title,
                               'url', entry.url,
                               'published_at', entry.published_at,
                               'content_hash', entry.content_hash,
                               'is_syndicated', membership.is_syndicated,
                               'agencies', coalesce(publishers.keys, '[]'::jsonb)
                           ) order by entry.published_at, entry.id
                       )
                       from public.news_entries entry
                       left join public.episode_entries membership
                         on membership.entry_id = entry.id
                        and membership.episode_id = any(context.episode_ids)
                       left join lateral (
                           select pg_catalog.jsonb_agg(
                               publisher.publisher_key
                               order by publisher.publisher_key
                           ) as keys
                           from public.news_source_publishers publisher
                           where publisher.news_source_id = entry.news_source_id
                       ) publishers on true
                       where entry.id = any(context.source_entry_ids)
                   ), '[]'::jsonb)
               ) as context_snapshot
        from public.golden_event_cards card
        left join public.golden_event_card_contexts context
          on context.event_card_id = card.id
        where card.kind = 'overview' and card.superseded_by is null
        order by card.storyline_id, card.id
        """
    )
    if not rows:
        raise ValueError("golden corpus has no current overview cards")
    missing = [str(row["golden_event_card_id"]) for row in rows
               if row["context_event_card_id"] is None]
    if missing:
        raise ValueError(
            f"golden corpus has {len(missing)} overview cards without contexts"
        )
    non_exact = [str(row["golden_event_card_id"]) for row in rows
                 if row["capture_method"] not in ("card_birth", "source_run_replay")]
    if non_exact:
        raise ValueError(
            f"golden corpus has {len(non_exact)} fallback contexts; exact replay required"
        )
    lineage_mismatch = [str(row["golden_event_card_id"]) for row in rows
                        if row["context_source_run_id"] != row["source_run_id"]]
    if lineage_mismatch:
        raise ValueError(
            f"golden corpus has {len(lineage_mismatch)} card/context lineage mismatches"
        )
    return rows


def _git_commit() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def create_rank_experiment(
    db,
    cfg: Config,
    name: str,
    *,
    source_run_id: str | None = None,
    code_commit: str | None = None,
    preprocessing_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Calculate, atomically persist, and validate a full v1 experiment."""

    _require_local(db)
    if not name or len(name) > 128:
        raise ValueError("rank experiment name must contain 1-128 characters")
    config = _load_config(db, cfg)
    records = _load_golden_records(db)
    source_runs = {str(row["source_run_id"]) for row in records
                   if row["source_run_id"] is not None}
    if source_run_id is not None:
        if source_runs != {source_run_id}:
            raise ValueError("requested source run does not own the entire golden cohort")
        resolved_source_run = source_run_id
    elif len(source_runs) == 1:
        resolved_source_run = next(iter(source_runs))
    else:
        raise ValueError(
            "full rank experiments require exactly one source run across the golden cohort"
        )

    cutoff = max(row["knowledge_cutoff_at"] for row in records)
    calculated = calculate_rank_rows(records, config, cutoff)
    experiment_id = uuid4()
    started_at = datetime.now(timezone.utc)
    resolved_commit = code_commit or _git_commit()
    preprocessing = preprocessing_config or {}
    data_snapshot_hash = canonical_hash([
        {"card": row["card_snapshot"], "context": row["context_snapshot"]}
        for row in records
    ])
    context_set_hash = canonical_hash(sorted(row["context_hash"] for row in records))
    finished_at = datetime.now(timezone.utc)

    insert_experiment = """
        insert into public.rank_experiments (
            id, rank_system_version_id, name, pipeline_namespace,
            source_run_id, status, validation_profile, config, config_hash,
            preprocessing_config, data_cutoff_at, data_snapshot_hash,
            context_set_hash, code_commit, metrics, started_at, finished_at,
            expected_row_count, cohort_card_ids, cohort_context_hashes
        ) values (
            %(id)s, %(version_id)s, %(name)s, 'simple_v1', %(source_run_id)s,
            'calculated', 'full', %(config)s, %(config_hash)s,
            %(preprocessing)s, %(cutoff)s, %(data_hash)s, %(context_hash)s,
            %(commit)s, %(metrics)s, %(started_at)s, %(finished_at)s,
            %(expected_row_count)s, %(cohort_card_ids)s,
            %(cohort_context_hashes)s
        )
    """
    insert_row = """
        insert into public.snapshot_rank_rows (
            experiment_id, rank_system_version_id, golden_event_card_id,
            storyline_id, category_id, theme_id, agency_ids, global_position,
            category_position, primary_rank_key, context_hash, rank_input,
            rank_input_hash, rank_terms, formula_trace, card_snapshot,
            context_snapshot
        ) values (
            %(experiment_id)s, %(version_id)s, %(card_id)s,
            %(storyline_id)s, %(category_id)s, %(theme_id)s, %(agency_ids)s,
            %(global_position)s, %(category_position)s, %(rank_key)s,
            %(context_hash)s, %(rank_input)s, %(rank_input_hash)s,
            %(rank_terms)s, %(formula_trace)s, %(card_snapshot)s,
            %(context_snapshot)s
        )
    """
    with db.conn.transaction():
        with db.conn.cursor() as cur:
            cur.execute(insert_experiment, {
                "id": experiment_id,
                "version_id": RANK_SYSTEM_V1_ID,
                "name": name,
                "source_run_id": resolved_source_run,
                "config": db.jsonb(_json_value(config)),
                "config_hash": config.config_hash,
                "preprocessing": db.jsonb(preprocessing),
                "cutoff": cutoff,
                "data_hash": data_snapshot_hash,
                "context_hash": context_set_hash,
                "commit": resolved_commit,
                "metrics": db.jsonb({"row_count": len(calculated)}),
                "started_at": started_at,
                "finished_at": finished_at,
                "expected_row_count": len(calculated),
                "cohort_card_ids": [row.golden_event_card_id for row in calculated],
                "cohort_context_hashes": [row.context_hash for row in calculated],
            })
            cur.executemany(insert_row, [{
                "experiment_id": experiment_id,
                "version_id": RANK_SYSTEM_V1_ID,
                "card_id": row.golden_event_card_id,
                "storyline_id": row.storyline_id,
                "category_id": row.category_id,
                "theme_id": row.theme_id,
                "agency_ids": list(row.agency_ids),
                "global_position": row.global_position,
                "category_position": row.category_position,
                "rank_key": row.primary_rank_key,
                "context_hash": row.context_hash,
                "rank_input": db.jsonb(_json_value(row.rank_input)),
                "rank_input_hash": row.rank_input.input_hash,
                "rank_terms": db.jsonb(asdict(row.rank_terms)),
                "formula_trace": db.jsonb(row.formula_trace),
                "card_snapshot": db.jsonb(row.card_snapshot),
                "context_snapshot": db.jsonb(row.context_snapshot),
            } for row in calculated])

    validation = db.rpc("validate_rank_experiment", p_experiment_id=experiment_id)
    return {
        "experiment_id": str(experiment_id),
        "rank_system_version_id": str(RANK_SYSTEM_V1_ID),
        "rows": len(calculated),
        "config_hash": config.config_hash,
        "data_snapshot_hash": data_snapshot_hash,
        "context_set_hash": context_set_hash,
        "validation": validation,
    }


def bootstrap_legacy_rank(db, *, activated_by: str = "legacy-bootstrap") -> dict[str, Any]:
    """Import existing embedded golden keys once, preserving current order.

    This is intentionally not replay-complete and cannot be used as a template
    for later experiments. It keeps the ranking tab stable while prospective
    exact contexts are regenerated.
    """

    _require_local(db)
    existing = db.one(
        """
        select id, rank_system_version_id, status
        from public.rank_experiments
        where validation_profile = 'legacy_import'
        """
    )
    if existing is not None:
        return {
            "experiment_id": str(existing["id"]),
            "rank_system_version_id": str(existing["rank_system_version_id"]),
            "status": existing["status"],
            "existing": True,
        }
    records = db.all(
        """
        select card.id as card_id, card.storyline_id, card.rank_key,
               card.headline, card.newest_entry_at, storyline.first_entry_at,
               storyline.category_id, storyline.theme_id,
               storyline.agency_ids, to_jsonb(card) as card_snapshot
        from public.golden_event_cards card
        join public.golden_storylines storyline on storyline.id = card.storyline_id
        where card.kind = 'overview' and card.superseded_by is null
          and storyline.merged_into is null
        order by card.rank_key desc, storyline.first_entry_at,
                 card.headline, card.id
        """
    )
    if not records:
        raise ValueError("golden corpus has no current overview cards to bootstrap")
    experiment_id = uuid4()
    category_counts: dict[str, int] = {}
    now = datetime.now(timezone.utc)
    config = {"legacy_import": True, "source": "golden_event_cards.rank_key"}
    with db.conn.transaction():
        with db.conn.cursor() as cur:
            cur.execute(
                """
                insert into public.rank_experiments (
                    id, rank_system_version_id, name, pipeline_namespace,
                    status, validation_profile, config, config_hash,
                    preprocessing_config, data_cutoff_at, data_snapshot_hash,
                    context_set_hash, code_commit, metrics, started_at, finished_at
                ) values (
                    %(id)s, %(version)s, 'legacy-import-v1', 'legacy_import',
                    'calculated', 'legacy_import', %(config)s, %(config_hash)s,
                    '{}'::jsonb, %(cutoff)s, 'legacy:golden-event-cards-v1',
                    'legacy:no-context', %(commit)s, %(metrics)s, %(now)s, %(now)s
                )
                """,
                {
                    "id": experiment_id,
                    "version": RANK_SYSTEM_V1_ID,
                    "config": db.jsonb(config),
                    "config_hash": canonical_hash(config),
                    "cutoff": max(row["newest_entry_at"] for row in records),
                    "commit": _git_commit(),
                    "metrics": db.jsonb({"row_count": len(records),
                                         "legacy_import": True}),
                    "now": now,
                },
            )
            inserts = []
            for position, record in enumerate(records, 1):
                category_id = record["category_id"]
                category_position = None
                if category_id is not None:
                    key = str(category_id)
                    category_position = category_counts.get(key, 0) + 1
                    category_counts[key] = category_position
                inserts.append({
                    "experiment": experiment_id,
                    "version": RANK_SYSTEM_V1_ID,
                    "card": record["card_id"],
                    "storyline": record["storyline_id"],
                    "category": category_id,
                    "theme": record["theme_id"],
                    "agencies": record["agency_ids"],
                    "position": position,
                    "category_position": category_position,
                    "rank_key": record["rank_key"],
                    "context_hash": f"legacy:{record['card_id']}",
                    "card_snapshot": db.jsonb(record["card_snapshot"]),
                })
            cur.executemany(
                """
                insert into public.snapshot_rank_rows (
                    experiment_id, rank_system_version_id, golden_event_card_id,
                    storyline_id, category_id, theme_id, agency_ids,
                    global_position, category_position, primary_rank_key,
                    context_hash, card_snapshot
                ) values (
                    %(experiment)s, %(version)s, %(card)s, %(storyline)s,
                    %(category)s, %(theme)s, %(agencies)s, %(position)s,
                    %(category_position)s, %(rank_key)s, %(context_hash)s,
                    %(card_snapshot)s
                )
                """,
                inserts,
            )
    validation = db.rpc("validate_rank_experiment", p_experiment_id=experiment_id)
    if not validation.get("valid"):
        raise RuntimeError(f"legacy bootstrap validation failed: {validation}")
    promotion = db.rpc(
        "promote_golden_rank",
        p_experiment_id=experiment_id,
        p_rank_system_version_id=RANK_SYSTEM_V1_ID,
        p_activated_by=activated_by,
    )
    return {"experiment_id": str(experiment_id), "rows": len(records),
            "validation": validation, "promotion": promotion, "existing": False}
