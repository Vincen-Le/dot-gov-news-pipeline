# Clustering Lab

The operator console's QA and experiment surface for the clustering pipeline.
Reads the database at `DATABASE_URL` directly (read-only); experiments shell
out to the pipeline experiment CLI (`uv run python -m pipeline.cli …`), which
records every completed run in the `experiment_runs` table and writes
`docs/eval/<name>/report.md`.

## Setup

1. `DATABASE_URL` pointing at the local bench database. This repo's Supabase
   config pins the db to port **57422**
   (`postgresql://postgres:postgres@127.0.0.1:57422/postgres`); the pipeline's
   built-in fallback is the stock Supabase port 54322, so the variable must be
   set explicitly here. Reads work against any DSN; experiments require a
   local one (the pipeline bench tools structurally refuse remote hosts).
   Caveat: `pipeline/config.py` loads the root `.env`, and
   `tests/test_cache.py` asserts the built-in default — export the variable
   in your shell (or per command) instead of committing it to `.env` if you
   also run `uv run pytest`.
2. Local stack + migrations: `pnpm supabase start` (schema through
   `20260718100200_create_experiment_runs`).
3. Corpus synced: `uv run python -m pipeline.cli sync` (hosted → local,
   id-preserving). Features prepared once: `uv run python -m pipeline.cli
   prepare` — the lab's run form auto-includes this when entries still need it.
4. The `uv` toolchain (experiment stages spawn the pipeline CLI).

## The loop

| Step | Dashboard | CLI |
| --- | --- | --- |
| Inspect the corpus | Lab § Corpus | `pnpm ops lab corpus` |
| Run an experiment | Lab § Run experiment | `pnpm ops lab run --name baseline --stub` |
| Sweep a threshold | Lab § Run (override fields) | `pnpm ops lab run --name sweep --set NEAR_DUP_THRESHOLD=0.87` |
| Feature-level A/B | Lab § Run ("Re-embed") | `pnpm ops lab run --name no-enrich --clear-features --set ENRICHMENT_ENABLED=false` |
| QA the chains | Storylines → chain detail | `pnpm ops lab storyline <id>` |
| Read quality metrics | Lab § Quality | `pnpm ops lab metrics` |
| Compare runs | Lab § Experiment runs (baseline + config diff) | `pnpm ops lab experiments` + `diff docs/eval/<a>/report.md docs/eval/<b>/report.md` |
| Label borderline pairs | Lab § Label queue | `pnpm ops lab borderline` (labels land in `docs/eval/labels.csv`) |

Notes:

- Each experiment resets **derived** clustering state only; the synced corpus
  and its features survive. "Re-embed" (`--clear-features`) is for runs that
  change `EMBEDDING_MODEL`, `ENRICHER_MODEL`, or `ENRICHMENT_ENABLED` — it
  re-runs the expensive prepare phase.
- One experiment at a time. Repeat runs are fast: features are cached in the
  DB and adjudicator decisions in `.cache/decisions.sqlite` (hits/misses are
  shown per run).
- The clustering tables always hold the **latest** run's state (Storylines and
  Quality describe it); run history and comparisons come from
  `experiment_runs`, which survives resets. Failed runs are not recorded.
- Labels are corpus-level ground truth collected for the future eval harness
  (`eval --labels`); they survive resets.
