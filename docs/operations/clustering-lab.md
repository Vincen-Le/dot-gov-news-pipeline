# Clustering Lab

The operator console's QA and experiment surface for the clustering pipeline.
Reads the database at `DATABASE_URL` directly (read-only); experiments shell
out to the pipeline experiment CLI (`uv run python -m pipeline.cli …`), which
records every completed run in the pipeline's namespaced experiment-runs
table (`complex_v1_experiment_runs` for classic, `simple_v1_experiment_runs`
for spine — see [Registry](#registry--one-database-per-pipeline) below) and
writes `docs/eval/<name>/report.md`. It also freezes the completed derived
state in the pipeline's `{namespace}_experiment_cluster_snapshots` table, so
the dashboard can replay old groupings without replacing the current working
tables.

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
  successful experiment also gets one append-only row in its pipeline's
  `{namespace}_experiment_cluster_snapshots` table, tagged by the matching
  `{namespace}_experiment_runs.id`. The top-bar **Experiment view** selector
  switches Storylines, chain detail, themes, quality metrics, and the
  borderline queue between live state and a frozen run. A captured payload
  cannot be overwritten; post-judging metadata (`note`, `reward`, and the
  single `is_best` marker) can be annotated later. The selected run persists
  in the browser. Failed and pre-migration runs do not have a replay
  snapshot.
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

### Registry — one database per pipeline

`config/pipelines.json` is the source of truth for pipeline↔database
mappings. Pipeline **names** are the public identifiers `complex_v1`
(classic engine) and `simple_v1` (spine engine) — the same namespace each
pipeline's experiment/snapshot tables use (see below). `complex_v1` points
at the primary `postgres` database, where the autoresearch/complex_v1
history already lives; `simple_v1` gets its own dedicated `simple_v1_db`:

```json
{
  "pipelines": [
    {"name": "complex_v1", "engine": "classic",
     "databaseUrl": "postgresql://postgres:postgres@127.0.0.1:57422/postgres"},
    {"name": "simple_v1", "engine": "spine",
     "databaseUrl": "postgresql://postgres:postgres@127.0.0.1:57422/simple_v1_db"}
  ]
}
```

Each pipeline's tables are namespaced by its own name rather than shared:
`complex_v1_experiment_runs` / `complex_v1_experiment_cluster_snapshots` /
`rank_snapshots` (unnamespaced — it predates per-pipeline namespacing) for
`complex_v1`, and `simple_v1_experiment_runs` /
`simple_v1_experiment_cluster_snapshots` / `simple_v1_rank_snapshots` for
`simple_v1`. Runs never collide and a database dump/reset for one pipeline
never touches another's history. `complex_v1`'s `postgres` database is the
**primary** database and is never provisioned, dropped, or reset by any lab
tooling — it is read-only from the lab's point of view (see below).

Provision (or re-provision) a pipeline database from scratch:

    ./scripts/create-pipeline-db.sh simple_v1   # -> simple_v1_db

`pnpm ops lab setup` does this for every registry entry in one pass:
provisions (via the script above) any **managed** pipeline (dbname follows
the `<name>_db` convention) whose database does not exist yet, and otherwise
only verifies the existing database's tables/RPC — it never drops or
re-provisions a database that is already there, since it may hold
experiment history. `complex_v1`'s primary `postgres` database is classified
as unmanaged (primary) and only ever read, never provisioned. Prints a
per-pipeline table (name, engine, database, status, entry count).

This applies every `supabase/migrations/*.sql` migration in order, then
copies the corpus (`news_sources`, `news_source_publishers`, `news_entries`)
from a source database (`postgres` by default; pass a second argument to
copy from elsewhere). It does **not** copy derived state or run history — a
freshly provisioned pipeline database starts unclustered, with an empty
experiment-runs table. Re-run anytime to reset a pipeline back to a clean
corpus snapshot (it drops and recreates `<pipeline>_db`).

### One dashboard, both pipelines

`pnpm ops dashboard` starts a single dashboard; when `config/pipelines.json`
is present, the Lab page shows a pipeline switcher (defaulting to the first
registered pipeline) that routes every lab query and experiment run to that
pipeline's own database. Each experiment run row shows the engine it was
recorded under (`config.engine`), so comparing a `complex_v1` baseline
against a `simple_v1` run in the same table is unambiguous.

    DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57422/simple_v1_db \
      LAB_ENGINE=spine uv run python -m pipeline.cli experiment NAME --limit 500

still works unchanged for direct-CLI runs against a specific pipeline
database outside the dashboard. `DATABASE_URL` (and `LAB_ENGINE`) still
govern the dashboard's env-only default connection when no pipeline is
selected (defaulting to the `complex_v1` namespace) — the registry only adds
switchable connections, it does not change single-pipeline behavior when the
registry file is absent.

### Running the baseline pair

Each pipeline database keeps its own namespaced experiment-runs history, so
a classic-vs-spine comparison is two ordinary experiment runs against the two
databases over the same corpus slice:

    DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57422/postgres \
      uv run python -m pipeline.cli experiment classic-baseline-500 --limit 500

    DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57422/simple_v1_db \
      LAB_ENGINE=spine uv run python -m pipeline.cli experiment spine-baseline-500 --limit 500

Add `--stub` to both for a stub-scale plumbing check (deterministic,
no Workers AI calls) when features aren't ready for a real-model pair —
see `docs/eval/spine-vs-classic-2026-07/notes.md` for a worked example and
its scope caveats. Each command writes `docs/eval/<name>/report.md`; diff the
two reports or read the A/B notes doc for the comparison.
