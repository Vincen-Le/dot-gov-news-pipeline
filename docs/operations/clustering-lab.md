# Clustering Lab

The operator console's QA and experiment surface for the clustering pipeline.
Reads the database at `DATABASE_URL` directly (read-only); experiments shell
out to the pipeline experiment CLI (`uv run python -m pipeline.cli …`), which
records every completed run in the `experiment_runs` table and writes
`docs/eval/<name>/report.md`.

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
- The clustering tables always hold the **latest** run's state (Storylines and
  Quality describe it); run history and comparisons come from
  `experiment_runs`, which survives resets. Failed runs are not recorded.
- Pair labels in `docs/eval/labels.csv` and versioned topology labels survive
  resets, but they are not currently scored as gold truth by the experiment
  CLI. They support review and controlled sampling; a pairwise/B-Cubed scorer
  remains follow-up work.

## Engines

- **classic** — the existing five-stage engine (`episodes.py` →
  `storylines.py` → `cards.py` → `categories.py` → `topics.py`/`promotion.py`).
- **spine** — a simpler aggregation pipeline (decision-tree join/spawn per
  article against a dense master-node overview, retroactive theme merge/split)
  that A/Bs against classic on the same corpus. See the
  [Simplified Storyline Spine design doc](../superpowers/specs/2026-07-19-simplified-storyline-spine-design.md).
  `SPINE_ENRICHER_SYSTEM` and `SPINE_EMBED_SOURCE` are not yet wired into
  `prepare` — v1 evaluates on classic enrichment, so any A/B readout must not
  be attributed to enrichment differences.

### Parallel bench (spine)

Spine evaluates in its own database so classic bench state survives:

    ./scripts/create-spine-bench.sh   # clone corpus+features -> spine_bench, wipe derived state

### Entrypoints — which database each spins up

| Engine | Database | Experiment entrypoint | Dashboard |
|---|---|---|---|
| classic | `postgresql://postgres:postgres@127.0.0.1:57422/postgres` (the default — no env needed) | `uv run python -m pipeline.cli experiment NAME --limit 500` or `pnpm ops lab run --name NAME` | `pnpm ops dashboard` → http://127.0.0.1:4173 |
| spine | `postgresql://postgres:postgres@127.0.0.1:57422/spine_bench` (must set `DATABASE_URL`) | `DATABASE_URL=$SPINE_DB LAB_ENGINE=spine uv run python -m pipeline.cli experiment NAME --limit 500` or `DATABASE_URL=$SPINE_DB pnpm ops lab run --name NAME --set LAB_ENGINE=spine` | `DATABASE_URL=$SPINE_DB pnpm ops dashboard --port 4174` → http://127.0.0.1:4174 |

where `SPINE_DB='postgresql://postgres:postgres@127.0.0.1:57422/spine_bench'`.

Rules of thumb: no `DATABASE_URL` = classic bench; spine work always pairs
`DATABASE_URL=$SPINE_DB` with `LAB_ENGINE=spine` — setting only one of the
two either runs spine over the classic bench (clobbers classic derived
state) or runs classic over the spine bench. A dashboard instance evaluates
whichever database its `DATABASE_URL` pointed at when it started.

Re-run the script anytime to re-clone (it drops and recreates `spine_bench`;
corpus refreshes in the primary propagate on the next clone).

Both entrypoints print which database they're using on startup (`[experiment]
engine=... database=...` on stderr; `Lab database: ...` for the dashboard) —
`config/pipelines.json` (Task 9, upcoming) will become the registry/source of
truth for pipeline↔database mappings, replacing this table.
