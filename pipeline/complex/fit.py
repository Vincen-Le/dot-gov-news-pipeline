"""Fit rubric weights from audit preference pairs (logistic / Bradley-Terry).

Only rubric weights are tunable: the fixed formula terms (agency, feed,
source, freshness) enter the logit as a fixed offset. Fitting proposes a new
rubric_weights version — it never touches existing versions and never runs
automatically; humans apply it via --write and rerun experiments to compare.
"""

from __future__ import annotations

import csv

import numpy as np

from pipeline.shared.prompts import RUBRIC_CRITERIA

_FIXED_TERMS = ("agency_term", "feed_term", "source_term", "freshness_term")


def _bits(rubric: dict | None) -> np.ndarray:
    rubric = rubric or {}
    return np.array([
        1.0 if str(rubric.get(c, 0)).lower() in ("1", "true") else 0.0
        for c in RUBRIC_CRITERIA])


def load_labels(path: str) -> dict[tuple[str, str, str], str]:
    overrides: dict[tuple[str, str, str], str] = {}
    with open(path) as handle:
        for row in csv.DictReader(handle):
            if row.get("preferred") in ("a", "b"):
                overrides[(row["run_id"], row["storyline_a"],
                           row["storyline_b"])] = row["preferred"]
    return overrides


def load_pairs(db, run_ids: list[str], labels_path: str | None = None) -> list[dict]:
    overrides = load_labels(labels_path) if labels_path else {}
    rows = db.all(
        """
        select p.run_id, p.storyline_a, p.storyline_b, p.llm_prefers,
               sa.rubric as rubric_a, sa.terms as terms_a,
               sb.rubric as rubric_b, sb.terms as terms_b
        from public.rank_audit_pairs p
        join public.rank_snapshots sa
          on sa.run_id = p.run_id and sa.facet_type = p.facet_type
         and sa.facet_key = p.facet_key and sa.position = p.position_a
        join public.rank_snapshots sb
          on sb.run_id = p.run_id and sb.facet_type = p.facet_type
         and sb.facet_key = p.facet_key and sb.position = p.position_b
        where p.run_id = any(%(runs)s::uuid[])
        """,
        {"runs": run_ids})
    pairs = []
    for row in rows:
        verdict = overrides.get(
            (str(row["run_id"]), str(row["storyline_a"]), str(row["storyline_b"])),
            row["llm_prefers"])
        if verdict not in ("a", "b"):
            continue  # inconsistent and unlabeled pairs carry no signal
        offset = sum(float(row["terms_a"][t]) - float(row["terms_b"][t])
                     for t in _FIXED_TERMS)
        pairs.append({"bits_a": _bits(row["rubric_a"]),
                      "bits_b": _bits(row["rubric_b"]),
                      "offset": offset, "verdict": verdict})
    return pairs


def fit_weights(pairs: list[dict], l2: float = 1e-3, lr: float = 0.1,
                iters: int = 2000) -> dict[str, float]:
    x = np.stack([p["bits_a"] - p["bits_b"] for p in pairs])
    offset = np.array([p["offset"] for p in pairs])
    y = np.array([1.0 if p["verdict"] == "a" else 0.0 for p in pairs])
    w = np.zeros(len(RUBRIC_CRITERIA))
    for _ in range(iters):  # deterministic: zero init, full-batch, no shuffling
        prob = 1.0 / (1.0 + np.exp(-(x @ w + offset)))
        grad = x.T @ (prob - y) / len(y) + l2 * w
        w -= lr * grad
    # rubric_weights are non-negative by convention; a negative fit means the
    # criterion anti-predicts preference — clamp and report as 0.
    return {c: round(float(max(0.0, wi)), 4)
            for c, wi in zip(RUBRIC_CRITERIA, w)}


def write_weights(db, weights: dict[str, float]) -> int:
    row = db.one("select coalesce(max(rubric_version), 0) + 1 as v "
                 "from public.rubric_weights")
    version = int(row["v"])
    for criterion, weight in weights.items():
        db.conn.execute(
            "insert into public.rubric_weights (rubric_version, criterion, weight) "
            "values (%(v)s, %(c)s, %(w)s)",
            {"v": version, "c": criterion, "w": weight})
    return version
