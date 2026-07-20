"""Render docs/eval/<run>/eval-report.md from score.json (eval step 5).

Human contract (2026-07-19 review): one human-review table — metric, value,
effect — then short observation sections for the two product axes (themes
first, then multi-episode chains). Run-specific notes are appended by hand
after rendering.
"""

from __future__ import annotations

_COHESION_FLOOR = 0.55  # theme_promotion_cohesion_floor — router split point
_FIT_FLOOR = 0.5


def _fmt(value) -> str:
    if value is None:
        return "n/a"
    return f"{value:.3f}" if isinstance(value, float) else str(value)


def _vs_target(value, target: float, higher_is_better: bool = True) -> str:
    if value is None:
        return f"unmeasured (target {target:.2f})"
    ok = value >= target if higher_is_better else value <= target
    return f"{'meets' if ok else 'below'} target {target:.2f}"


def _worst(per_item: dict[str, float], limit: int = 10) -> list[tuple[str, float]]:
    return sorted(per_item.items(), key=lambda kv: kv[1])[:limit]


def _row(metric: str, value: str, effect: str) -> str:
    return f"| {metric} | {value} | {effect} |"


def render_eval_report(score: dict, meta: dict, diagnostics: dict | None = None) -> str:
    run = meta.get("run") or {}
    counts = meta.get("counts") or {}
    recall = score.get("recall") or {}

    lines = [
        f"# Eval report: {run.get('name', '(unknown run)')}",
        "",
        f"- pipeline: {meta.get('pipeline', '(unknown)')} · run id: "
        f"{run.get('id', 'n/a')} · finished: {run.get('finished_at', 'n/a')}",
        f"- judge model: {meta.get('judge_model', 'n/a')} · corpus: "
        f"{counts.get('v1_chains', '?')} chains, {counts.get('v2_themes', '?')} "
        f"themes, {counts.get('v3_pairs', '?')} category pairs, "
        f"{counts.get('v7_overviews', '?')} overviews",
        "",
        "## Human review",
        "",
        "| eval / metric | value | effect |",
        "|---|---|---|",
    ]

    reward = score.get("reward_v2")
    lines.append(_row(
        "R_v2 (reward)", _fmt(reward),
        score.get("reward_v2_note")
        or "mean(V1,V2,V3,V5,V6,V7) − 0.02·merge pairs; the loop's objective"))

    v1, v1_n = score.get("v1_score"), score.get("v1_n", 0)
    lines.append(_row(
        "V1 chain coherence", f"{_fmt(v1)} (n={v1_n})",
        f"{_vs_target(v1, 0.70)}; joins judged unrelated cost −2 — "
        "low value = false merges at attach time"))
    lines.append(_row(
        "V1 drift rate", _fmt(score.get("drift_rate")),
        "share of chains that pass link-by-link but wander overall; "
        "high → chain-level checks needed"))
    if score.get("v1_method_worst_name"):
        lines.append(_row(
            "V1 worst attach method",
            f"{score['v1_method_worst_name']} ({_fmt(score.get('v1_method_worst'))})",
            "attach path contributing the most bad joins"))

    v2, v2_n = score.get("v2_score"), score.get("v2_n", 0)
    lines.append(_row(
        "V2 theme membership",
        f"{_fmt(v2)} (n={v2_n}+{score.get('v2_n_intruders', 0)} intruders)",
        f"{_vs_target(v2, 0.50)}; misfits and accepted intruders cost −2"))
    lines.append(_row(
        "V2 discrimination", _fmt(score.get("v2_discrimination")),
        "fit_rate − intruder accept rate; < 0.40 means judge couldn't "
        "tell members from intruders → V2/V4 weak"))
    lines.append(_row(
        "V3 categorization", f"{_fmt(score.get('v3_score'))} (n={score.get('v3_n', 0)})",
        f"{_vs_target(score.get('v3_score'), 0.90)}; share of storylines "
        "filed under the best available category"))
    lines.append(_row(
        "V4 should-merge pairs",
        f"{score.get('v4_merge_pairs', 0)} of {score.get('v4_candidate_n', 0)} candidates",
        "unmerged near-duplicate themes; each costs 0.02 R"))
    lines.append(_row(
        "V4 singleton-theme rate", _fmt(score.get("v4_singleton_rate")),
        "share of themes with one storyline; high = premature minting"))
    v5 = score.get("v5_entity_precision")
    lines.append(_row(
        "V5 entity precision", f"{_fmt(v5)} (n={score.get('v5_entity_n', 0)})",
        f"{_vs_target(v5, 0.80)}; invalid tokens feed every downstream "
        "join — junk lexicon lever"))
    lines.append(_row(
        "V5 event-key validity",
        f"{_fmt(score.get('v5_event_key_validity'))} (n={score.get('v5_event_key_n', 0)})",
        "share of event keys that are real document/case identifiers"))
    lines.append(_row(
        "V5 missed-salient mean", _fmt(score.get("v5_missed_mean")),
        "salient entities the extractor missed, per entry; recall side of V5"))
    v6, v6_n = score.get("v6_score"), score.get("v6_n", 0)
    lines.append(_row(
        "V6 episode coherence", f"{_fmt(v6)} (n={v6_n})",
        f"{_vs_target(v6, 0.70)}; entries in one episode must be one "
        "event — upstream of every storyline lever"))
    v7 = score.get("v7_score")
    criteria = ", ".join(f"{c}={_fmt(r)}" for c, r in
                         (score.get("v7_criteria") or {}).items())
    lines.append(_row(
        "V7 overview quality", f"{_fmt(v7)} (n={score.get('v7_n', 0)})",
        f"{_vs_target(v7, 0.70)}; per-criterion: {criteria}"))
    lines.append(_row(
        "Gold recall (storyline / theme)",
        f"{_fmt(recall.get('storyline_pairwise_f1'))} / "
        f"{_fmt(recall.get('theme_pairwise_f1'))}",
        recall.get("note") or "low recall = fragmentation; low precision = false merges"))

    if score.get("validity", {}).get("v2_weak"):
        lines += ["",
                  "**VALIDITY FLAG:** V2 discrimination "
                  f"{_fmt(score.get('v2_discrimination'))} — V2/V4 (and R) are "
                  "weak; re-judge before citing this run."]

    # -- Themes ----------------------------------------------------------
    lines += ["", "## Themes — observations", ""]
    theme_scores = score.get("v2_theme_scores") or {}
    if not theme_scores:
        lines.append("- No themes were minted this run.")
    off = {t: g for t, g in (score.get("v2_granularity") or {}).items()
           if g != "right"}
    if off:
        lines.append("- Granularity flags (−0.25 each): "
                     + "; ".join(f"{tid}: {g}" for tid, g in sorted(off.items())))
    cohesion = (diagnostics or {}).get("theme_cohesion") or {}
    if cohesion:
        enrichment = [t for t, c in cohesion.items()
                      if c is not None and c < _COHESION_FLOOR
                      and theme_scores.get(t, 0) >= _FIT_FLOOR]
        relabel = [t for t, c in cohesion.items()
                   if c is not None and c >= _COHESION_FLOOR
                   and theme_scores.get(t, 0) < _FIT_FLOOR]
        if enrichment:
            lines.append(f"- Low cohesion / high judged fit — enrichment lever: {enrichment}")
        if relabel:
            lines.append(f"- High cohesion / low judged fit — relabel/demote lever: {relabel}")

    # -- Multi-episode chains ---------------------------------------------
    lines += ["", "## Multi-episode chains — observations", ""]
    worst_chains = _worst(score.get("per_chain") or {})
    if not worst_chains:
        lines.append("- No multi-episode chains were formed this run.")
    else:
        lines.append("- Worst chains (spot-check ids against artifacts):")
        lines += [f"  - {sid}: {_fmt(s)}" for sid, s in worst_chains]

    lines.append("")
    return "\n".join(lines)
