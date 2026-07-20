# Python pipelines

The stable command boundary is `python -m pipeline.cli`. The implementation is
split by pipeline family so the active simple pipeline is not mixed with the
older complex experiment.

```text
pipeline/
├── simple/                         active storyline spine
│   ├── storyline_linking/          top-N retrieval + judge-gated assignment
│   ├── theme_clustering/           global clustering + ID reconciliation
│   └── replay.py                   event-time orchestration
├── complex/                        retained original clustering approach
├── shared/
│   └── preparation/                enrich + embed + extract preprocessing
└── *.py                            stable CLI and orchestration adapters
```

The folder names describe the code organization. Existing runtime identifiers
are intentionally unchanged because they are persisted in configuration and
database history:

| Folder     | Registry name | `LAB_ENGINE` | Database namespace | Status                                                        |
| ---------- | ------------- | ------------ | ------------------ | ------------------------------------------------------------- |
| `simple/`  | `simple_v1`   | `spine`      | `simple_v1_*`      | Active; this is the pipeline used to create the golden tables |
| `complex/` | `complex_v1`  | `classic`    | `complex_v1_*`     | Earlier approach that did not become the golden-data path     |

## What belongs where

- `simple/storyline_linking/` owns max-member top-N retrieval and the listwise
  judge outcome: join the active episode, create an episode under the matched
  storyline, or create a new storyline. Its narrow package interface is
  `Linker` plus `StorylineIndex`.
- `simple/theme_clustering/` owns global average-linkage clustering, LLM
  confirmation/naming, and persistent theme-ID reconciliation. Its replay
  interface is `sweep`; the pure clustering and reconciliation functions are
  exposed for focused algorithm tests.
- `simple/replay.py` owns event-time ordering and calls those two algorithm
  packages; it does not implement either algorithm.
- `complex/` owns the original episode, storyline, topic, promotion, and
  ranking-fit implementation.
- `shared/preparation/` owns experiment-invariant preprocessing: semantic text
  selection, enrichment validation and fallback, batched embedding, anchor
  extraction, and feature persistence.
- The rest of `shared/` owns code used across both families: configuration,
  Postgres access, corpus sync, model clients, caches, cards, evaluation, and
  normalization.
- `cli.py`, `runner.py`, `experiment.py`, `rank.py`, and `golden.py` remain at
  the package root. They are compatibility adapters or cross-family
  orchestration seams, not a third pipeline implementation.

Import implementations from their owning package (`pipeline.simple`,
`pipeline.complex`, or `pipeline.shared`). Keep user-facing commands behind
`pipeline.cli`; do not add a second CLI inside either implementation folder.

## CLI and local database setup

`config/pipelines.json` maps each public pipeline name to its engine and local
database URL. `pnpm ops setup` reads that registry, starts/verifies local
Supabase, applies migrations, and prepares the registered databases:

- `complex_v1` currently uses the primary local `postgres` database. Setup
  verifies it but does not recreate it automatically.
- `simple_v1` uses the managed `simple_v1_db`. Setup recreates a missing or
  stale managed database with `scripts/create-pipeline-db.sh simple_v1`.

The creation script applies every ordered SQL migration, then copies only the
shared corpus tables (`news_sources`, `news_source_publishers`, and
`news_entries`) from `postgres`. Derived clusters, cards, and experiment
history start empty. This makes each pipeline reproducible from the same corpus
without cloning another pipeline's output.

```sh
pnpm ops setup

# Invoke the stable Python CLI against the selected registry entry.
LAB_ENGINE=spine \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57422/simple_v1_db \
  uv run python -m pipeline.cli experiment simple-baseline --stub

LAB_ENGINE=classic \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57422/postgres \
  uv run python -m pipeline.cli experiment complex-baseline --stub
```

All Python experiment commands reject non-local database URLs. Corpus sync is
read-only against hosted data; clustering and experiment writes stay local.

## Experiment and snapshot tables

Every local pipeline database receives both table families because every
migration is applied. The selected engine determines which family the CLI
reads and writes:

| Purpose                          | Simple / `spine`                         | Complex / `classic`                       |
| -------------------------------- | ---------------------------------------- | ----------------------------------------- |
| Run metadata and resolved config | `simple_v1_experiment_runs`              | `complex_v1_experiment_runs`              |
| Immutable cluster snapshot       | `simple_v1_experiment_cluster_snapshots` | `complex_v1_experiment_cluster_snapshots` |
| Rank rows                        | `simple_v1_rank_snapshots`               | `rank_snapshots`                          |

`pipeline.experiment` owns the fixed engine-to-namespace mapping. Snapshot
inspection and annotation use the whitelist in
`pipeline.shared.eval_namespace`; user input is never interpolated into SQL
identifiers. The complex rank table keeps its older unprefixed name for
backward compatibility.

An experiment performs reset, replay, summarization, run insertion, and cluster
snapshot capture as one command. Rank snapshots are created separately:

```sh
uv run python -m pipeline.cli experiment <name> [--stub] [--limit N]
uv run python -m pipeline.cli rank snapshot --run <experiment-run-id>
```

The database migrations are the executable schema source of truth. See
[`docs/database/schema-reference.md`](../docs/database/schema-reference.md)
for the useful application tables and
[`docs/database/relationships.md`](../docs/database/relationships.md) for their
lifecycle and relationships.
