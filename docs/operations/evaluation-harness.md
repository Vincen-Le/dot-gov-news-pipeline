# Evaluation Harness Runbook

This runbook is the operational source of truth for evaluating the offline
aggregation pipeline: prepared `news_entries` are replayed in event time into
episodes, storylines, cards, topics, and per-run ranking snapshots. It covers
the local dashboard, `pnpm ops lab` commands, the direct Python CLI, topology-
curated datasets, result interpretation, and recovery.

Use this harness to compare aggregation behavior. It does not create a
training/test split, train the clustering system, or currently calculate a
gold-label score such as pairwise or B-Cubed F1.

## Runbook map

- Start with [Safety and cost boundary](#safety-and-cost-boundary),
  [Mental model and durable state](#mental-model-and-durable-state), and
  [Prerequisites](#prerequisites).
- Use [Establish or refresh the corpus](#establish-or-refresh-the-corpus) and
  the [Golden experiment loop](#golden-experiment-loop) for routine work.
- Read [Choosing the right entry point](#choosing-the-right-entry-point)
  before using advanced direct-CLI controls.
- See [Topology-curated datasets](#topology-curated-datasets),
  [Cache policy](#cache-policy), and
  [Feature and model A/B runs](#feature-and-model-ab-runs) for specialized
  experiments.
- Use [Reading the output](#reading-the-output),
  [Storyline and borderline QA](#storyline-and-borderline-qa), and
  [Ranking evaluation](#ranking-evaluation) to evaluate a result.
- Finish with [Troubleshooting and recovery](#troubleshooting-and-recovery)
  and the [pre-run](#pre-run-checklist) and [post-run](#post-run-checklist)
  checklists.

## Safety and cost boundary

Experiments are intentionally local-only. The Python bench guard rejects a
non-local database host before resetting or syncing experiment state. Lab
queries may read another database, but the dashboard disables experiment runs
for a remote DSN.

The hard guard covers `sync`, `reset`, and `experiment` through the bench
helpers. The lower-level direct commands (`prepare`, `reextract`, `cluster`,
and ranking operations) are not all guarded. Verify `DATABASE_URL` before
running them and keep this evaluation workflow on the local bench database;
`rank fit --write` is a real database write.

The read-only commands are:

- `pnpm ops lab corpus`
- `pnpm ops lab storylines`, `themes`, `storyline`, `metrics`, `borderline`,
  and `experiments`
- opening the dashboard and browsing existing data

The write commands have materially different costs:

| Operation                       | What it changes                                                                                                 | Model/API work                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `pipeline.cli sync`             | Upserts the hosted raw corpus into local tables; invalidates features only when an entry's content hash changed | None                                                |
| `pipeline.cli prepare`          | Adds enrichment, embeddings, entities, and event keys to currently unembedded entries                           | Potentially expensive                               |
| `pipeline.cli reextract`        | Refreshes deterministic entity/event-key extraction                                                             | No LLM or embedding calls                           |
| `pipeline.cli experiment`       | Clears derived aggregation state, replays prepared entries, writes a report/run row/rank snapshot/cluster replay snapshot | May call adjudicator, card, topic, and judge models |
| `pipeline.cli reset --clusters` | Clears current derived aggregation state                                                                        | None                                                |
| `pipeline.cli reset --features` | Clears derived state and all per-entry prepared features                                                        | Makes a later prepare expensive                     |
| topology-label publisher        | Writes only versioned topology sidecar labels                                                                   | No enrichment, embedding, or aggregation            |

> **Cost warning:** `pnpm ops lab run` and the dashboard automatically run an
> unbounded `prepare` stage when even one published entry lacks an embedding.
> The run's `--limit` and `--until` apply to clustering, not to that automatic
> prepare. Inspect `pnpm ops lab corpus` first. If feature generation is not
> intended, do not start a dashboard/`pnpm ops` experiment while
> `needsPrepare` is nonzero; use the direct Python CLI on the already-prepared
> subset instead.

`--clear-features` is broader still: it clears features for the whole local
corpus and then prepares the whole backlog. Reserve it for an embedding or
enrichment model A/B where feature regeneration is the purpose of the run.

## Mental model and durable state

The harness separates an expensive, reusable corpus preparation phase from a
repeatable aggregation replay.

```text
hosted news corpus
        |
        | sync (ID-preserving)
        v
local news_entries -- prepare once --> cached entry features
        |                                  |
        +----------- event-time replay ----+
                           |
                           v
        episodes -> storylines -> cards/topics
                           |
                           +-> report + complex_v1_experiment_runs + rank_snapshots
```

The important storage boundaries are:

| State                    | Location                                                                                                 | Survives `reset --clusters`? | Meaning                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| Raw corpus               | `news_sources`, `news_source_publishers`, `news_entries` raw fields                                      | Yes                          | Input documents and publisher attribution                          |
| Prepared features        | Embedding/enrichment/extraction fields on `news_entries`                                                 | Yes                          | Reusable experiment input                                          |
| Expected topology labels | `topology_label_sets`, `news_entry_topology_labels`                                                      | Yes                          | Versioned bootstrap labels used for input selection                |
| Current aggregation      | `episode_entries`, `episodes`, `storylines`, `event_cards`, `topic_themes`, LLM-created topic categories | No                           | Only the latest completed or interrupted replay state              |
| Completed run summary    | `complex_v1_experiment_runs`                                                                              | Yes                          | Resolved config, summary, cluster report, timing, cache counts     |
| Clustering replay state  | `complex_v1_experiment_cluster_snapshots`                                                                 | Yes                          | Immutable run-scoped storylines, episodes, memberships, cards, themes, and entry evidence; mutable note/reward/best metadata |
| Ranking evidence         | `rank_snapshots`, `rank_audit_pairs`, `rank_audit_runs`                                                  | Yes                          | Run-scoped ranking state and audit results                         |
| Model-decision cache     | `.cache/decisions.sqlite`                                                                                | Yes                          | Content-keyed adjudication/theme/rank decisions                    |
| Markdown report          | `docs/eval/<name>/report.md`                                                                             | Yes                          | Human-readable lab notebook for one run                            |
| Human pair labels        | `docs/eval/labels.csv`, `docs/eval/rank-labels.csv`                                                      | Yes                          | Review annotations; only rank labels currently have a CLI consumer |

An experiment reset nulls `news_entries.episode_id` and clears the current
aggregation tables. It preserves raw entries, prepared features, seed topic
categories, experiment history, rank history, topology labels, and the local
decision cache.

The current aggregation tables are not run-versioned. After starting another
experiment, use them to inspect the newest replay only. Historical comparisons
use the run summaries, reports, and rank snapshots—not old episode/storyline
rows.

## Prerequisites

From the repository root:

```bash
mise install
mise exec -- pnpm install --frozen-lockfile
uv sync --locked
```

This assumes Python 3.12+ and the `uv` executable are installed; `mise.toml`
pins Node 24 but does not install `uv`.

Copy `.env.example` to `.env` and populate credentials locally. Do not commit
them. The Python config currently requires `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` even for commands or stub runs that do not call real
models. Corpus sync additionally requires `SUPABASE_URL` and
`SUPABASE_SECRET_KEY`.

Start the repository's local Supabase project:

```bash
mise exec -- pnpm supabase start
```

For a new disposable database, apply every migration and seed with:

```bash
mise exec -- pnpm supabase db reset
```

`db reset` destroys the local database, including a synced corpus and prepared
features. On a local database whose contents must be preserved, apply pending
migrations instead:

```bash
mise exec -- pnpm supabase migration up --local
```

The harness needs at least the clustering tables, `complex_v1_experiment_runs`, and rank
observability migrations. Topology-curated runs additionally need
`20260718101300_create_news_entry_topology_labels.sql`.

The repository database is on port `57422`. `pnpm ops` uses this port by
default, but the Python CLI's fallback is the stock Supabase port `54322`.
Export the repository DSN before any direct Python command:

```bash
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:57422/postgres'
```

Prefer a shell export over committing the DSN to `.env`; the Python tests
assert the built-in fallback configuration.

## Establish or refresh the corpus

### 1. Inspect before writing

```bash
pnpm ops lab corpus
pnpm ops lab corpus --json
```

The receipt reports entry/source counts, date range, publisher distribution,
feature coverage, current clustered count, and `needsPrepare`. This command is
read-only.

### 2. Sync hosted entries when needed

```bash
uv run python -m pipeline.cli sync
```

Sync copies the entire hosted corpus into the local database while preserving
IDs. Existing local entry features survive when the hosted content hash is
unchanged. A changed hash clears the affected entry's enrichment, embedding,
entities, and event keys so it cannot silently reuse stale features. Sync does
not run enrichment or aggregation.

Sync is not necessary before every experiment. Freeze the corpus for an A/B
series; syncing between variants changes the input and invalidates the
comparison.

### 3. Prepare only the intended entries

Prepare the current unembedded backlog:

```bash
uv run python -m pipeline.cli prepare
```

Bound cost explicitly when bootstrapping an evaluation subset:

```bash
uv run python -m pipeline.cli prepare --limit 1000 --concurrency 8
uv run python -m pipeline.cli prepare --limit 1000 --per-agency 50
uv run python -m pipeline.cli prepare --agency noaa --agency usgs --limit 1000
```

Use deterministic stub features for a wiring smoke test:

```bash
uv run python -m pipeline.cli prepare --stub --limit 100
```

Preparation selects entries whose embedding is null. It does not notice that
an already-populated embedding was made by a different model. When changing
`EMBEDDING_MODEL`, `ENRICHER_MODEL`, or the enrichment strategy, deliberately
clear features and regenerate them; do not mix feature spaces.

Refresh only deterministic extraction when its version changes:

```bash
uv run python -m pipeline.cli reextract --limit 1000
```

`reextract` makes no LLM or embedding calls.

## Golden experiment loop

### 1. Freeze an experiment contract

Record the following before the baseline:

- corpus sync point and `pnpm ops lab corpus --json` receipt
- prepared entry count and input selection (`--limit`, `--until`,
  `--per-agency`, or topology label set)
- model mode: stub or real
- config variables under test
- cache policy
- a unique, filesystem-safe run name

Names accepted by the operator harness are 1–64 characters, begin with an
alphanumeric character, and contain only letters, numbers, `.`, `_`, or `-`.
A useful convention is `<question>-<variant>-<date>`, for example
`near-dup-088-20260718`.

### 2. Run a small smoke test

After intentionally preparing the relevant entries, verify end-to-end wiring:

```bash
pnpm ops lab run --name smoke-stub --stub --limit 100
```

The stub avoids real model calls during the run. It is a determinism and
integration check, not a quality baseline.

### 3. Run the real baseline

```bash
pnpm ops lab run --name baseline-20260718 --limit 1000
```

Or use the local dashboard:

```bash
pnpm ops:start
```

The dashboard exposes corpus status, one active experiment, run history and
config comparison, live quality metrics, storyline QA, and the label queues.
Only one operator-harness experiment runs at a time.

The operator harness performs these stages:

1. `reset --features`, only when `--clear-features` was requested.
2. `prepare`, when forced, after a feature reset, or whenever
   `needsPrepare > 0`.
3. `experiment`, which resets derived clusters again and performs the replay.

### 4. Change one variable

Run a threshold variant through the operator harness:

```bash
pnpm ops lab run \
  --name near-dup-088-20260718 \
  --limit 1000 \
  --set NEAR_DUP_THRESHOLD=0.88
```

For comparable variants, keep the corpus, selection, model mode, topology
seed, and cache policy fixed. Change one behavior-driving variable at a time.

### 5. Inspect evidence, not just totals

```bash
pnpm ops lab metrics
pnpm ops lab storylines --min-episodes 2 --sort episodes --limit 50
pnpm ops lab storyline STORYLINE_UUID
pnpm ops lab borderline --window 0.03 --limit 50
```

Review representative long chains, singletons, high-volume episodes,
borderline joins, and multiple publishers. A lower singleton rate alone is not
proof of higher quality; it can also signal false merges.

### 6. Compare and record the decision

```bash
pnpm ops lab experiments
diff -u \
  docs/eval/baseline-20260718/report.md \
  docs/eval/near-dup-088-20260718/report.md
```

The dashboard run-history comparison also shows resolved config differences.
Keep the reports that support a decision, and record why the winning behavior
is preferable with concrete storyline examples.

## Choosing the right entry point

### Operator harness: normal A/B experiments

Use `pnpm ops lab run` or the dashboard for standard runs, automatic stage
progress, run history, and whitelisted config overrides.

```bash
pnpm ops lab run --name RUN_NAME [options]
```

Supported options are:

- `--stub`
- `--limit N`
- `--until ISO_TIMESTAMP`
- `--no-cache`
- `--prepare`
- `--clear-features`
- repeatable `--set KEY=VALUE`

Allowed `--set` keys are:

```text
ADJUDICATOR_MODEL
AMBIENT_EMA_CEILING
CLUSTER_JOIN_THRESHOLD
DEDUPE_WINDOW_HOURS
EMBEDDING_MODEL
ENRICHER_MODEL
ENRICHER_VERSION
ENRICHMENT_ENABLED
EPISODE_DORMANCY_HOURS
JUDGE_MODEL
NEAR_DUP_THRESHOLD
PROMPT_VERSION
RUBRIC_VERSION
STORYLINE_SIM_FLOOR
TAU_SECONDS
```

Unknown keys are rejected. Topic controls, per-agency selection, and topology
curation are not exposed by the operator harness today.

### Direct Python experiment: advanced input selection

Use the direct CLI for per-agency samples, topology-curated samples, topic
configuration, a custom report root, or any config variable outside the
operator whitelist.

```bash
uv run python -m pipeline.cli experiment RUN_NAME \
  --limit 1000 \
  --until 2026-07-01T00:00:00Z \
  --out docs/eval
```

Direct experiments do not auto-prepare. They replay only entries with an
embedding, and they process selected entries in ascending event time.

For an agency-balanced input, the selector caps each publisher and then
replays the selected entries chronologically:

```bash
uv run python -m pipeline.cli experiment balanced-50 \
  --limit 1000 \
  --per-agency 50
```

For config changes, prefix the command with environment variables:

```bash
TOPICS_ENABLED=true THEME_SIM_FLOOR=0.58 \
  uv run python -m pipeline.cli experiment topics-058 --limit 1000
```

### `cluster` versus `experiment`

`cluster` processes currently prepared, unclustered entries without first
clearing existing derived state. It is useful for focused debugging or
incremental local work:

```bash
uv run python -m pipeline.cli cluster --limit 100
```

Do not use it for a clean A/B replay unless you first run `reset --clusters`.
Prefer `experiment`, which performs the reset, report, history insert, and
rank snapshot as one operation.

## Topology-curated datasets

Topology labels let an experiment request a denser population of expected
multi-episode storylines without modifying `news_entries`. They are provisional
selection labels, not adjudicated truth and not an evaluation target.

Publish a strict, high-precision label set:

```bash
uv run python scripts/audit-news-corpus.py \
  --mode strict \
  --publish \
  --publish-target local \
  --label-set-name corpus-topology-strict \
  --labeling-version 1
```

The audit reads the hosted corpus to derive labels. With `--publish-target
local`, it writes only the two local topology sidecar tables; it does not
enrich entries, generate embeddings, or run aggregation.

Sync the local corpus first. Publishing relies on the same entry UUIDs being
present locally, and curated sampling later rejects labels whose recorded
content hash no longer matches the entry.

Find the completed label-set UUID in local Studio or `psql`:

```sql
select id, name, labeling_version, entry_count, parameters, completed_at
from public.topology_label_sets
where status = 'complete'
order by completed_at desc;
```

Request 40% of entries from complete expected multi-episode storylines, 5%
from multi-entry single-episode storylines, and 55% from singleton
episode/storylines:

```bash
uv run python -m pipeline.cli experiment topology-40-5-55 \
  --limit 1000 \
  --topology-label-set LABEL_SET_UUID \
  --multi-episode-percent 40 \
  --multi-entry-single-episode-percent 5 \
  --topology-seed topology-40-5-55
```

The label-set UUID, finite `--limit`, and multi-episode percentage are
required together. Topology curation cannot be combined with `--per-agency`.
The selector keeps an estimated storyline intact and is deterministic for a
label set and seed. Variable storyline sizes can cause a small percentage
packing shortfall; singleton entries fill the remainder so the final dataset
still has exactly the requested limit. The run report records requested and
actual expected-label counts.

`multi_entry_single_episode` is a mutually exclusive storyline class.
`is_multi_entry_episode` is an orthogonal label: a multi-entry episode may
also sit inside a multi-episode storyline. See
[Topology-label curation](topology-label-curation.md) for the schema, sampler
semantics, and episode-density query.

## Cache policy

The default cache at `.cache/decisions.sqlite` keys decisions by model tag and
content/context, not by regenerated row IDs. Replays can therefore reuse
temperature-zero adjudications after aggregation tables are reset.

Use the cache when testing deterministic threshold or routing changes and you
want unchanged decisions to be cheap. The report records hits and misses.

Bypass it when the prompt behavior changed without an adequate cache-key tag,
when investigating a suspected stale decision, or when intentionally
measuring fresh model behavior:

```bash
pnpm ops lab run --name fresh-decisions --limit 1000 --no-cache
```

`--no-cache` does not delete the cache; it bypasses it for that process.
Feature embeddings and enrichment remain separate database caches.

## Feature and model A/B runs

Changing aggregation thresholds does not require new features. Changing the
embedding/enrichment model or feature construction does.

The operator-harness form is:

```bash
pnpm ops lab run \
  --name embedding-variant \
  --clear-features \
  --set EMBEDDING_MODEL=MODEL_ID
```

This clears and prepares the entire eligible local corpus. To bound the work,
use the direct sequence instead:

```bash
uv run python -m pipeline.cli reset --features
EMBEDDING_MODEL=MODEL_ID \
  uv run python -m pipeline.cli prepare --limit 1000
EMBEDDING_MODEL=MODEL_ID \
  uv run python -m pipeline.cli experiment embedding-variant --limit 1000
```

Keep the same model environment on both `prepare` and `experiment`. A feature
reset is destructive to the local feature cache but not to raw corpus rows,
run history, topology labels, or decision-cache files.

## Reading the output

Each successful Python experiment prints JSON containing the report path,
run UUID, and ranking snapshot row count. It also writes:

- `docs/eval/<name>/report.md`
- one `complex_v1_experiment_runs` row
- run-scoped `rank_snapshots`
- the newest aggregation state in the clustering tables

The report sections mean:

| Section                        | Interpretation                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Duration/processed/cache       | Replay size, closed episodes, and model decision reuse                                                |
| Totals                         | Clustered entries, episodes, storylines, cards, singleton-episode rate, multi-episode storyline count |
| Input topology curation        | Requested mix and actual expected-label composition, when curation was used                           |
| Entry → episode attach mix     | How entries joined or spawned episodes                                                                |
| Episode → storyline attach mix | How episodes joined or spawned storylines                                                             |
| Top chains                     | Ten storylines with the most episodes, then entries                                                   |
| Topics                         | Theme/category counts, concentration, and attach methods                                              |
| LLM health                     | Card fallback rate, uncategorized themes, theme-creator/model errors                                  |
| Config                         | Resolved non-secret configuration for reproducibility                                                 |

The live `pnpm ops lab metrics` snapshot additionally provides:

- histograms of entries per episode and episodes per storyline
- entry and storyline attach-method distributions
- similarity percentiles by attach method
- syndication rate
- top chains
- a heuristic near-duplicate calibration value: the fifth percentile of
  content-hash-pair cosine minus `0.02`

That calibration suggestion is a corpus heuristic, not a quality score. The
live volume query counts active storylines and unsuperseded cards, while the
Markdown experiment summary counts table rows; do not assume the two card or
storyline totals have identical definitions.

For every candidate run, check at least:

1. Input equality with the baseline.
2. Processed count and model-error/fallback health.
3. Singleton and multi-episode distribution.
4. Entry- and storyline-attach method shifts.
5. Cache misses or added model cost.
6. Concrete false-merge and false-split examples.
7. Largest/top chains for megacluster regressions.

## Storyline and borderline QA

List chains with the most episodes:

```bash
pnpm ops lab storylines --min-episodes 2 --sort episodes --limit 50
```

Useful filters are `--agency PUBLISHER_KEY`, `--entity ENTITY`, `--theme
UUID`, and `--category UUID`. Inspect one chain:

```bash
pnpm ops lab storyline STORYLINE_UUID
```

The detail view exposes each episode, attach method/reason/similarity,
threshold, matched entry, syndication flag, publisher, and generated cards.
Overview timeline items not backed by a member episode are marked uncited.

Find entry attachments close to their applied threshold:

```bash
pnpm ops lab borderline --window 0.03 --limit 100 --json
```

The command only lists candidates. The dashboard label queue appends reviewed
same-event decisions to `docs/eval/labels.csv` with columns
`entry_a,entry_b,same_event`.

These labels survive resets, but the current Python CLI does not yet consume
them or report pairwise/B-Cubed metrics. Do not cite the CSV or topology labels
as a measured accuracy result. Implementing that scorer remains a separate
evaluation-harness extension.

## Ranking evaluation

Every successful experiment automatically snapshots ranking rows for global,
agency, theme, and category facets where applicable. Backfill a snapshot only
for a legacy run that does not already have `rank_snapshots` rows; repeating
the insert for the same run/facets conflicts with its unique keys:

```bash
uv run python -m pipeline.cli rank snapshot --run RUN_UUID
```

Run the swap-controlled LLM preference audit:

```bash
uv run python -m pipeline.cli rank audit --run RUN_UUID
uv run python -m pipeline.cli rank audit --run RUN_UUID --stub
```

The audit compares nearby ranked pairs in both presentation orders. It stores
agreement, sampled Kendall tau, inconsistency rate, per-facet metrics, and
term deltas for disagreements without changing `rank_key`.

Human ranking reviews append to `docs/eval/rank-labels.csv`:

```text
run_id,storyline_a,storyline_b,preferred
```

Fit proposed rubric weights from one or more audited runs:

```bash
uv run python -m pipeline.cli rank fit \
  --runs RUN_UUID_A,RUN_UUID_B \
  --labels docs/eval/rank-labels.csv \
  --min-pairs 50
```

Fitting is read-only unless `--write` is supplied. `--write` inserts a new
rubric-weight version; it does not alter existing versions or rerun an
experiment:

```bash
uv run python -m pipeline.cli rank fit \
  --runs RUN_UUID_A,RUN_UUID_B \
  --labels docs/eval/rank-labels.csv \
  --min-pairs 50 \
  --write
```

Set the returned `RUBRIC_VERSION` explicitly in a follow-up experiment to
evaluate the new weights.

## Reproducible experiment design

Use this minimum A/B discipline:

- Freeze the hosted sync point for the whole series.
- Confirm all selected entries are prepared before the baseline.
- Keep `--limit`, `--until`, and selection mode identical.
- For topology runs, keep the label-set UUID and seed identical.
- Do not compare a stub run to a real-model run as a quality A/B.
- Keep cache policy identical, or explain the difference as a cost test.
- Change one config variable or one code path per variant.
- Use a new report name for each run; rerunning a name overwrites its Markdown
  report even though `complex_v1_experiment_runs` may contain multiple rows with that
  name.
- Save concrete chain IDs/headlines and the observed failure mode with the
  metric delta.

No training/test split is required for aggregation comparison. The topology
sidecar is for controlled sampling, and human labels are review evidence. If
learned parameters are later fit and evaluated on the same judgments, define
an explicit holdout policy at that time.

## Troubleshooting and recovery

### Lab says `not_enabled`

Check that local Supabase is running, `DATABASE_URL` points to port `57422`,
and migrations are current:

```bash
mise exec -- pnpm supabase status
mise exec -- pnpm supabase migration list --local
pnpm ops lab corpus
```

Read-only lab access needs the clustering tables. Experiment access also needs
`complex_v1_experiment_runs` and a local hostname (`localhost` or `127.0.0.1`).

### Python connects to port 54322 or refuses a remote host

Export the repository DSN in the same shell:

```bash
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:57422/postgres'
```

Do not bypass the local-host guard. Sync, reset, and experiment operations are
designed for the disposable local bench database.

### A run unexpectedly starts `prepare`

`pnpm ops lab run` found `needsPrepare > 0`. Stop before starting the run if
the cost is unintended, inspect `pnpm ops lab corpus --json`, and either
prepare a bounded subset deliberately or run the direct experiment against
already-prepared rows.

### A run processes fewer entries than requested

Check:

- how many entries have embeddings
- the `--until` cutoff
- publisher attribution completeness
- topology-label freshness (`content_hash_at_labeling` must still match)
- whether the complete label set has enough eligible whole storylines

A normal non-topology direct experiment can process fewer than `--limit` when
fewer prepared eligible rows exist. A topology sampler is intended to return
the exact limit by filling packing shortfalls with eligible singletons, but it
still cannot invent eligible entries.

### Topology curation rejects the command

Supply all required controls:

```text
--limit
--topology-label-set
--multi-episode-percent
```

Use only a `complete` label set, remove `--per-agency`, and apply the topology
migration locally. Republish when entry content hashes or corpus membership
have materially changed.

### A run is already active

The operator harness has a single in-process run slot. Watch the current
dashboard stream or wait for that process to finish. Starting a direct Python
experiment in parallel is not coordinated by this slot and can corrupt the
comparison by resetting the same tables; do not do it.

### A run fails with no history row

The harness records completed runs, not an independent failure ledger. Inspect
the stage log. A report file is written immediately before the run-history
insert, and the rank snapshot is written immediately after it, so use the
database run row plus command success as the completion authority; remove or
rename any orphaned report before reusing the run name.

Common causes are missing model credentials, unapplied migrations, incomplete
publisher attribution, model/API errors, and an invalid environment override.

### The latest clustering state is partial

An interrupted replay may leave partial derived rows. Recover by running a new
`experiment`, which resets clusters first, or explicitly clear only derived
state:

```bash
uv run python -m pipeline.cli reset --clusters
```

Do not use `reset --features` unless the feature cache itself must be rebuilt.

### Results look cached after a prompt/model change

Use a changed model/prompt tag where the config supports it and rerun with
`--no-cache`. The bypass is safer than deleting `.cache/decisions.sqlite`
during an active experiment series.

## Pre-run checklist

- [ ] Local Supabase is running and migrations are current.
- [ ] `DATABASE_URL` is exported for direct Python commands.
- [ ] `pnpm ops lab corpus --json` receipt is saved or noted.
- [ ] Any sync is complete and the corpus is frozen for the series.
- [ ] `needsPrepare` is understood; no accidental unbounded prepare will run.
- [ ] Baseline and variant use the same input-selection contract.
- [ ] Stub/real mode and cache policy are explicit.
- [ ] Run name is unique and filesystem-safe.
- [ ] Only one process will mutate clustering tables.

## Post-run checklist

- [ ] Command succeeded and returned a run UUID.
- [ ] `complex_v1_experiment_runs` lists the run and the report opens.
- [ ] Processed count matches the intended eligible input.
- [ ] Config and topology selection match the experiment contract.
- [ ] Model errors and fallback rates are acceptable.
- [ ] Metrics were compared against the correct baseline.
- [ ] At least several concrete chains and borderline decisions were reviewed.
- [ ] Any ranking audit/labels are tied to the correct run UUID.
- [ ] The decision and known limitations are recorded alongside the reports.

## Related documents

- [Clustering lab quick guide](clustering-lab.md)
- [Topology-label curation](topology-label-curation.md)
- [Clustering experimentation spec](clustering-experimentation-spec-2026-07-18.md)
- [Topic clustering research validation](topic-clustering-research-validation-2026-07-18.md)
- [Operator CLI cheatsheet](cli-cheatsheet.md)
- [Infrastructure runbook](../infrastructure/runbook.md)
