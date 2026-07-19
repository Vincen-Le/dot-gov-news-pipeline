---
name: clustering-eval
description: Use when a single finished pipeline/experiment run needs quality scoring — "evaluate this run", "score jul19-05", "grade the clustering output", "produce the eval report", "compute R for this run". One run, one pass, simplified or complex pipeline. NOT for iterating experiments — that is clustering-autoresearch, which invokes this skill every loop.
---

# Clustering Eval

One blinded judging pass over ONE finished run: export artifacts → seven
parallel blinded judges → mechanical scores → R_v2 → human-readable
eval-report. This skill grades a run; it never changes the pipeline,
config, or ledgers.

**REQUIRED BACKGROUND (this directory):**
- `scoring.md` — judge protocol, false-merge −2 weighting, V3/V5, gold
  recall, R_v2, scorecard schema, eval-report contract.
- `theme_scoring.md` — Themes axis: V2 (membership + planted intruders +
  granularity probe), V4, cohesion router.
- `multi-episode-scoring.md` — Storylines axis: V1 (chain coherence +
  drift), V6, V7 overview quality, embedding diagnostics.
- Crawl mechanics (export SQL, CSV columns, seed-42 sampling):
  `docs/superpowers/plans/2026-07-18-clustering-eval-loop.md`; the scoring
  files win on judging rules.

## Procedure

All commands run from the repo root; `DATABASE_URL` exported per command,
never in `.env`.

1. **Orient.** Read `docs/eval/<run>/report.md`: run_id, which pipeline
   (`simple_v1` | `complex_v1`), corpus size. Verify against the selected
   pipeline's `<pipeline>_experiment_runs` table (read-only `pipeline.db.Db`) that no newer
   run superseded this one — artifact IDs are per-replay; a stale run cannot
   be judged. Stale → stop, tell the caller. (The exporter records the
   newest run in `metadata.json`; confirm it matches `<run>`.)
2. **Export artifacts** (blind):
   ```bash
   DATABASE_URL=... uv run python scripts/eval/export_judge_artifacts.py \
       --pipeline <complex_v1|simple_v1> \
       --out docs/eval/<run>/eval/artifacts --probe-labels
   ```
   Intruder ground truth goes ONLY to `intruder-truth.json` (per-theme
   planted intruders are shuffled unlabeled into v2.json); `--probe-labels`
   generates V2 probe labels at export time via the judge client. Also
   writes `diagnostics.json` (chain embedding trends, theme cohesion — the
   no-judge router inputs).
3. **Judge.** Seven blinded judges (V1–V7) in parallel:
   ```bash
   uv run python scripts/eval/run_judges.py \
       --artifacts docs/eval/<run>/eval/artifacts \
       --verdicts docs/eval/<run>/eval/verdicts
   ```
   Protocol in `scoring.md`; judge = Anthropic API (`pipeline/judge.py`,
   default `claude-opus-4-8`, override `EVAL_JUDGE_MODEL`) — always a model
   family ≠ the pipeline's llama models. If `ANTHROPIC_API_KEY` is absent,
   the skill agent must dispatch blinded subagent judges with the same
   rubrics and CSV contracts instead of running this script.
4. **Score mechanically**:
   ```bash
   uv run python scripts/eval/score_run.py \
       --pipeline <complex_v1|simple_v1> \
       --verdicts docs/eval/<run>/eval/verdicts \
       --artifacts docs/eval/<run>/eval/artifacts \
       --out docs/eval/<run>/eval/score.json
   ```
   Formulas live in `pipeline/evals.py` (never inline). Gold recall via
   `pairwise_f1`/`b_cubed` over `golden_news_entries`; unpopulated →
   `n/a (no gold labels)`, keep the rows. score.json carries R_v2, flip
   quanta, and validity flags (discrimination < 0.40 → V2/V4 weak).
5. **Report.** Render `docs/eval/<run>/eval-report.md` with
   `pipeline.eval_report.render_eval_report(score, metadata, diagnostics)`
   (inputs: score.json, artifacts/metadata.json, artifacts/diagnostics.json)
   — every metric carries value, n, strong/weak meaning, first lever;
   worst-chain ids for spot-checking. Append run-specific caveats by hand.

## Output contract

Deliverables of a pass — exactly these, all under the run's own directory:

| Path | Content |
|---|---|
| `docs/eval/<run>/eval/artifacts/` | blinded judge inputs + intruder-truth.json |
| `docs/eval/<run>/eval/verdicts/` | verdict CSVs, exactly as judges returned them |
| `docs/eval/<run>/eval/score.json` | per-vector scores, n's, diagnostics, R_v2 |
| `docs/eval/<run>/eval-report.md` | the human report |

Return to the caller: R_v2, per-vector scores with n's, validity flags,
report path.

Ledger writes belong to the CALLER, not this skill: `scorecard.csv` rows,
`journal.md` entries, keep/revert decisions, next-iteration choices, knob
changes, re-runs. A one-off eval ends at the report; the autoresearch loop
takes score.json from here and does its own bookkeeping. Never write into
`docs/eval/loop/` from this skill.

Frozen during a pass: the three scoring files, `pipeline/evals.py`,
`pipeline/judge.py`, `pipeline/eval_report.py`, `scripts/eval/*`, verdict
CSVs. Rubric looks wrong → note it in the report's caveats, finish the pass
unchanged.
