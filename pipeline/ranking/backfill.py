"""Local-only reconstruction of card-time replay contexts.

The SQL reconstruction function owns temporal membership and rank-parity
checks. This module resolves each card's source-run configuration, invokes the
function idempotently, and returns an auditable report without overwriting any
existing context.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from pipeline.golden import _require_local
from pipeline.shared.config import Config


def _missing_cards(db, limit: int | None) -> list[dict]:
    return db.all(
        """
        select card.id, card.storyline_id, card.kind, card.version,
               card.headline, card.generated_at, card.rank_key
        from public.event_cards card
        left join public.event_card_contexts context
          on context.event_card_id = card.id
        where context.event_card_id is null or context.rank_input is null
        order by card.generated_at, card.storyline_id, card.kind, card.version,
                 card.id
        limit %(limit)s
        """,
        {"limit": limit},
    )


def _source_runs_for_card(db, card_id: str) -> list[dict]:
    """Return only lineage recorded on the card/context itself.

    Snapshot containment is deliberately insufficient: cumulative runs may
    contain cards born during an older run.
    """

    return db.all(
        """
        with recorded as (
            select context.source_run_id as run_id
            from public.event_card_contexts context
            where context.event_card_id = %(card_id)s
              and context.source_run_id is not null
            union
            select golden.source_run_id
            from public.golden_event_cards golden
            where golden.id = %(card_id)s
        ), candidates as (
            select 'simple_v1'::text as pipeline_namespace,
                   recorded.run_id, run.config
            from recorded
            join public.simple_v1_experiment_runs run on run.id = recorded.run_id
            union all
            select 'complex_v1', recorded.run_id, run.config
            from recorded
            join public.complex_v1_experiment_runs run on run.id = recorded.run_id
        )
        select pipeline_namespace, run_id, config
        from candidates
        where run_id is not null
        order by pipeline_namespace, run_id
        """,
        {"card_id": card_id},
    )


def _run_settings(candidate: dict | None, cfg: Config) -> tuple[str | None, int, float]:
    config: dict[str, Any] = (candidate or {}).get("config") or {}
    source_run_id = str(candidate["run_id"]) if candidate else None
    publisher_version = int(
        config.get("publisher_weight_version", cfg.publisher_weight_version)
    )
    tau_seconds = float(config.get("tau_seconds", cfg.tau_seconds))
    return source_run_id, publisher_version, tau_seconds


def backfill_event_card_contexts(
    db,
    cfg: Config,
    *,
    write: bool = False,
    allow_fallback: bool = False,
    limit: int | None = None,
    source_run_id: str | None = None,
) -> dict:
    """Reconstruct missing live contexts and return a row-level receipt.

    Missing membership is diagnostic-only because mutable live tables cannot
    prove historical state. Writes only complete rank receipts for exact,
    pre-existing overview contexts. Fallback persistence is never allowed.
    """

    _require_local(db)
    if allow_fallback:
        raise ValueError(
            "fallback context writes are unsafe; replay/regenerate the source run"
        )
    cards = _missing_cards(db, limit)
    receipts: list[dict] = []
    for card in cards:
        candidates = _source_runs_for_card(db, str(card["id"]))
        if source_run_id is not None:
            candidates = [
                candidate for candidate in candidates
                if str(candidate["run_id"]) == source_run_id
            ]
            if not candidates:
                receipts.append({
                    "card_id": str(card["id"]),
                    "headline": card.get("headline"),
                    "status": "requested_source_run_not_recorded",
                    "written": False,
                })
                continue
        if len(candidates) > 1:
            receipts.append({
                "card_id": str(card["id"]),
                "headline": card.get("headline"),
                "status": "ambiguous_source_run",
                "source_runs": [str(row["run_id"]) for row in candidates],
                "written": False,
            })
            continue

        candidate = candidates[0] if candidates else None
        run_id, publisher_version, tau_seconds = _run_settings(candidate, cfg)
        receipt = db.rpc(
            "backfill_event_card_context",
            p_event_card_id=str(card["id"]),
            p_source_run_id=run_id,
            p_publisher_weight_version=publisher_version,
            p_tau=tau_seconds,
            p_write=write,
            p_allow_fallback=allow_fallback,
        )
        if not isinstance(receipt, dict):
            raise RuntimeError(
                f"context backfill returned an invalid receipt for {card['id']}"
            )
        receipts.append({
            "headline": card.get("headline"),
            "pipeline_namespace": (
                candidate.get("pipeline_namespace") if candidate else None
            ),
            "source_run_id": run_id,
            "publisher_weight_version": publisher_version,
            "tau_seconds": tau_seconds,
            **receipt,
        })

    statuses = Counter(row["status"] for row in receipts)
    return {
        "mode": "write" if write else "dry_run",
        "allow_fallback": allow_fallback,
        "cards_considered": len(cards),
        "written": sum(bool(row.get("written")) for row in receipts),
        "exact": sum(row.get("status") == "exact" for row in receipts),
        "fallback": sum(row.get("status") == "fallback" for row in receipts),
        "statuses": dict(sorted(statuses.items())),
        "rows": receipts,
    }
