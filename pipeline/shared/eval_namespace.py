"""Whitelisted database namespaces for independent pipeline evaluations."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class EvalNamespace:
    key: str
    experiment_runs_table: str
    experiment_snapshots_table: str
    annotate_snapshot_rpc: str


EVAL_NAMESPACES = {
    key: EvalNamespace(
        key=key,
        experiment_runs_table=f"{key}_experiment_runs",
        experiment_snapshots_table=f"{key}_experiment_cluster_snapshots",
        annotate_snapshot_rpc=f"{key}_annotate_experiment_cluster_snapshot",
    )
    for key in ("complex_v1", "simple_v1")
}


def get_eval_namespace(key: str) -> EvalNamespace:
    """Resolve a caller-selected namespace without allowing SQL identifiers."""
    try:
        return EVAL_NAMESPACES[key]
    except KeyError as exc:
        choices = ", ".join(sorted(EVAL_NAMESPACES))
        raise ValueError(f"unknown eval pipeline {key!r}; expected one of: {choices}") from exc
