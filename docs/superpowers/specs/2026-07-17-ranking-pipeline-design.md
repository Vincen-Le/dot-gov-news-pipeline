# Ranking Pipeline Design: Clustering, Deduplication, and Ranked Serving

**Date:** 2026-07-17
**Status:** Approved design, pre-implementation
**Scope:** Phase 4 of `architecture.md` — entry processing after normalization/deduplication: embeddings, semantic clustering, cross-source deduplication, rubric-based ranking, materialized serving, and semantic search.
**Assumes:** Feed polling and durable `feed_entries` persistence (Phases 1–3) are stable and functioning.

## Goals

1. Cluster related entries from different agencies/feeds into real-world stories.
2. Detect cross-feed syndicated duplicates without deleting provenance.
3. Rank stories globally and per facet (`topic`, `agency`, emergent `cluster_topic`) with an explainable, tunable formula.
4. Serve a materialized ranked result the frontend reads and streams (JSON + SSE); frontend renders OpenGraph cards.
5. Persist embeddings for semantic search via ChromaDB.
6. Near-realtime: an entry is clustered, judged, and ranked seconds after ingestion.
7. Stay on Cloudflare + Supabase. No non-Cloudflare inference.

## Non-goals

- Learned/trained ranker (rubric bits + human feedback collection come first).
- Article-body crawling (titles/summaries from feeds only; OG fetch is bounded per-URL metadata, not crawling).
- Personalization, user accounts, multi-region.

## Runtime topology

```text
TS poller (existing Phase 3)
  inserts feed_entries
  └─ fire-and-forget fetch → ranking Durable Object   (contentless wake ping)
                                  │
Cloudflare Cron (*/5) ────────────┤ safety wake
                                  ▼
                      Cloudflare Container (Python)
                      ├─ outbox drain loop (claims from Supabase)
                      ├─ ChromaDB in-process (rebuildable index)
                      ├─ Workers AI REST: embeddings + judge LLM
                      └─ FastAPI: /search endpoint (+ SSE if co-hosted)
                                  │
                      Supabase Postgres (source of truth, ranking, FTS)
                      R2 (Chroma snapshots)
```

- **Wake/sleep, not always-on.** Container requires Workers Paid; 24/7 uptime bills real money. DO wakes container on ingest ping or cron tick; container drains backlog, sleeps after ~10 min idle (`sleepAfter`). Gov news is business-hours-heavy; overnight sleep is the cost saving.
- **The wake ping carries nothing.** The database outbox is the authoritative backlog (matches the architecture-wide "DB is the backlog, queues/pings are transient" principle). Missed pings are caught by the 5-minute cron. Dropped pings lose no work.
- **Ephemeral disk.** Container has no persistent volume. Chroma inside it is a rebuildable index, never the durable store.

### Durability split

| Store | Holds | Durable? |
| --- | --- | --- |
| Supabase Postgres | Entries, embeddings (fp16 bytea), clusters, rubric bits, rank_key, FTS index | Yes — source of truth |
| ChromaDB (in container) | Embedding index for near-dup + semantic search | No — rebuilt on boot |
| R2 | Hourly Chroma snapshot | Yes — boot accelerator |

Boot sequence: load latest R2 snapshot → top-up from Postgres rows newer than snapshot watermark → serve. Seconds, not minutes.

## Outbox claim loop

Python worker claims unprocessed entries with the same lease pattern used elsewhere in the pipeline:

```sql
SELECT id, feed_id, title, summary, url, published_at
FROM feed_entries
WHERE processed_at IS NULL
ORDER BY id
FOR UPDATE SKIP LOCKED
LIMIT 32;
```

Loop: claim batch → process → mark `processed_at` → repeat until empty → idle → container sleeps. Worker crash leaves rows unclaimed; next wake picks them up. At-least-once with idempotent writes (below) converges.

## Per-entry processing pipeline

For each claimed entry:

1. **Embed.** Workers AI REST `@cf/baai/bge-large-en-v1.5` on `title + "\n" + summary`. 1024 dims. Batch inputs while draining. Store fp16 bytea in Postgres; upsert into Chroma with metadata `{entry_id, feed_id, agency, published_at}`.
2. **Near-dup check.** Chroma query against entries from the last 72 h. Cosine ≥ `NEAR_DUP_THRESHOLD` → syndicated duplicate: attach to the matched entry's cluster, mark `is_syndicated = true`, skip steps 3–4. Duplicate is kept as a cluster source record, never deleted.
3. **Cluster assign.** Compare against active cluster centroids (clusters with `newest_entry_at` in last 72 h; a few hundred max; held in worker memory as a numpy matrix, persisted as fp16 bytea on `story_clusters.centroid`). Cosine ≥ `CLUSTER_JOIN_THRESHOLD` → join best match, update centroid (running mean); else create new cluster.
4. **Facets.**
   - `agency`: from feed provenance. Zero inference.
   - `topic`: cosine against ~15 fixed-taxonomy label embeddings (precomputed once per taxonomy version). Assign argmax above a floor; else `null`.
   - `cluster_topic`: left null; filled by the nightly labeling pass (emergent topics).
5. **Attach + rank.** One RPC transaction (below) updates cluster aggregates and `rank_key`.
6. **Judge trigger.** If cluster is new or `entry_count` just crossed a power of two (1, 2, 4, 8, 16 …), enqueue an in-process judge task (async; never blocks the attach transaction).

**Threshold calibration.** `NEAR_DUP_THRESHOLD` and `CLUSTER_JOIN_THRESHOLD` were intuition-calibrated for OpenAI embedding space (≈0.93 / ≈0.80). BGE cosine distributions sit differently (compressed high range). Both are config values, not constants; calibrate against the first real corpus sample before locking, and store alongside `embedding_model` so a model swap forces recalibration.

### Per-entry cost budget

Gov corpus ≈ low thousands of entries/day, ~2–5/min peak:

| Step | Cost |
| --- | --- |
| Workers AI embedding (batched) | ~50 ms amortized |
| Chroma near-dup query (72 h window, in-process) | < 5 ms |
| Centroid match (~300 clusters × 1024 dims, numpy) | microseconds |
| Topic assign (~15 dot products) | negligible |
| Attach RPC transaction | ~20 ms |

Nothing scales with total corpus size — only with the 72 h active window.

## Ranking

### rank_key: exponential decay folded into a stored float

With exponential decay and a shared half-life, the relative order of two stories never changes with the passage of time — only when a story's inputs change. So time folds in as an additive term and the score is stored once:

```text
score(t) = base × 2^(-(t - t_story)/half_life)      # conceptual
rank_key = ln(base) + t_story/τ                     # stored; τ = half_life / ln(2)

ORDER BY rank_key DESC  ≡  ORDER BY score(now) DESC, at any future time
```

No decay sweeps. No periodic re-ranking. A row's `rank_key` is touched only when that row's inputs change.

### Formula

```text
rank_key = Σ bit_c · w_c                        # rubric interest points (judged)
         + w_a · ln(1 + distinct_agencies)      # corroboration
         + w_f · ln(1 + distinct_feeds)         # velocity / cluster size (feed-deduped)
         + ln(source_weight_max)                # static source authority table
         + epoch_seconds(newest_entry_at) / τ   # freshness; τ ≈ 124,600 s for 24 h half-life
```

- `distinct_feeds`, not `entry_count`: one chatty feed cannot inflate a story.
- `newest_entry_at` clamped to `now()` (publishers lie about dates; backfills must not nuke rankings) — each corroborating entry refreshes it, so developing stories resurface. Desired.
- Unjudged clusters use constant `prior_points` ≈ half the total rubric weight — new stories neither sink nor spike before judgment; replaced when the judge lands.
- Story expiry is a query filter (`newest_entry_at > now() - interval '7 days'`), never a score mutation.
- One `rank_key` serves global and every facet: categorical ranking is `WHERE topic = $1 ORDER BY rank_key DESC`. No per-facet scores or materialization.
- Implemented as one `IMMUTABLE` SQL function `compute_rank_key(...)` — single source of truth for both update paths.

### Rubric-based interest judging

One judge call per trigger returns a binary vector, not a scalar. Binary judgments are far more reliable from small/open models than calibrated 0–10 scores.

```text
System: You evaluate US government news stories. For each criterion, answer
strictly 0 or 1. Respond with JSON only.

Criteria:
- mass_impact:      affects daily life of a large share of Americans
- health_safety:    public health, safety, or emergency implications
- economic:         meaningful effect on jobs, prices, taxes, benefits, markets
- policy_change:    new/changed law, rule, regulation, or major program
- rights_legal:     civil rights, legal status, or court consequences
- national_scope:   national or multi-state, not single-locality
- urgency:          time-sensitive; public benefits from knowing now
- novelty:          unexpected or first-of-its-kind, not routine/periodic
```

Input: member entry titles/summaries + agency list + entry count. Output schema-enforced JSON (`response_format` json_schema): eight bits + `reason` (one sentence).

- **Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI, called via AI Gateway (logging, retries, response caching — idempotent rejudges of unchanged clusters hit cache). Budget fallback `@cf/meta/llama-3.1-8b-instruct`; escape hatch to Anthropic Haiku if open-weight judgments prove noisy — `judge_model` is config, bits/weights/versioning are model-agnostic.
- **Weights live in SQL, not in the LLM.** Bits are facts; a small `(rubric_version, criterion, weight)` table holds the dials. Retuning weights = one `UPDATE` recomputing `rank_key` from stored bits. Zero LLM re-calls. Changing criteria bumps `rubric_version`; old clusters score under their version until next rescore.
- **Rescore on size doubling** (1, 2, 4, 8, 16 entries): log-bounded calls per cluster; catches "story grew, judge should reconsider." A few hundred calls/day — inside Workers AI included allotments.
- **Failure mode:** timeout/error → keep `prior_points`, flag for retry in the nightly pass. Ranking never blocks on the judge.
- Stored per cluster: `rubric jsonb`, `rubric_version`, `judge_model`, `interest_reason`, `judged_at`. Bits + reason double as explainable frontend badges.

### Upsert: one RPC, one transaction, O(1) per entry

No separate `ranked_stories` table and no stored rank positions (positions are O(N) churn per change; ordering by an indexed float is O(1) per touch). `story_clusters` **is** the materialized ranking.

```sql
CREATE TABLE public.story_clusters (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centroid          bytea,                          -- fp16 × 1024, worker cache rebuild
  topic             text,                           -- fixed taxonomy
  cluster_topic     text,                           -- emergent label, filled nightly
  agency_ids        text[] NOT NULL DEFAULT '{}',
  distinct_feeds    int    NOT NULL DEFAULT 0,
  entry_count       int    NOT NULL DEFAULT 0,
  source_weight_max real   NOT NULL DEFAULT 1.0,
  rubric            jsonb,
  rubric_version    int,
  judge_model       text,
  interest_reason   text,
  judged_at         timestamptz,
  first_entry_at    timestamptz NOT NULL,
  newest_entry_at   timestamptz NOT NULL,
  rank_key          float8 NOT NULL,
  og                jsonb,                          -- representative card: og:title/image/description
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON story_clusters (rank_key DESC);
CREATE INDEX ON story_clusters (topic, rank_key DESC);
CREATE INDEX ON story_clusters USING gin (agency_ids);
CREATE INDEX ON story_clusters (newest_entry_at);

CREATE TABLE public.story_cluster_entries (
  cluster_id    uuid NOT NULL REFERENCES story_clusters(id),
  entry_id      uuid NOT NULL REFERENCES feed_entries(id),
  is_syndicated boolean NOT NULL DEFAULT false,
  attached_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, entry_id)
);
```

RLS enabled; anon gets read-only `SELECT` on serving columns at most; writes via service-role RPCs following the existing `SECURITY DEFINER` conventions (empty `search_path`, qualified relations, bounded args, `EXECUTE` revoked from `PUBLIC`/`anon`/`authenticated`).

**Path 1 — entry attach (synchronous, per entry):**

```sql
-- attach_entry_to_cluster(entry_id, cluster_id, agency, feed_id, published_at, source_weight)
BEGIN;
  INSERT INTO story_cluster_entries (cluster_id, entry_id, is_syndicated)
  VALUES ($cluster_id, $entry_id, $is_syndicated)
  ON CONFLICT DO NOTHING;                       -- replay-safe

  UPDATE story_clusters SET
    entry_count       = entry_count + 1,
    agency_ids        = CASE WHEN $agency = ANY(agency_ids)
                             THEN agency_ids ELSE array_append(agency_ids, $agency) END,
    distinct_feeds    = distinct_feeds + CASE WHEN <new feed for cluster> THEN 1 ELSE 0 END,
    newest_entry_at   = LEAST(now(), GREATEST(newest_entry_at, $published_at)),
    source_weight_max = GREATEST(source_weight_max, $source_weight),
    rank_key          = compute_rank_key(rubric, rubric_version, <new aggregates>...),
    updated_at        = now()
  WHERE id = $cluster_id;

  UPDATE feed_entries SET processed_at = now(), cluster_id = $cluster_id
  WHERE id = $entry_id AND processed_at IS NULL;  -- idempotency guard

  PERFORM pg_notify('rank_changed', $cluster_id::text);
COMMIT;
```

**Path 2 — judge lands (async, seconds later):** tiny second write — `UPDATE story_clusters SET rubric = $bits, ..., rank_key = compute_rank_key($bits, ...) WHERE id = $c`, plus the same `pg_notify`. New clusters appear immediately at neutral interest, snap to judged position seconds later.

Index maintenance per update: one btree row move. Nothing else churns.

## Serving

```sql
SELECT id, topic, cluster_topic, agency_ids, entry_count, rubric,
       interest_reason, og, newest_entry_at
FROM story_clusters
WHERE newest_entry_at > now() - interval '7 days'
ORDER BY rank_key DESC
LIMIT 50;
```

The time term dominates `rank_key`, so index order is roughly recent-first and the 7-day filter discards almost nothing during the scan. Milliseconds at this scale. Facets: add `WHERE topic = $1` or `WHERE agency_ids @> ARRAY[$1]`.

- **API:** JSON endpoints for pages; SSE for one-way live updates (per `architecture.md`). The SSE server holds one direct Postgres connection (Supabase transaction-mode pooler drops `LISTEN` — use session mode or a direct connection), listens on `rank_changed`, pushes cluster diffs. Fallback: 5 s in-memory top-N snapshot diff.
- **OpenGraph:** a low-priority worker loop fetches OG tags (og:title/image/description) only for clusters entering the top ~200 without `og` populated. Bounded per-URL metadata fetch with the same SSRF protections as discovery; never full-corpus crawling. Frontend renders cards from `og` jsonb with zero client-side fetching.

## Search

Two indexes, both rebuildable, both queryable from day one:

1. **Keyword (instant, always on):** Postgres `tsvector` GIN over entry titles/summaries. Served straight from Supabase; zero cold start.
2. **Semantic (Chroma):** frontend → Worker `/search` route → Worker embeds the query via `env.AI.run('@cf/baai/bge-large-en-v1.5', ...)` **with the BGE query instruction prefix** (`"Represent this sentence for searching relevant passages: "` — queries only, never documents) → ranking DO → container Chroma query → results.

Cold-start honesty: if the container is asleep, first semantic search pays boot + snapshot load (~2–5 s); warm after (`sleepAfter` resets per request; ingest pings keep it warm during business hours). Frontend UX: show keyword results immediately, stream semantic results in when ready. If cold semantic search ever becomes unacceptable, swap the search index to Supabase pgvector (embeddings already durable in Postgres); Chroma stays for worker-internal near-dup/centroid work. Escape hatch, not MVP work.

## Nightly consolidation pass

Online greedy clustering drifts. One nightly job:

1. **Merge:** pairwise centroid similarity over active clusters (~300²/2 comparisons, trivial). Pairs ≥ merge threshold: winner keeps id; aggregates recomputed once from junction rows (the only full recompute anywhere, scoped to merged clusters).
2. **Label:** `cluster_topic` for unlabeled clusters ≥ 2 entries — c-TF-IDF over member titles, or one cheap judge-model call. Emergent topics surface here.
3. **Retry:** failed judge calls.
4. **Snapshot hygiene:** verify latest R2 Chroma snapshot; prune expired-window Chroma entries.

## Configuration (not constants)

| Key | Initial | Notes |
| --- | --- | --- |
| `EMBEDDING_MODEL` | `@cf/baai/bge-large-en-v1.5` | 1024 dims; `bge-base` (768) is the DB-size pressure valve |
| `JUDGE_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | via AI Gateway |
| `NEAR_DUP_THRESHOLD` | calibrate on real corpus | BGE-space, not OpenAI-space |
| `CLUSTER_JOIN_THRESHOLD` | calibrate on real corpus | ditto |
| `HALF_LIFE` | 24 h | τ = half_life/ln(2) |
| `ACTIVE_WINDOW` | 72 h | clustering/near-dup horizon |
| `SERVING_WINDOW` | 7 days | query filter |
| `PRIOR_POINTS` | ½ Σ rubric weights | unjudged default |
| Rubric weights | table-driven | retune without LLM calls |

## Failure semantics

- Wake ping lost → 5-min cron catches backlog. DB outbox never loses work.
- Worker crash mid-batch → unclaimed rows re-claimed on next wake; attach RPC is replay-safe (`ON CONFLICT DO NOTHING` + `processed_at` guard).
- Workers AI embedding failure → entry stays unprocessed, retried next drain.
- Judge failure → neutral `prior_points`, nightly retry. Ranking never blocks.
- Container disk loss → Chroma rebuilt from R2 snapshot + Postgres top-up.
- Supabase unavailable → drain loop backs off; nothing acknowledged without durable write.

## Observability additions

Beyond the existing pipeline metrics: outbox depth and oldest-unprocessed age; entries/clusters per day; near-dup rate; cluster-join vs new-cluster ratio; judge latency/failure/cache-hit rates; rubric bit distributions per version (drift detection); rank_key churn; SSE client count; Chroma snapshot age; container wake count and awake-hours/day (cost proxy); Supabase DB size (embedding growth ≈ 2 KB/entry).

## Cost posture (MVP)

- Workers Paid $5/mo (unlocks Containers; includes Workers AI + queue allotments).
- Container: wake/sleep keeps usage near included allotments; awake-hours metric watches this.
- Workers AI: embeddings + a few hundred judge calls/day — free-tier/included scale.
- Supabase free: 500 MB gate — embeddings dominate; `bge-base` fallback halves it.
- R2: snapshots, negligible.

## Open items for implementation planning

1. Calibrate BGE thresholds on first real corpus sample (blocking for cluster quality).
2. Author fixed topic taxonomy (~15 labels + descriptive sentences for embedding).
3. Author `source_weight` seed table (cabinet departments > sub-offices).
4. Decide SSE host: same container (simple) vs thin Worker with DO fan-out (scales better). MVP: same container.
5. A/B judge models (70B vs 8B) on stored rubric bits before locking `JUDGE_MODEL`.
6. Validate Workers AI `response_format` json_schema support for the chosen judge model version.
