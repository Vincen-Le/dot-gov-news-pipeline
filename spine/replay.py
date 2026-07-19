"""Spine engine event-time replay driver. Skeleton — full driver in Task 5."""

from __future__ import annotations


def run(store, models, cfg, limit=None, since=None, until=None,
        per_agency=None) -> dict:
    rows = store.prepared_unclustered(limit=limit, since=since, until=until,
                                      per_agency=per_agency)
    return {"engine": "spine", "processed": 0, "episodes_closed": 0,
            "pending": len(rows)}
