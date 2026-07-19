"""Gold-label recall metrics for the eval report.

Both metrics compare a predicted clustering against gold assignments
(`golden_news_entries`: gold_storyline_id for the storyline axis,
gold_theme_id for the theme axis). Items are scored only when present in
BOTH mappings — a partially labeled gold set is expected. Interpretation
guidance lives in `.claude/skills/clustering-eval/scoring.md`
(low recall = fragmentation, the split-biased pipeline's dominant error;
low precision = false merges).
"""

from __future__ import annotations

import math
import random
from collections import defaultdict
from itertools import combinations


def _shared_items(pred: dict[str, str], gold: dict[str, str]) -> list[str]:
    return [item for item in pred if item in gold]


def _f1(precision: float, recall: float) -> float:
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def _pairs(assignments: dict[str, str], items: list[str]) -> set[frozenset]:
    by_cluster: dict[str, list[str]] = defaultdict(list)
    for item in items:
        by_cluster[assignments[item]].append(item)
    return {frozenset(pair)
            for members in by_cluster.values()
            for pair in combinations(members, 2)}


def pairwise_f1(pred: dict[str, str], gold: dict[str, str]) -> dict:
    """Co-membership pair precision/recall/F1 (item_id -> cluster_id maps)."""
    items = _shared_items(pred, gold)
    pred_pairs = _pairs(pred, items)
    gold_pairs = _pairs(gold, items)
    correct = len(pred_pairs & gold_pairs)
    precision = correct / len(pred_pairs) if pred_pairs else 1.0
    recall = correct / len(gold_pairs) if gold_pairs else 1.0
    if not items:
        precision = recall = 0.0
    return {"precision": precision, "recall": recall,
            "f1": _f1(precision, recall), "n_items": len(items)}


def b_cubed(pred: dict[str, str], gold: dict[str, str]) -> dict:
    """B-Cubed precision/recall/F1 — per-item overlap, averaged over items."""
    items = _shared_items(pred, gold)
    if not items:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0, "n_items": 0}
    pred_clusters: dict[str, set[str]] = defaultdict(set)
    gold_clusters: dict[str, set[str]] = defaultdict(set)
    for item in items:
        pred_clusters[pred[item]].add(item)
        gold_clusters[gold[item]].add(item)
    precision_sum = recall_sum = 0.0
    for item in items:
        overlap = len(pred_clusters[pred[item]] & gold_clusters[gold[item]])
        precision_sum += overlap / len(pred_clusters[pred[item]])
        recall_sum += overlap / len(gold_clusters[gold[item]])
    precision = precision_sum / len(items)
    recall = recall_sum / len(items)
    return {"precision": precision, "recall": recall,
            "f1": _f1(precision, recall), "n_items": len(items)}


# --- verdict scoring (R_v2) -------------------------------------------------
# Mechanical scoring of judge verdict CSVs. Formulas are defined in
# .claude/skills/clustering-eval/{scoring,theme_scoring,multi-episode-scoring}.md;
# false merges (misfits, accepted intruders, unfaithful claims) weigh -2.


def _yes(value: str) -> bool:
    value = value.strip().lower()
    # 1/0 is the emission contract (2026-07-19 review); y/n accepted for
    # verdict CSVs written before the switch
    if value not in {"1", "0", "y", "n"}:
        raise ValueError(f"expected 1/0, got {value!r}")
    return value in {"1", "y"}


def weighted_binary(values: list[bool]) -> float:
    if not values:
        raise ValueError("cannot score an empty weighted vector")
    return (sum(values) - 2 * (len(values) - sum(values))) / len(values)


def score_v1(pair_rows: list[dict], chain_rows: list[dict]) -> dict:
    """Chain coherence: pairwise verdicts + drift charge from chain verdicts."""
    values_by_chain: dict[str, list[bool]] = defaultdict(list)
    by_method: dict[str, list[bool]] = defaultdict(list)
    for row in pair_rows:
        value = _yes(row["related"])
        values_by_chain[row["storyline_id"]].append(value)
        by_method[row.get("attach_method") or "(none)"].append(value)

    drifted = 0
    for chain in chain_rows:
        verdict = str(chain.get("chain_verdict") or "").strip().lower()
        endpoints_related = _yes(str(chain.get("endpoints_related") or ""))
        if verdict not in {"coherent", "drifted", "should_split"}:
            raise ValueError(f"invalid chain_verdict {verdict!r}")
        if verdict == "drifted":
            drifted += 1
        failed = not endpoints_related or verdict != "coherent"
        values = values_by_chain.get(chain["storyline_id"], [])
        # drift charge: last link counted unrelated iff no pairwise verdict failed
        if failed and values and all(values):
            values[-1] = False

    values = [v for chain in values_by_chain.values() for v in chain]
    method_precision = {m: sum(v) / len(v) for m, v in by_method.items()}
    worst_method = (min(method_precision, key=method_precision.get)
                    if method_precision else None)
    return {
        "v1_score": weighted_binary(values),
        "v1_n": len(values),
        "v1_method_precision": method_precision,
        "v1_method_worst": (method_precision[worst_method]
                            if worst_method is not None else None),
        "v1_method_worst_name": worst_method,
        "drift_rate": (drifted / len(chain_rows)) if chain_rows else 0.0,
        "per_chain": {sid: weighted_binary(v) for sid, v in values_by_chain.items()},
    }


def score_v2(theme_rows: list[dict], granularity_rows: list[dict],
             intruder_truth: list[dict]) -> dict:
    """Theme membership + planted intruders + granularity, per theme."""
    planted: dict[str, set[str]] = defaultdict(set)
    for row in intruder_truth:
        planted[row["theme_id"]].add(row["storyline_id"])

    granularity = {r["theme_id"]: r["granularity"].strip().lower() for r in granularity_rows}
    members_by_theme: dict[str, list[bool]] = defaultdict(list)
    intruders_by_theme: dict[str, list[bool]] = defaultdict(list)
    for row in theme_rows:
        theme_id, fits = row["theme_id"], _yes(row["fits"])
        if row["storyline_id"] in planted[theme_id]:
            intruders_by_theme[theme_id].append(fits)
        else:
            members_by_theme[theme_id].append(fits)

    if set(members_by_theme) != set(granularity):
        raise ValueError("V2 membership/granularity theme sets differ")

    theme_scores: dict[str, float] = {}
    theme_case_counts: dict[str, int] = {}
    discriminations: list[float] = []
    for theme_id, member_values in members_by_theme.items():
        verdict = granularity[theme_id]
        if verdict not in {"right", "too_granular", "too_broad"}:
            raise ValueError(f"invalid granularity {verdict!r}")
        intruder_values = intruders_by_theme.get(theme_id, [])
        fits = sum(member_values)
        misfits = len(member_values) - fits
        accepted = sum(intruder_values)
        denominator = len(member_values) + len(intruder_values)
        score = ((fits - 2 * misfits - 2 * accepted)
                 / denominator)
        if verdict != "right":
            score -= 0.25
        theme_scores[theme_id] = score
        theme_case_counts[theme_id] = denominator
        if intruder_values:
            fit_rate = fits / len(member_values) if member_values else 0.0
            discriminations.append(fit_rate - accepted / len(intruder_values))

    if not theme_scores:
        raise ValueError("cannot score an empty V2")
    n_intruders = sum(len(v) for v in intruders_by_theme.values())
    return {
        "v2_score": sum(theme_scores.values()) / len(theme_scores),
        "v2_n": sum(len(v) for v in members_by_theme.values()),
        "v2_n_cases": sum(theme_case_counts.values()),
        "v2_n_themes": len(theme_scores),
        "v2_n_intruders": n_intruders,
        "v2_discrimination": (sum(discriminations) / len(discriminations)
                              if discriminations else None),
        "v2_theme_scores": theme_scores,
        "v2_theme_case_counts": theme_case_counts,
        "v2_granularity": granularity,
    }


def score_v3(rows: list[dict]) -> dict:
    allowed = {"correct", "better_option_exists", "ambiguous"}
    verdicts = [str(row["verdict"]).strip().lower() for row in rows]
    if any(verdict not in allowed for verdict in verdicts):
        raise ValueError("invalid V3 verdict")
    if not verdicts:
        raise ValueError("cannot score an empty V3")
    return {
        "v3_score": sum(verdict in {"correct", "ambiguous"}
                        for verdict in verdicts) / len(verdicts),
        "v3_n": len(rows),
    }


def score_v4(rows: list[dict]) -> dict:
    values = [_yes(row["should_merge"]) for row in rows]
    return {
        "v4_merge_pairs": sum(values),
        "v4_candidate_n": len(values),
    }


def score_v5(entity_rows: list[dict], miss_count: int, sampled_count: int,
             stats_rows: list[dict] | None = None) -> dict:
    allowed_kinds = {"entity", "event_key"}
    normalized_rows = [
        (str(row.get("kind") or "").strip().lower(), row)
        for row in entity_rows
    ]
    unexpected_kinds = {kind for kind, _ in normalized_rows} - allowed_kinds
    if unexpected_kinds:
        raise ValueError(f"invalid V5 token kinds: {sorted(unexpected_kinds)}")
    sampled_entity_values = [
        _yes(row["valid"]) for kind, row in normalized_rows
        if kind == "entity"
    ]
    stats_values = [_yes(r["valid"]) for r in (stats_rows or [])]
    entity_values = stats_values + sampled_entity_values
    key_values = [
        _yes(row["valid"]) for kind, row in normalized_rows
        if kind == "event_key"
    ]
    if not entity_values:
        raise ValueError("cannot score V5 without entity-token verdicts")
    return {
        "v5_entity_precision": sum(entity_values) / len(entity_values),
        "v5_entity_n": len(entity_values),
        "v5_entity_stats_n": len(stats_values),
        "v5_sampled_entity_n": len(sampled_entity_values),
        "v5_event_key_validity": (sum(key_values) / len(key_values)) if key_values else None,
        "v5_event_key_n": len(key_values),
        "v5_missed_mean": miss_count / sampled_count if sampled_count else None,
    }


def score_v6(rows: list[dict]) -> dict:
    values = [_yes(r["same_event"]) for r in rows]
    return {"v6_score": weighted_binary(values), "v6_n": len(values)}


_V7_CRITERIA = ("coverage", "faithful", "current", "representative")


def score_v7(rows: list[dict]) -> dict:
    """Overview quality: 4 binary criteria per overview; unfaithful claims weigh -2."""
    passed = faithful_failures = 0
    per_criterion: dict[str, list[bool]] = {c: [] for c in _V7_CRITERIA}
    for row in rows:
        for criterion in _V7_CRITERIA:
            value = _yes(row[criterion])
            per_criterion[criterion].append(value)
            passed += value
            if criterion == "faithful" and not value:
                faithful_failures += 1
    total = len(rows) * len(_V7_CRITERIA)
    if not total:
        raise ValueError("cannot score an empty V7")
    return {
        "v7_score": (passed - 2 * faithful_failures) / total,
        "v7_n": len(rows),
        "v7_criteria": {c: sum(v) / len(v) for c, v in per_criterion.items()},
    }


def reward_v2(scores: dict) -> float:
    """R_v2 = mean(V1,V2,V3,V5,V6,V7) - 0.02 * outstanding merge pairs."""
    vectors = (scores["v1_score"], scores["v2_score"], scores["v3_score"],
               scores["v5_entity_precision"], scores["v6_score"], scores["v7_score"])
    return sum(vectors) / len(vectors) - 0.02 * scores.get("v4_merge_pairs", 0)


def quanta(ns: dict) -> dict:
    """Flipped-verdict quantum per vector, propagated to R_v2 (divide by 6)."""
    theme_n = ns["v2_n_themes"]
    membership_quantum = max(
        3 / case_count / theme_n / 6
        for case_count in ns["v2_theme_case_counts"].values()
    )
    granularity_quantum = 0.25 / theme_n / 6
    return {
        "v1": 3 / ns["v1_n"] / 6,
        "v2": max(membership_quantum, granularity_quantum),
        "v3": 1 / ns["v3_n"] / 6,
        "v4": 0.02,
        "v5": 1 / ns["v5_entity_n"] / 6,
        "v6": 3 / ns["v6_n"] / 6,
        "v7": 3 / (ns["v7_n"] * 4) / 6,
    }


def sample_intruders(candidates: list[tuple[str, float]], k: int,
                     rng: random.Random) -> list[str]:
    """Pick k intruder ids: ceil(k/2) nearest by cosine (hard negatives),
    remainder uniform-random from the rest. candidates = (id, cosine) pairs."""
    ordered = sorted(candidates, key=lambda c: (-c[1], c[0]))
    k = min(k, len(ordered))
    n_hard = math.ceil(k / 2)
    picked = [c[0] for c in ordered[:n_hard]]
    rest = [c[0] for c in ordered[n_hard:]]
    picked += rng.sample(rest, min(k - n_hard, len(rest)))
    return picked
