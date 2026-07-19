"""Render docs/eval/<run>/eval-report.md from score.json (eval step 5).

Human contract (scoring.md § Per-run eval report): every metric line carries
value, n, what strong/weak means, and the first lever to pull. A number a
human cannot act on from the report alone does not belong here.
"""

from __future__ import annotations

_COHESION_FLOOR = 0.55  # theme_promotion_cohesion_floor — router split point
_FIT_FLOOR = 0.5


def _fmt(value) -> str:
    if value is None:
        return "n/a"
    return f"{value:.3f}" if isinstance(value, float) else str(value)


def _worst(per_item: dict[str, float], limit: int = 10) -> list[tuple[str, float]]:
    return sorted(per_item.items(), key=lambda kv: kv[1])[:limit]


def render_eval_report(score: dict, meta: dict, diagnostics: dict | None = None) -> str:
    run = meta.get("run") or {}
    counts = meta.get("counts") or {}
    lines = [
        f"# Eval report: {run.get('name', '(unknown run)')}",
        "",
        f"- pipeline: {meta.get('pipeline', '(unknown)')}",
        f"- run id: {run.get('id', 'n/a')}  finished: {run.get('finished_at', 'n/a')}",
        f"- judge model: {meta.get('judge_model', 'n/a')}",
        f"- corpus: {counts.get('v1_chains', '?')} chains, "
        f"{counts.get('v2_themes', '?')} themes, {counts.get('v3_pairs', '?')} "
        f"category pairs, {counts.get('v7_overviews', '?')} overviews",
        "",
        f"## Reward: R_v2 = {_fmt(score['reward_v2'])}",
        "",
        "Mean of V1,V2,V3,V5,V6,V7 minus 0.02 per outstanding should-merge pair. "
        "Not comparable to pre-jul19 `reward` rows. Movement below the per-vector "
        f"quantum is noise: {score['quanta']}.",
    ]
    if score["validity"]["v2_weak"]:
        lines += ["", "**VALIDITY FLAG:** V2 discrimination "
                  f"{_fmt(score.get('v2_discrimination'))} < 0.40 — treat V2/V4 "
                  "numbers (and R) as weak; re-crawl with a fresh judge before "
                  "citing this run."]

    lines += [
        "", "## Storylines", "",
        f"- **V1 chain coherence = {_fmt(score['v1_score'])}** (n={score['v1_n']}, "
        f"target ≥ 0.70). Strong: chains are single evolving events. Weak with "
        f"low drift: bad joins at attach time — lever: adjudicator prompt / "
        f"candidate signals. drift_rate = {_fmt(score['drift_rate'])}: high means "
        f"links pass locally but chains wander — lever: chain-level checks.",
        f"- worst attach method: {score.get('v1_method_worst_name')} at "
        f"{score.get('v1_method_worst')} "
        f"({score.get('v1_method_precision')})",
        f"- **V6 episode coherence = {_fmt(score['v6_score'])}** (n={score['v6_n']}, "
        f"target ≥ 0.70). Weak: episode formation merges distinct events — "
        f"upstream of everything; fix before storyline levers.",
        f"- **V7 overview quality = {_fmt(score['v7_score'])}** (n={score['v7_n']}, "
        f"target ≥ 0.70). Per-criterion pass rates: "
        + ", ".join(f"{c}={_fmt(r)}" for c, r in score["v7_criteria"].items())
        + ". Levers: coverage/current → compressor prompt; faithful → claim "
        "validation; representative → headline instruction.",
    ]
    worst_chains = _worst(score.get("per_chain") or {})
    if worst_chains:
        lines += ["", "Worst chains (spot-check ids against artifacts):"]
        lines += [f"- {sid}: {_fmt(s)}" for sid, s in worst_chains]

    lines += [
        "", "## Themes", "",
        f"- **V2 membership = {_fmt(score['v2_score'])}** (n={score['v2_n']} members "
        f"+ {score['v2_n_intruders']} planted intruders, target ≥ 0.50). Misfits "
        f"and accepted intruders cost −2.",
        f"- **discrimination = {_fmt(score.get('v2_discrimination'))}** "
        f"(fit_rate − intruder_accept_rate). Strong: members belong AND intruders "
        f"bounce. Weak V2 + high discrimination: misfit contamination — lever: "
        f"membership judge / inclusion criteria. Weak discrimination: labels too "
        f"generic to reject anything — lever: naming prompt scope guidance.",
        f"- **V4**: {score['v4_merge_pairs']} outstanding should-merge pairs of "
        f"{score['v4_candidate_n']} candidates (target 0 — each costs 0.02 R); "
        f"singleton-theme rate {_fmt(score['v4_singleton_rate'])}. Should-merge "
        f"pairs found only via name tokens (below 0.75 cosine) mean the candidate "
        f"floor is too high — adjust in a journaled iteration.",
    ]
    granularity = score.get("v2_granularity") or {}
    theme_scores = score.get("v2_theme_scores") or {}
    off = {t: g for t, g in granularity.items() if g != "right"}
    if off:
        lines += ["", "Granularity flags (−0.25 each):"]
        lines += [f"- {tid}: {verdict} (theme score {_fmt(theme_scores.get(tid))})"
                  for tid, verdict in sorted(off.items())]
    cohesion = (diagnostics or {}).get("theme_cohesion") or {}
    if cohesion:
        enrichment = [t for t, c in cohesion.items()
                      if c is not None and c < _COHESION_FLOOR
                      and theme_scores.get(t, 0) >= _FIT_FLOOR]
        relabel = [t for t, c in cohesion.items()
                   if c is not None and c >= _COHESION_FLOOR
                   and theme_scores.get(t, 0) < _FIT_FLOOR]
        lines += ["", "Cohesion router (diagnostic — cohesion never enters V2):",
                  f"- low cohesion / high judged fit → enrichment lever: {enrichment or 'none'}",
                  f"- high cohesion / low judged fit → relabel/demote lever: {relabel or 'none'}"]

    recall = score.get("recall") or {}
    lines += [
        "", "## Categorization & extraction", "",
        f"- **V3 categorization = {_fmt(score['v3_score'])}** (n={score['v3_n']}, "
        f"target ≥ 0.90). Weak: storylines filed under the wrong category — "
        f"lever: classifier prompt / category set.",
        f"- **V5 entity precision = {_fmt(score['v5_entity_precision'])}** "
        f"(n={score['v5_entity_n']}, target ≥ 0.80); event-key validity "
        f"{_fmt(score['v5_event_key_validity'])} (target ≥ 0.95); missed-salient "
        f"mean {_fmt(score['v5_missed_mean'])}. Weak: junk tokens feed every "
        f"downstream join — lever: tier-2 junk lexicon.",
        "", "## Gold recall", "",
        f"- storyline pairwise F1: {_fmt(recall.get('storyline_pairwise_f1'))} — "
        f"{recall.get('note', '')}",
        f"- theme pairwise F1: {_fmt(recall.get('theme_pairwise_f1'))} — "
        f"{recall.get('note', '')}",
        "- Low recall = fragmentation (the split-biased pipeline's dominant "
        "error); low precision = false merges. Populate `golden_news_entries` "
        "to activate (`pipeline.evals.pairwise_f1`/`b_cubed`).",
        "",
    ]
    return "\n".join(lines)
