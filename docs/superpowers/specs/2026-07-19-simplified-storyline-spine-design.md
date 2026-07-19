# Simplified Storyline Spine — Design

**Date:** 2026-07-19
**Status:** Proposed (research-challenged amendments applied)
**Companion plan:** `docs/superpowers/plans/2026-07-19-simplified-storyline-spine.md`

## Purpose

Build a second, much simpler aggregation pipeline ("spine") in a new `spine/`
directory, fully separate from the existing five-stage engine
(`episodes.py` → `storylines.py` → `cards.py` → `categories.py` →
`topics.py`/`promotion.py`), but hooked into the same experimentation harness
(`experiment_runs`, `pnpm ops lab run`, `docs/eval/<name>/report.md`,
`rank_snapshots`) so the two engines can be A/B'd on identical corpora.

Testing space is small (<2000 articles; a 1,181-entry golden slice exists
but is **not yet QAed** — treat its labels as unvetted). Simplicity and
measurability beat cleverness.

## Proposed architecture (as requested)

1. **Preparation** per article (title, summary, body_text):
   - `enriched_text`: LLM compresses title+summary into one dense
     sentence optimized for semantic search.
   - `enriched_text_embedding`: embed the enriched text.
   - `category`: LLM picks one seeded category; prompt defines decision
     criteria per category.
   - `theme`: null.
2. **Processing** decision tree per article:
   - Embedding similarity against every storyline's dense overview
     (master node).
   - LLM judge decides: join a recent active episode (time burst), join
     the storyline as a new episode (time burst), or spawn a new
     storyline.
   - Master node always exists — a dense overview of the chain, for
     multi-episode chains and singletons alike.
   - Event cards are checkpoints: every episode addition captures a new
     snapshot of the storyline.
3. **Themes** (parallel sweep): loose clustering into batches of 10–15
   similar storylines; LLM detects patterns and mints themes of minimum
   size 5; retroactively merge too-granular themes and split too-broad
   ones as the table grows.
4. **Ranking**: reuse the existing `rank_key` system per storyline.

## Research challenges and amendments

A literature review (Miranda et al. EMNLP 2018; Saravanakumar et al. EACL
2021; Petukhova et al. 2024; SemEval-2022 Task 8; Zheng et al. NeurIPS 2023;
TnT-LLM WWW 2024; EpiMine 2024; Papadakis et al. CSUR 2020; Chi et al. KDD
2007) was run against the proposal. Verdicts:

| # | Proposal element | Verdict | Amendment |
|---|---|---|---|
| 1 | Match new articles against the storyline's LLM **dense-overview embedding only** | **Rejected as sole retrieval signal.** No published system does this. A regenerated overview is a summary-of-summaries: its embedding drifts as the chain grows (classic chaining — A joins because of B, overview shifts, C joins because of the shifted overview), and big-storyline overviews become hubs that attract loosely related articles. Miranda 2018 (B³ 92.4) and Saravanakumar 2021 (B³ 94.8, −79% fragmentation) both match against pooled **member** representations plus explicit time features. | Retrieve candidates by **max cosine against member-entry embeddings** (trivially cheap at this corpus size; centroid kept as tiebreak/observability). The dense overview is kept — as the **judge's context** and the serving artifact, where it genuinely helps — just not as the retrieval key. |
| 2 | Embed a **one-sentence LLM compression** as the only vector | **High-risk default.** Petukhova 2024: summarize-then-embed degrades clustering; compression only pays when documents are long/noisy — a press-release title+summary is already short. SemEval-2022 T8 and Saravanakumar 2021: entity signal carries same-event matching, and one dense sentence collapses it. | Keep `enriched_text`, but (a) the prompt must be **entity-lossless** — every agency, named person, program, place, and date must survive compression — and (b) the embed source is a config knob (`SPINE_EMBED_SOURCE=enriched\|raw`, default `enriched` to honor the proposal) so the harness can A/B it against raw title+summary. This is exactly the experiment the harness exists for. |
| 3 | **LLM judge** as attach authority | **Supported with conditions.** Retrieve-then-judge is validated (hybrid shortlist+LLM beat embedding-only assignment; EpiMine validates burst-propose/LLM-confirm). But judges flip ~1/3 of pairwise verdicts under order swap (Zheng 2023), worst on borderline cases, and greedy single-pass assignment is permanently order-dependent with no repair. | Judge sees a **top-k shortlist in one listwise prompt** (fixed similarity order, explicit `none` option) with entity overlap and time gap stated as facts, not inferred. Every verdict logs method/similarity/reason into existing audit columns. Repair pass deferred (logged margins make it possible later); order-shuffle variance is an eval, not a v1 mechanism. |
| 4 | **Category at enrichment** | **Keep as metadata, never as a blocking key.** Blocking-survey result (Papadakis 2020): pairs split across blocks are unrecoverable; LLM category errors cluster exactly at boundary cases (an antitrust action is both "enforcement" and "competition"). At <2000 articles there is no efficiency need for blocking. | Category assigned per storyline at creation (schema has `storylines.category_id`; no new migration) from the seed taxonomy. Shown to the judge as context; **never filters candidates**. |
| 5 | Themes from **batches of 10–15** storylines, LLM pattern detection, retroactive merge/split | **Batching rejected; sweep + retroactivity kept.** Batch-local induction mints near-duplicate themes that depend on arbitrary batch boundaries, then requires the merge machinery to clean up its own artifacts. TnT-LLM and the BERTopic lineage induce themes with **global visibility**; Chi 2007: merge/split without smoothness causes label churn. | Periodic sweep runs **global** average-linkage clustering over storyline centroids (pure numpy; corpus is tiny), min theme size 5 enforced structurally. LLM's job is unchanged in spirit — confirm the pattern and name it. Retroactivity comes free: each sweep reclusters globally and reconciles against existing themes by member overlap (ID survives at ≥50% overlap; merge/split otherwise), which is **simpler** than batch orchestration plus repair. |
| 6 | **Time-burst episodes** | **Supported** (EpiMine; Saravanakumar's Gaussian time term). Risk is only the ad-hoc constant. | Single gap rule: a storyline's episode is "active" if its newest entry is within `SPINE_EPISODE_GAP_HOURS` (default 48h — .gov cadence is spikier than newswire; the classic engine's 4h is a knob to sweep, not a truth). Kleinberg-style adaptive gaps are explicitly deferred. |
| 7 | Evaluation | **Gap in current harness confirmed.** Only operational proxies exist (singleton rates, attach mixes). The 1,181-entry golden set is curated but **not yet QAed — its labels must not drive decisions**. B³ alone also under-penalizes fragmentation of small clusters. | V1 comparison uses **operational metrics + manual QA** (existing lab storyline-QA and borderline-labeling surfaces). A golden scorer (B³ P/R/F1, pairwise F1, ARI) is a **follow-up explicitly gated on golden-set QA** — the metric math is trivial; the labels are the blocker. |

Everything else in the proposal survives unchanged: two-phase
prepare/replay, judge-gated joins, master node for singletons, event cards
as per-episode checkpoints (this is literally how `event_cards` already
works — write-once rows with `version`/`superseded_by`), and rank_key reuse
(`compute_rank_key` fires inside the `insert_event_card` RPC; zero new work).

## Amended architecture

### Data flow

```
prepare (shared machinery, classic enrichment — see "Out of scope" below):
  news_entries → enriched_text (entity-lossless) → embedding (fp16, source knob)

replay (spine/replay.py), event-time order (published_at, id):
  entry
   ├─ content-hash dup within window?  → attach syndicated to same episode
   ├─ retrieve: top-k storylines by max member-embedding cosine ≥ floor
   ├─ no candidates → new storyline + episode + category + initial overview card
   └─ judge (listwise, one call): same-story? same-development?
        ├─ same development & episode active (gap rule) → attach to episode
        ├─ same story, new development                  → new episode
        └─ none                                         → new storyline
  episode close (gap-based, event time) → CardEngine (reused as-is):
        episode card + regenerated overview card + rank_key
  every SPINE_THEME_SWEEP_INTERVAL_HOURS of event time + at end:
        global agglomerative sweep → LLM confirm/name → theme reconcile
```

### Components (new `spine/` package)

| File | Responsibility |
|---|---|
| `spine/prompts.py` | Entity-lossless enricher system prompt; listwise link-judge prompt; theme confirm/name prompt |
| `spine/index.py` | In-memory storyline index: member vectors, centroids, open-episode state; pure candidate retrieval (`top_candidates`) and burst rule (`episode_active`) |
| `spine/linker.py` | Decision tree: dup → retrieve → judge → act (create/attach via `Store` RPCs); initial overview card at storyline birth |
| `spine/themes.py` | Global average-linkage sweep, LLM theme confirmation, persistent-ID reconciliation (merge/split by member overlap) |
| `spine/replay.py` | Event-time driver: ordering, window, episode close, CardEngine calls, sweep scheduling, report dict |

Reused untouched: `pipeline/db.py`, `store.py`, `vectors.py`, `cards.py`,
`window.py`, `cache.py`, `stub.py`, `bench.py`, `rank.py`,
`experiment.py` (summarize/report/record), golden tooling. Model layer gains
two methods (`link_storyline`, `induce_theme`) on `WorkersAI`/`StubModels`
with `CachedModels` memoization.

### Harness integration

- `Config.engine` (`LAB_ENGINE=classic|spine`, default `classic`) plus spine
  knobs (all env-overridable): `SPINE_SIM_FLOOR` (0.60), `SPINE_TOP_K` (3),
  `SPINE_EPISODE_GAP_HOURS` (48), `SPINE_EMBED_SOURCE` (`enriched`),
  `SPINE_THEME_MIN_SIZE` (5), `SPINE_THEME_LINK_SIM` (0.55),
  `SPINE_THEME_SWEEP_INTERVAL_HOURS` (168), `SPINE_THEME_KEEP_OVERLAP` (0.5).
- `run_experiment` dispatches the replay driver by `cfg.engine`; everything
  downstream (summarize → report → `experiment_runs` row → rank snapshot) is
  unchanged. The TS whitelist (`LAB_ENV_WHITELIST`) gains the new keys, so
  `pnpm ops lab run --name spine-baseline --set LAB_ENGINE=spine` just works.
- Both engines write the same derived tables, so `reset_clusters`, the
  dashboard, storyline QA, and rank audit all apply to spine runs unchanged.

### Parallel bench isolation

The classic engine's evaluation state lives in the primary bench database
(`postgres` on the local Supabase cluster, port 57422). Spine runs in a
**second database in the same cluster** (`spine_bench`) so the two engines'
derived state never clobbers each other (`reset_clusters` wipes derived
tables — same-DB coexistence is impossible).

This costs zero engine code: every consumer — `pipeline.cli`, the TS lab
harness, and the dashboard — resolves its DSN from `DATABASE_URL`
(`apps/operator-console/src/config.ts:60` falls back to the primary), and
`bench.assert_local_dsn` guards host, not database name. Provisioning script
(`scripts/create-spine-bench.sh`, precedent:
`scripts/test-news-source-migration.sh`) clones the primary via
`pg_dump | psql` inside the Supabase container — corpus, prepared features
(embeddings, enrichment: the expensive half), RPCs, and grants come across
identically with no re-prepare — then truncates `experiment_runs` history
and wipes derived clustering state.

Second dashboard/CLI mounts against it with env only. Entrypoint ↔ database
mapping (the startup reference; also documented in
`docs/operations/clustering-lab.md`):

| Engine | Database | Experiment entrypoint | Dashboard |
|---|---|---|---|
| classic | `…:57422/postgres` (default — no env) | `uv run python -m pipeline.cli experiment NAME` / `pnpm ops lab run --name NAME` | `pnpm ops dashboard` → 4173 |
| spine | `…:57422/spine_bench` (`DATABASE_URL` required) | same commands prefixed `DATABASE_URL=$SPINE_DB LAB_ENGINE=spine` (lab: `--set LAB_ENGINE=spine`) | `DATABASE_URL=$SPINE_DB pnpm ops dashboard --port 4174` |

Spine work always pairs `DATABASE_URL` + `LAB_ENGINE` — setting only one
runs the wrong engine or the wrong database.

### Multi-pipeline experimentation standard

Studied `autoresearch/jul19` (read-only): it adds **no schema** — it consumes
main's `experiment_runs` + `rank_snapshots` unchanged and keeps its loop
scores in git-committed files (invisible to the dashboard; not a pattern to
copy). The pattern worth standardizing is main's own, proven across two
subsystems (clustering, ranking):

- **Run-header + snapshot-detail split**: one small `experiment_runs` row
  (config/report/summary jsonb, size-capped, secrets redacted) referencing
  frozen `rank_snapshots` detail rows via `run_id`, with **no FKs to live
  tables** and denormalized display fields — this is what makes replaying
  old experiments possible after every reset wipes the live derived tables.
- **RLS + service-role-only grants** per table; jsonb `pg_column_size`
  caps; content-stable ordering.

Neither table has any pipeline/engine scoping today.

> **Coordination note (2026-07-19):** a concurrent session (worktree
> `local-dev-setup-process-67aa52`) is actively standardizing this in the
> live primary database with per-pipeline TABLE families —
> `complex_v1_experiment_runs` + `complex_v1_experiment_cluster_snapshots`
> observed — i.e. `{pipeline}_experiment_runs` +
> `{pipeline}_experiment_cluster_snapshots` in ONE database, with cluster-
> state snapshots (not just rank snapshots) for experiment replay. That
> convention supersedes the per-database scoping sketched below where they
> conflict; spine should adopt `spine_v1_experiment_runs` +
> `spine_v1_experiment_cluster_snapshots` once that session's migrations
> land. Task 9 is paused pending that convergence.

The per-database standard as originally sketched:

1. **One bench database per pipeline, identical schema.** Each pipeline
   (classic, spine, future engines) gets its own database in the local
   cluster carrying the full standard table set: synced corpus + prepared
   features, its own live derived tables, and its own `experiment_runs` +
   `rank_snapshots` (+ rank audit tables). Provisioning = the parameterized
   clone script (`scripts/create-spine-bench.sh NAME`, `SOURCE_DATABASE`
   env). Same table names in every database — the database IS the pipeline
   scope, so no `engine` column migration is needed; the redacted config
   jsonb already embeds `engine` for self-description of each run.
2. **Pipeline registry** (`config/pipelines.json`): the single source of
   truth mapping pipeline name → engine → database URL → dashboard port.
   Replaces tribal knowledge of entrypoint/DB pairings.
3. **Dashboard rotation**: the operator console loads the registry and can
   switch its lab surface between pipelines — pipeline views (live derived
   state), experiment views (`experiment_runs` history), and replay of old
   experiments (`rank_snapshots` by `run_id`) — one dashboard, N pipelines.
   Console query modules (`LabQueries`, `RankQueries`) already take a
   connection, so rotation is a per-pipeline connection, not a rewrite.

### Success criteria

1. `pnpm ops lab run --stub --set LAB_ENGINE=spine` completes: report +
   `experiment_runs` row + rank snapshot.
2. A real spine run and a classic baseline run over the same slice produce
   comparable reports (attach mixes, singleton rates, chains, themes) plus a
   manual-QA A/B notes doc — the comparison the whole exercise exists for.
3. Master-node invariant holds: zero live storylines without an overview
   card.

### Out of scope (v1)

Kleinberg burst modeling; storyline-level retroactive repair (margins are
logged to enable it later); learned ranking; **golden scoring** (B³/pairwise
F1/ARI — gated on QA of `golden_news_entries`; do first after labels are
vetted); hosted/scheduled operation; theme hierarchy; wiring
`SPINE_ENRICHER_SYSTEM` + `SPINE_EMBED_SOURCE` into `prepare` (v1 evaluates
on classic enrichment — any A/B readout must not be attributed to
enrichment differences).
