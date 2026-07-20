"""Category-relative, neighbor-bounded LLM rank position opinions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pipeline.golden import _require_local
from pipeline.ranking.contracts import canonical_hash
from pipeline.shared.config import Config


@dataclass(frozen=True)
class NeighborVerdict:
    position: int
    target_preferred: bool | None


def derive_position_opinion(
    current_position: int,
    category_size: int,
    verdicts: list[NeighborVerdict],
) -> dict[str, Any]:
    """Convert swap-consistent comparisons into an honest movement bound."""

    if not verdicts:
        return {
            "status": "insufficient_neighbors",
            "direction": "uncertain",
            "suggested_category_position": None,
            "position_delta": None,
        }
    if any(verdict.target_preferred is None for verdict in verdicts):
        return {
            "status": "inconsistent",
            "direction": "uncertain",
            "suggested_category_position": None,
            "position_delta": None,
        }

    above = sorted(
        (v for v in verdicts if v.position < current_position),
        key=lambda v: v.position,
        reverse=True,
    )
    below = sorted(
        (v for v in verdicts if v.position > current_position),
        key=lambda v: v.position,
    )
    up = 0
    for verdict in above:
        if verdict.target_preferred:
            up += 1
        else:
            break
    down = 0
    for verdict in below:
        if verdict.target_preferred is False:
            down += 1
        else:
            break
    if up and down:
        return {
            "status": "inconsistent",
            "direction": "uncertain",
            "suggested_category_position": None,
            "position_delta": None,
        }
    if up:
        destination = current_position - up
        bounded = destination > 1 and len(above) == up
        return {
            "status": "bounded" if bounded else "available",
            "direction": "up",
            "suggested_category_position": None if bounded else destination,
            "position_delta": -up,
        }
    if down:
        destination = current_position + down
        bounded = destination < category_size and len(below) == down
        return {
            "status": "bounded" if bounded else "available",
            "direction": "down",
            "suggested_category_position": None if bounded else destination,
            "position_delta": down,
        }
    return {
        "status": "available",
        "direction": "stay",
        "suggested_category_position": current_position,
        "position_delta": 0,
    }


def _audit_item(row: dict[str, Any], newest_at: str | None) -> dict[str, Any]:
    card = row["card_snapshot"]
    context = row["context_snapshot"]
    return {
        "headline": card.get("headline") or "(no headline)",
        "summary": card.get("summary") or "",
        "agencies": len(row.get("agency_ids") or []),
        "feeds": int(context.get("distinct_feeds") or 0),
        "entries": int(context.get("entry_count") or 0),
        "newest_entry_at": card.get("newest_entry_at"),
        "category_newest_entry_at": newest_at,
    }


def _swap_consistent(models, target: dict, neighbor: dict) -> tuple[bool | None, str]:
    forward = models.compare_rank(target, neighbor)
    reverse = models.compare_rank(neighbor, target)
    if forward["prefers"] == "a" and reverse["prefers"] == "b":
        return True, str(forward.get("reason") or "")
    if forward["prefers"] == "b" and reverse["prefers"] == "a":
        return False, str(forward.get("reason") or "")
    return None, (
        f"position-order inconsistent: forward={forward.get('reason', '')}; "
        f"reverse={reverse.get('reason', '')}"
    )[:2048]


def generate_position_opinions(
    db,
    models,
    cfg: Config,
    experiment_id: str,
) -> dict[str, Any]:
    """Generate immutable opinions for every categorized experiment row."""

    _require_local(db)
    experiment = db.one(
        """
        select id, rank_system_version_id, status, validation_profile
        from public.rank_experiments where id = %(id)s
        """,
        {"id": experiment_id},
    )
    if experiment is None:
        raise ValueError(f"unknown rank experiment {experiment_id}")
    if experiment["status"] not in ("calculated", "validated", "promoted"):
        raise ValueError("rank experiment must be calculated before opinion generation")
    if experiment["validation_profile"] != "full":
        raise ValueError(
            "position opinions require replay-complete rank inputs, not legacy imports"
        )
    rows = db.all(
        """
        select golden_event_card_id, storyline_id, category_id,
               category_position, agency_ids, card_snapshot, context_snapshot
        from public.snapshot_rank_rows
        where experiment_id = %(id)s and category_id is not null
        order by category_id, category_position
        """,
        {"id": experiment_id},
    )
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(str(row["category_id"]), []).append(row)

    inserts: list[dict[str, Any]] = []
    status_counts: dict[str, int] = {}
    for category_id, members in groups.items():
        newest_at = max(
            (str(row["card_snapshot"].get("newest_entry_at")) for row in members
             if row["card_snapshot"].get("newest_entry_at") is not None),
            default=None,
        )
        for index, target in enumerate(members):
            start = max(0, index - cfg.rank_audit_window)
            stop = min(len(members), index + cfg.rank_audit_window + 1)
            neighbors = [row for row in members[start:stop] if row is not target]
            evidence: list[dict[str, Any]] = []
            verdicts: list[NeighborVerdict] = []
            for neighbor in neighbors:
                preferred, reason = _swap_consistent(
                    models,
                    _audit_item(target, newest_at),
                    _audit_item(neighbor, newest_at),
                )
                position = int(neighbor["category_position"])
                verdicts.append(NeighborVerdict(position, preferred))
                evidence.append({
                    "neighbor_card_id": str(neighbor["golden_event_card_id"]),
                    "neighbor_position": position,
                    "target_preferred": preferred,
                    "reason": reason,
                })
            opinion = derive_position_opinion(
                int(target["category_position"]), len(members), verdicts
            )
            status_counts[opinion["status"]] = (
                status_counts.get(opinion["status"], 0) + 1
            )
            input_payload = {
                "experiment_id": experiment_id,
                "target_card_id": str(target["golden_event_card_id"]),
                "neighbors": evidence,
                "judge_model": cfg.audit_model,
                "prompt_version": cfg.prompt_version,
            }
            if opinion["status"] == "available" and opinion["direction"] == "stay":
                reason = "Swap-consistent comparisons support the current category position."
            elif opinion["status"] == "bounded":
                reason = "Every inspected neighbor in that direction should be crossed; the audit window ended."
            elif opinion["status"] == "insufficient_neighbors":
                reason = "The category has no neighboring rows to compare."
            elif opinion["status"] == "inconsistent":
                reason = "At least one comparison changed under presentation-order reversal."
            else:
                reason = "Neighbor comparisons support the suggested category movement."
            inserts.append({
                "experiment_id": experiment_id,
                "version_id": experiment["rank_system_version_id"],
                "card_id": target["golden_event_card_id"],
                "category_id": category_id,
                "current_position": target["category_position"],
                **opinion,
                "reason": reason,
                "neighbor_card_ids": [row["golden_event_card_id"] for row in neighbors],
                "evidence": db.jsonb(evidence),
                "consistent": sum(v.target_preferred is not None for v in verdicts),
                "total": len(verdicts),
                "judge_model": cfg.audit_model,
                "prompt_version": cfg.prompt_version,
                "input_hash": canonical_hash(input_payload),
            })

    with db.conn.transaction():
        with db.conn.cursor() as cur:
            cur.executemany(
                """
                insert into public.rank_position_opinions (
                    experiment_id, rank_system_version_id, golden_event_card_id,
                    category_id, current_category_position,
                    suggested_category_position, position_delta, direction,
                    status, reason, neighbor_card_ids, comparison_evidence,
                    consistent_comparisons, total_comparisons, judge_model,
                    prompt_version, input_hash
                ) values (
                    %(experiment_id)s, %(version_id)s, %(card_id)s,
                    %(category_id)s, %(current_position)s,
                    %(suggested_category_position)s, %(position_delta)s,
                    %(direction)s, %(status)s, %(reason)s,
                    %(neighbor_card_ids)s, %(evidence)s, %(consistent)s,
                    %(total)s, %(judge_model)s, %(prompt_version)s,
                    %(input_hash)s
                )
                """,
                inserts,
            )
    return {"experiment_id": experiment_id, "opinions": len(inserts),
            "statuses": status_counts}
