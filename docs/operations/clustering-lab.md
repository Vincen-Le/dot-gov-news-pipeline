# Clustering Lab

The operator console's QA and experiment surface for the clustering pipeline.
Reads the database at `DATABASE_URL` directly (read-only); experiments shell
out to the pipeline experiment CLI (`uv run python -m pipeline.cli …`), which
records every completed run in the `complex_v1_experiment_runs` table and writes
`docs/eval/<name>/report.md`. It also freezes the completed derived state in
`complex_v1_experiment_cluster_snapshots`, so the dashboard can replay old groupings
without replacing the current working tables.

This page is the quick guide. Use the
[Evaluation Harness Runbook](evaluation-harness.md) for command side effects,
cost controls, direct-CLI and dashboard differences, topology-curated inputs,
metric definitions, ranking evaluation, and recovery.

## Setup

1. `DATABASE_URL` is optional for `pnpm ops`: the console defaults to the
   local bench database on port **57422** (the port this repo's
   `supabase/config.toml` pins) and passes the same DSN to the pipeline
   stages it spawns. Set the variable to target a different database — reads
   work against any DSN; experiments require a local one (the pipeline bench
   tools structurally refuse remote hosts). Direct Python CLI invocations
   still need it exported because the pipeline's own fallback is the stock
   Supabase port 54322. Caveat: `pipeline/config.py` loads the root `.env`, and
   `tests/test_cache.py` asserts the built-in default — export the variable in
   your shell (or per command) instead of committing it to `.env` if you also
   run `uv run pytest`.
2. Start the local stack with `pnpm supabase start`. Preserve an existing
   corpus by applying pending migrations instead of resetting it. The command
   is `pnpm supabase migration up --local`. Use `pnpm supabase db reset` only
   for a disposable local database because it erases the local corpus and
   features.
3. Sync the hosted corpus with `uv run python -m pipeline.cli sync`. Prepare
   features once with `uv run python -m pipeline.cli prepare`; the lab's run
   form auto-includes this when entries still need it.
4. The `uv` toolchain (experiment stages spawn the pipeline CLI).

## The loop

| Step                   | Dashboard                                         | CLI                                                                                 |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Inspect the corpus     | Lab § Corpus                                      | `pnpm ops lab corpus`                                                               |
| Run an experiment      | Lab § Run experiment                              | `pnpm ops lab run --name baseline --stub`                                           |
| Sweep a threshold      | Lab § Run (override fields)                       | `pnpm ops lab run --name sweep --set NEAR_DUP_THRESHOLD=0.87`                       |
| Feature-level A/B      | Lab § Run ("Re-embed")                            | `pnpm ops lab run --name no-enrich --clear-features --set ENRICHMENT_ENABLED=false` |
| QA the chains          | Storylines → chain detail                         | `pnpm ops lab storyline <id>`                                                       |
| Read quality metrics   | Lab § Quality                                     | `pnpm ops lab metrics`                                                              |
| Compare runs           | Lab § Experiment runs (baseline + config diff)    | `pnpm ops lab experiments` + `diff docs/eval/<a>/report.md docs/eval/<b>/report.md` |
| Replay a captured run  | Top-bar **Experiment view** selector               | Select **Live working state** to return to mutable tables                           |
| Label borderline pairs | Lab § Label queue (writes `docs/eval/labels.csv`) | `pnpm ops lab borderline` (read-only listing)                                       |

Notes:

- Each experiment resets **derived** clustering state only; the synced corpus
  and its features survive. "Re-embed" (`--clear-features`) is for runs that
  change `EMBEDDING_MODEL`, `ENRICHER_MODEL`, or `ENRICHMENT_ENABLED` — it
  re-runs the expensive prepare phase.
- One experiment at a time. Repeat runs are fast: features are cached in the
  DB and adjudicator decisions in `.cache/decisions.sqlite` (hits/misses are
  shown per run).
- `pnpm ops lab run` auto-prepares the entire unembedded backlog when
  `needsPrepare` is nonzero; its `--limit` and `--until` apply only to
  clustering. Inspect `pnpm ops lab corpus` before starting a run if feature
  generation is not intended.
- The clustering tables hold the **latest** run's mutable state. Every
  successful experiment also gets one append-only row in
  `complex_v1_experiment_cluster_snapshots`, tagged by its
  `complex_v1_experiment_runs.id`. The
  top-bar **Experiment view** selector switches Storylines, chain detail,
  themes, quality metrics, and the borderline queue between live state and a
  frozen run. A captured payload cannot be overwritten; post-judging metadata
  (`note`, `reward`, and the single `is_best` marker) can be annotated later.
  The selected run persists in the browser. Failed and pre-migration runs do
  not have a replay snapshot.
- Pair labels in `docs/eval/labels.csv` and versioned topology labels survive
  resets, but they are not currently scored as gold truth by the experiment
  CLI. They support review and controlled sampling; a pairwise/B-Cubed scorer
  remains follow-up work.
