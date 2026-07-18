# Ranking Pipeline Design: Clustering, Deduplication, and Ranked Serving

**Date:** 2026-07-17
**Status:** Approved design, pre-implementation
**Scope:** Phase 4 of `architecture.md` — entry processing after normalization/deduplication: embeddings, semantic clustering, cross-source deduplication, rubric-based ranking, materialized serving, and semantic search.
**Assumes:** News-source fetching and durable `news_items` persistence (Phases 1–3) are stable and functioning.

## Goals

1. Cluster related items from different agencies/news sources into real-world stories.
2. Detect cross-source syndicated duplicates without deleting provenance.
3. Rank stories globally and per facet (`topic`, `agency`, emergent `cluster_topic`) with an explainable, tunable formula.
4. Serve a materialized ranked result the frontend reads and streams (JSON + SSE); frontend renders OpenGraph cards.
5. Persist embeddings for semantic search via ChromaDB.
6. Near-realtime: an entry is clustered, judged, and ranked seconds after ingestion.
7. Stay on Cloudflare + Supabase. No non-Cloudflare inference.

## Non-goals

- Learned/trained ranker (rubric bits + human feedback collection come first).
- Article-body crawling (titles/summaries from source adapters only; OG fetch is bounded per-URL metadata, not crawling).
- Personalization, user accounts, multi-region.

## Runtime topology

```text
TS poller (existing Phase 3)
  inserts news_items
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

| Store                   | Holds                                                                                                                                           | Durable?               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Supabase Postgres       | Entries, embeddings (fp16 bytea), clusters, rubric bits, rank_key, FTS index                                                                    | Yes — source of truth  |
| ChromaDB (in container) | Two collections: `hot` (72 h working set — near-dup + centroid ops, pruned nightly) and `search` (append-only full history for semantic search) | No — rebuilt on boot   |
| R2                      | Hourly Chroma snapshot                                                                                                                          | Yes — boot accelerator |

Boot sequence: load latest R2 snapshot → top-up from Postgres rows newer than snapshot watermark → serve. Seconds, not minutes.

## Outbox claim loop

Python worker claims unprocessed entries with the same lease pattern used elsewhere in the pipeline:

```sql
SELECT id, news_source_id, title, summary, url, published_at
FROM news_items
WHERE processed_at IS NULL
ORDER BY id
FOR UPDATE SKIP LOCKED
LIMIT 32;
```

Loop: claim batch → process → mark `processed_at` → repeat until empty → idle → container sleeps. Worker crash leaves rows unclaimed; next wake picks them up. At-least-once with idempotent writes (below) converges.

## Per-entry processing pipeline

For each claimed entry:

1. **Exact dedupe (deterministic, zero-cost).** Before any embedding:
   - **Canonical URL match:** lookup `news_items.url_canonical` (indexed) among already-processed entries whose clusters are still unsealed (growth window, below). Two sources pointing at the same canonicalized article URL = same article, no inference needed.
   - **Content hash match:** lookup `content_hash = sha256(normalized(title) || normalized(summary))` (indexed), same unsealed scope. Catches verbatim syndication where URLs differ. (Republished old content past the seal becomes a new single-source cluster with old/clamped timestamps — born ranked low, sinks immediately.)
   - Hit on either → attach as syndicated duplicate (`attach_method = 'exact_url'` or `'content_hash'`), skip steps 2–4.
   - Both values are computed **at ingest** in the TS normalization stage (cheap, deterministic, language-neutral); the dedupe _decision_ lives here because it needs cross-source scope and cluster attachment. Per-source idempotency (`UNIQUE(news_source_id, external_item_id)`) remains upstream and unchanged.
2. **Embed.** Workers AI REST `@cf/baai/bge-large-en-v1.5` on `title + "\n" + summary`. 1024 dims. Batch inputs while draining. Store fp16 bytea in Postgres; upsert into Chroma with metadata `{entry_id, news_source_id, agency, published_at}`.
3. **Near-dup check (fuzzy).** Chroma query against entries from the last 72 h. Cosine ≥ `NEAR_DUP_THRESHOLD` → syndicated duplicate (edited/reformatted copies the exact checks miss): attach to the matched entry's cluster with `attach_method = 'near_dup'`, skip step 4. Duplicate is kept as a cluster source record, never deleted.
4. **Cluster assign — cosine nominates, entities gate, LLM arbitrates.** Compare against **unsealed** cluster centroids (clusters with `first_entry_at > now() - CLUSTER_GROWTH_WINDOW`; a couple hundred max; held in worker memory as a numpy matrix, persisted as fp16 bytea on `story_clusters.centroid`). Clusters accept members only within the growth window of their **birth** — birth-anchored, so eligibility cannot roll forward on new attaches; after the window a cluster is **sealed** (membership frozen; ranking/serving/decay unaffected). A similar event days later structurally cannot join — it gets its own card at any cosine value. Dedupe exists to absorb the echo burst (release → same-day syndication → next-day statements), not multi-day event aliasing; sealing also structurally bounds drip-feed stories (post-seal developments become their own cards with their own clocks). Cosine ≥ `CLUSTER_JOIN_THRESHOLD` produces a **merge candidate**, not a decision — same-template distinct events (two different drug recalls in one week) embed nearly identically, so no cosine threshold alone can separate them. Candidate resolution:

   | Candidate state                          | Decision                                                         |
   | ---------------------------------------- | ---------------------------------------------------------------- |
   | Entity sets overlap                      | Auto-join, `attach_method = 'centroid_join'` (fast path, no LLM) |
   | Entity sets disjoint (both non-empty)    | LLM arbitrates (split-biased)                                    |
   | Entity sets inconclusive (an empty side) | LLM arbitrates (split-biased)                                    |
   | LLM timeout/error                        | Split — safe default, nightly pass re-merges if wrong            |
   - **Entity evidence.** Salient discriminators extracted from title + first summary sentence (see extraction algorithm below). Disjoint sets are _evidence of distinct events_ (two different drugs/companies), but not final authority — the same event can surface different discriminators per source (FDA names the drug, HHS names the manufacturer), so conflicts go to arbitration rather than auto-veto. Extracted entities stored as attach evidence; cluster keeps a union `entity_set` for future comparisons.
   - **LLM adjudicator.** One `ADJUDICATOR_MODEL` call with both titles/summaries _and_ both entity sets: "same specific real-world event? {same_event, reason}". Prompt is split-biased ("true only if clearly the same specific event; different products, companies, cases, or locations = different events"); defaults to false. `attach_method = 'adjudicated_join'` / `'adjudicated_new'`, reason recorded. Fires only on conflicted/inconclusive candidates — single-digit calls/day.
   - **`adjudicated_join` is the riskiest decision type in the pipeline** — the only path where inference can put two events on one card. Contained three ways: split-biased prompt, QA sampler reviews 100% of adjudicated joins at MVP volume, and nightly split detection backstops.
   - Join updates the centroid (running mean); any no-join outcome creates a new cluster.
   - **Bias is deliberate:** over-merge puts two events on one card (user-visible correctness bug); under-merge shows duplicate cards (cosmetic). Ambiguity resolves toward split; the nightly consolidation pass re-merges false splits later with fuller context (more members, richer entity sets).

5. **Facets.**
   - `agency`: from feed provenance. Zero inference.
   - `topic`: cosine against ~15 fixed-taxonomy label embeddings (precomputed once per taxonomy version). Assign argmax above a floor; else `null`.
   - `cluster_topic`: left null; filled by the nightly labeling pass (emergent topics).
6. **Attach + rank.** One RPC transaction (below) updates cluster aggregates and `rank_key`, and records the attach decision evidence (method, similarity, matched entry, threshold) on the junction row.
7. **Judge trigger.** If cluster is new or `entry_count` just crossed a power of two (1, 2, 4, 8, 16 …), enqueue an in-process judge task (async; never blocks the attach transaction).

**Dedupe layering rationale.** Exact checks are free and unarguable, so they run first and catch the bulk of verbatim syndication; embedding similarity is reserved for the fuzzy remainder. Every exact hit is also a skipped Workers AI embedding call and a skipped Chroma query.

### Salient-discriminator extraction (entity guard internals)

Pure, versioned function — no ML, no network, no clock. Same `(title, summary, extractor_version)` → identical set on any instance, any replay.

```text
extract(title, summary, cfg):
  text = NFKC(title + ". " + first_sentence(summary))
  candidates  = regex matches (recall/docket/case numbers, CFR cites, lot/model numbers, dollar amounts)
              ∪ tokens of capitalized spans (sentence-initial singletons excluded)
  candidates -= cfg.agency_lexicon        # FDA, HHS, Department, Administration…
  candidates -= cfg.boilerplate_lexicon   # Announces, Recall, Statement, months, weekdays…
  candidates -= cfg.common_english        # frozen top-N wordlist (Blood, Pressure, Medication…)
  return { casefold(strip_punct(t)) : len(t) >= cfg.min_len }
```

Subtractive by design: Title Case gov headlines capitalize nearly everything, so the wide capitalization net is filtered by three **frozen lexicons**; survivors are event-specific names (drugs, companies, IDs, places, amounts).

Rules of the guard:

- **Precision over recall.** Empty/weak extraction never vetoes — it returns _inconclusive_ and defers to the LLM adjudicator (e.g. ALL-CAPS titles destroy the capitalization signal; they fall through safely).
- **Config is versioned data.** Lexicons + regex list live in a Postgres table keyed by `extractor_version` (same pattern as `rubric_version`); versions are immutable — edits create a new version. Attach evidence records `extractor_version`, so every historical decision is exactly reproducible and proposed extractor changes can be retro-evaluated against recorded history without reprocessing.
- **One implementation site.** Extraction runs only in the Python worker — never duplicated in TS — so cross-language drift is impossible. (`url_canonical`/`content_hash` are the mirror case: computed only in TS at ingest.)
- **Failure asymmetry is safe.** Spurious veto → duplicate cards → nightly consolidation re-merges with fuller entity unions (self-healing). No extraction failure mode can merge two distinct events onto one card — the guard only ever blocks merges.

**Threshold calibration.** `NEAR_DUP_THRESHOLD` and `CLUSTER_JOIN_THRESHOLD` were intuition-calibrated for OpenAI embedding space (≈0.93 / ≈0.80). BGE cosine distributions sit differently (compressed high range). Both are config values, not constants; calibrate against the first real corpus sample before locking, and store alongside `embedding_model` so a model swap forces recalibration.

### Per-entry cost budget

Gov corpus ≈ low thousands of entries/day, ~2–5/min peak:

| Step                                              | Cost             |
| ------------------------------------------------- | ---------------- |
| Workers AI embedding (batched)                    | ~50 ms amortized |
| Chroma near-dup query (72 h window, in-process)   | < 5 ms           |
| Centroid match (~300 clusters × 1024 dims, numpy) | microseconds     |
| Topic assign (~15 dot products)                   | negligible       |
| Attach RPC transaction                            | ~20 ms           |

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
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centroid               bytea,                          -- fp16 × 1024, worker cache rebuild
  topic                  text,                           -- fixed taxonomy
  cluster_topic          text,                           -- emergent label, filled nightly
  agency_ids             text[] NOT NULL DEFAULT '{}',
  distinct_feeds         int    NOT NULL DEFAULT 0,
  entry_count            int    NOT NULL DEFAULT 0,
  source_weight_max      real   NOT NULL DEFAULT 1.0,
  cohesion               real,                           -- nightly mean member↔centroid similarity
  entity_set             text[] NOT NULL DEFAULT '{}',   -- union of member salient discriminators (entity guard)
  merged_into            uuid REFERENCES story_clusters(id),  -- set by consolidation; excluded from serving, permalink 301s to winner
  representative_entry_id uuid REFERENCES news_items(id),  -- owns card click + OG fetch
  rubric                 jsonb,
  rubric_version         int,
  judge_model            text,
  interest_reason        text,
  judged_at              timestamptz,
  first_entry_at         timestamptz NOT NULL,
  newest_entry_at        timestamptz NOT NULL,
  rank_key               float8 NOT NULL,
  og                     jsonb,                          -- representative card: og:title/image/description
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON story_clusters (rank_key DESC);
CREATE INDEX ON story_clusters (topic, rank_key DESC);
CREATE INDEX ON story_clusters USING gin (agency_ids);
CREATE INDEX ON story_clusters (newest_entry_at);

CREATE TABLE public.story_cluster_entries (
  cluster_id       uuid NOT NULL REFERENCES story_clusters(id),
  entry_id         uuid NOT NULL REFERENCES news_items(id),
  is_syndicated    boolean NOT NULL DEFAULT false,
  -- attach decision evidence (auditability/QA):
  attach_method    text NOT NULL,        -- exact_url | content_hash | near_dup | centroid_join
                                         -- | adjudicated_join | adjudicated_new | new_cluster
                                         -- | consolidation_merge | consolidation_split
  similarity       real,                 -- cosine at decision time (null for exact/new)
  matched_entry_id uuid REFERENCES news_items(id),  -- what it matched (dups)
  threshold_used   real,                 -- config value in force at decision time
  embedding_model  text,                 -- model that produced the similarity
  attached_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, entry_id)
);

CREATE INDEX ON story_cluster_entries (entry_id);   -- entry → cluster reverse lookup
```

`news_items` additionally carries a denormalized `cluster_id` (set by the attach RPC), so both directions are one FK hop: cluster → members via the junction, entry → cluster directly. The junction row is the **audit record**: every membership decision stores what method made it, against what, at what similarity, under which threshold and model. Clustering QA becomes plain SQL, and threshold recalibration can be evaluated retroactively against recorded decisions.

RLS enabled; anon gets read-only `SELECT` on serving columns at most; writes via service-role RPCs following the existing `SECURITY DEFINER` conventions (empty `search_path`, qualified relations, bounded args, `EXECUTE` revoked from `PUBLIC`/`anon`/`authenticated`).

**Path 1 — entry attach (synchronous, per entry):**

```sql
-- attach_entry_to_cluster(entry_id, cluster_id, agency, news_source_id, published_at, source_weight,
--                         attach_method, similarity, matched_entry_id, threshold_used, embedding_model)
BEGIN;
  INSERT INTO story_cluster_entries (cluster_id, entry_id, is_syndicated,
                                     attach_method, similarity, matched_entry_id,
                                     threshold_used, embedding_model)
  VALUES (...)
  ON CONFLICT DO NOTHING;                       -- replay-safe

  UPDATE story_clusters SET
    entry_count       = entry_count + 1,
    agency_ids        = CASE WHEN $agency = ANY(agency_ids)
                             THEN agency_ids ELSE array_append(agency_ids, $agency) END,
    distinct_feeds    = distinct_feeds + CASE WHEN <new feed for cluster> THEN 1 ELSE 0 END,
    newest_entry_at   = LEAST(now(), GREATEST(newest_entry_at, $published_at)),
    source_weight_max = GREATEST(source_weight_max, $source_weight),
    representative_entry_id = <recompute: earliest non-syndicated entry from highest-weight feed>,
    rank_key          = compute_rank_key(rubric, rubric_version, <new aggregates>...),
    updated_at        = now()
  WHERE id = $cluster_id;

  UPDATE news_items SET processed_at = now(), cluster_id = $cluster_id
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

**Cluster detail (story page / "what's in this cluster"):** one FK join through the junction:

```sql
SELECT e.id, e.title, e.summary, e.url, e.published_at,
       source.canonical_url AS source_url,
       sce.is_syndicated, sce.attach_method, sce.similarity, sce.attached_at
FROM story_cluster_entries sce
JOIN news_items e ON e.id = sce.entry_id
JOIN news_sources source ON source.id = e.news_source_id
WHERE sce.cluster_id = $1
ORDER BY sce.attached_at;
```

Powers both the public story page (sources list) and the internal QA view (same rows plus decision evidence).

- **API:** JSON endpoints for pages; SSE for one-way live updates (per `architecture.md`). The SSE server holds one direct Postgres connection (Supabase transaction-mode pooler drops `LISTEN` — use session mode or a direct connection), listens on `rank_changed`, pushes cluster diffs. Fallback: 5 s in-memory top-N snapshot diff.
- **OpenGraph:** a low-priority worker loop fetches OG tags (og:title/image/description) only for clusters entering the top ~200 without `og` populated. Bounded per-URL metadata fetch with the same SSRF protections as discovery; never full-corpus crawling. Frontend renders cards from `og` jsonb with zero client-side fetching.
- **Click-through model:** every story card links out to the original .gov article — we aggregate and rank, never host content. A cluster's **representative entry** owns the card's click target and OG fetch: earliest non-syndicated entry from the highest-`source_weight` feed, ties broken by earliest `published_at` (deterministic; favors the originating agency over echoes). Stored as `story_clusters.representative_entry_id`, maintained by the attach RPC. Click targets always use the entry's as-published `url` — `url_canonical` is internal dedupe machinery, never a navigation target (agency redirects/analytics must behave normally). The expanded story page lists every member entry as its own outbound link, with syndicated copies collapsed (e.g. "+2 republications").

## Search

Two indexes, both rebuildable, both queryable from day one:

1. **Keyword (instant, always on):** Postgres `tsvector` GIN over entry titles/summaries. Served straight from Supabase; zero cold start.
2. **Semantic (Chroma):** frontend → Worker `/search` route → Worker embeds the query via `env.AI.run('@cf/baai/bge-large-en-v1.5', ...)` **with the BGE query instruction prefix** (`"Represent this sentence for searching relevant passages: "` — queries only, never documents) → ranking DO → container Chroma query → results.

Cold-start honesty: if the container is asleep, first semantic search pays boot + snapshot load (~2–5 s); warm after (`sleepAfter` resets per request; ingest pings keep it warm during business hours). Frontend UX: show keyword results immediately, stream semantic results in when ready. If cold semantic search ever becomes unacceptable, swap the search index to Supabase pgvector (embeddings already durable in Postgres); Chroma stays for worker-internal near-dup/centroid work. Escape hatch, not MVP work.

## Nightly consolidation pass

Online greedy clustering is order-dependent and deliberately split-biased; the nightly job pays that debt down with full-day context and no latency pressure. Runs as a distinct job type on the same container (DO wake with `job: consolidation`, cron ~08:30 UTC — quiet ingest window), so day-time facets/cards stay stable and churn is confined to the overnight window. Execution order matters: cohesion refresh feeds the split detector, and split detection runs after merge so it audits tonight's merges too. Merged losers are never deleted — `merged_into` points at the winner, the row is excluded from serving, and its permalink 301s (permalink stability). Each merge/split is one row-locked transaction (idempotent: aggregate recompute is a pure function of junction membership), so streaming attaches simply serialize behind it — ingestion never pauses.

1. **Cohesion refresh:** mean member-to-centroid similarity per active multi-entry cluster; store as `story_clusters.cohesion real`. Cheap (embeddings already in memory); feeds passes 2–3 and the QA dashboard.
2. **Merge (heal false splits):** pairwise centroid similarity over **unsealed** clusters only (~couple hundred; sealing applies to nightly growth exactly as to streaming — the merged cluster inherits the older `first_entry_at`, preserving the birth-anchored bound). Pairs ≥ merge threshold resolve through the same candidate table as online assignment (entity overlap → merge; conflict/inconclusive → adjudicator, split-biased) — by nightly time both clusters carry fuller `entity_set` unions, so these decisions are better-informed than the original streaming ones. Winner = older cluster (stable id); aggregates + `entity_set` + representative entry recomputed once from junction rows (the only full recompute anywhere, scoped to merged clusters); `rank_key` recomputed (merged story may legitimately jump — corroboration was split across the halves); rejudge queued if the merge crossed a doubling threshold. Moved entries get `attach_method = 'consolidation_merge'`; loser gets `merged_into` and leaves serving.
3. **Split detection (over-merge repair):** runs after merge so it audits tonight's merges too. Suspects = `entry_count ≥ 4` AND `cohesion < SPLIT_COHESION_FLOOR` AND bimodal member-to-centroid distribution → internal 2-means, entity guard + adjudicator between the halves, keep the split only if confirmed (else flag for QA sampler). Moved entries get `attach_method = 'consolidation_split'`; both halves rejudged. Expected near-zero volume — firing rate is itself a threshold-drift metric.
4. **Label:** `cluster_topic` for unlabeled or membership-changed clusters ≥ 2 entries — c-TF-IDF over member titles, or one cheap judge-model call. Emergent topics surface here; label churn confined to the overnight window.
5. **Retry:** failed judge calls (AI Gateway cache makes accidental duplicates free).
6. **Index hygiene:** prune the **hot** Chroma collection to `ACTIVE_WINDOW` (near-dup/centroid ops never look further back); the **search** collection is append-only and keeps full history — semantic search must cover the archive. Verify a fresh post-prune R2 snapshot (small hot set = fast boots), emit the nightly QA digest (merges, splits, adjudicator outcomes, cohesion distribution, borderline sample).

## Temporal scoping and unbounded growth

The cluster table grows forever by design (archive + audit trail). Compute never does:

- **Clusters are sealed after `CLUSTER_GROWTH_WINDOW` from birth.** Membership eligibility is anchored to `first_entry_at`, never `newest_entry_at`, so it cannot roll forward on new attaches — a cluster's growth lifetime is hard-bounded. A very similar event on day 3 structurally gets its own card; the entity guard and adjudicator are same-window defenses, sealing is the cross-day defense. Dedupe's job is the echo burst (hours to ~2 days), not multi-day event aliasing.
- **Every comparison is window-scoped.** Streaming (exact-dup lookups, near-dup queries, centroid matrix) operates on unsealed clusters; nightly (cohesion, merge pairs, split suspects, labeling) on unsealed/active clusters. Cost is proportional to a few days of news volume, never to table age.
- **Days- or months-apart similar events cannot merge — structurally.** A July "FDA recalls Metoprolol" entry is compared only against currently-unsealed centroids; the January cluster is not in the candidate set at any cosine value. Sealed-scope exact-dup lookups also prevent a republished old article from refreshing an old cluster's `newest_entry_at` and yanking it back into the feed. Annual/recurring notices correctly become a new cluster per cycle.
- **Serving never touches cold rows.** `(rank_key DESC)` index + 7-day filter; time term dominance keeps index order roughly recent-first. Sealing stops growth only — sealed clusters rank, serve, and decay normally.
- **Slow-burn stories** (developments days or months apart) become one cluster per flare-up — correct for an event feed, and post-seal developments get their own fresh ranking clock (this also structurally bounds drip-feed dominance: no story rides the top indefinitely on trickle updates). Cross-time "story threads" linking related clusters is an explicit future feature (embeddings + `entity_set` history make it buildable later without reprocessing); not MVP.
- **Growth levers when Supabase 500 MB pressures** (embeddings dominate at ~2 KB/entry): partial serving index (`WHERE merged_into IS NULL`), then embedding archival — evict `embedding` bytea for entries past a retention horizon to R2 parquet (row, text, FTS, and Chroma `search` copy remain). Decision deferred until real growth data exists (open item).

## Clustering QA and auditability

Every attach decision is recorded (junction audit columns above), so QA is queryable rather than instrumented after the fact.

**Automated signals (dashboards/alerts from plain SQL):**

- Attach-method mix over time: `exact_url` / `content_hash` / `near_dup` / `centroid_join` / `new_cluster` ratios. Sudden shifts = threshold drift, feed anomalies, or an embedding-model change.
- Similarity distributions per method: histogram of `similarity` for joins and near-dups. Healthy setup shows clear separation from the thresholds; mass piling up just above a threshold means it is doing real work and deserves human review of borderline cases.
- `cohesion` distribution and worst-N clusters by cohesion: low-cohesion multi-entry clusters are merge mistakes to eyeball.
- Singleton rate (clusters with 1 entry after 72 h): too high → join threshold too strict; too low → over-merging.
- Nightly merge count: persistent high merge volume means the online join threshold is too strict (consolidation is compensating).

**Human review loop (MVP-cheap):**

- Internal QA endpoint on the container (service-auth only): paginated clusters with the cluster-detail join above plus decision evidence — title list, per-member `attach_method`/`similarity`, cohesion, rubric bits, `interest_reason`. This is the "visualize the clustering" surface; a plain HTML table is enough at MVP.
- Borderline sampler: `SELECT` junction rows where `similarity` is within ε of `threshold_used`, sample ~20/day for human yes/no labels into a `cluster_qa_labels` table (`entry_id, cluster_id, verdict, labeled_by, labeled_at`). These labels are exactly what threshold recalibration and any future learned ranker need.
- Retro-evaluation: because every row stores `threshold_used` and `embedding_model`, a proposed new threshold can be evaluated against historical decisions ("would we have split/merged differently?") without reprocessing anything.

Deferred (not MVP): 2-D embedding projection (UMAP) scatter of the active window colored by cluster — nice for eyeballing structure, not needed to ship.

## Configuration (not constants)

| Key                      | Initial                                    | Notes                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBEDDING_MODEL`        | `@cf/baai/bge-large-en-v1.5`               | 1024 dims; `bge-base` (768) is the DB-size pressure valve                                                                                                                                                                                                                                                                                                  |
| `JUDGE_MODEL`            | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | via AI Gateway                                                                                                                                                                                                                                                                                                                                             |
| `ADJUDICATOR_MODEL`      | same as `JUDGE_MODEL`                      | same-event arbitration; separate key so it can diverge                                                                                                                                                                                                                                                                                                     |
| `NEAR_DUP_THRESHOLD`     | calibrate on real corpus                   | BGE-space, not OpenAI-space                                                                                                                                                                                                                                                                                                                                |
| `CLUSTER_JOIN_THRESHOLD` | calibrate on real corpus                   | ditto                                                                                                                                                                                                                                                                                                                                                      |
| `MERGE_THRESHOLD`        | calibrate on real corpus                   | nightly cluster-pair candidate gate                                                                                                                                                                                                                                                                                                                        |
| `SPLIT_COHESION_FLOOR`   | calibrate on real corpus                   | nightly over-merge suspect gate                                                                                                                                                                                                                                                                                                                            |
| `HALF_LIFE`              | 24 h                                       | τ = half_life/ln(2)                                                                                                                                                                                                                                                                                                                                        |
| `CLUSTER_GROWTH_WINDOW`  | 48 h                                       | membership horizon from `first_entry_at` (birth-anchored); cluster sealed after. **Decision:** post-seal late corroboration creating a duplicate card is accepted — time decay separates the two cards by ~2+ log units, so they never render adjacently; the late card reads as a follow-up. Same-week event separation wins over weekend-echo absorption |
| `ACTIVE_WINDOW`          | 72 h                                       | hot Chroma collection + consolidation scan scope                                                                                                                                                                                                                                                                                                           |
| `SERVING_WINDOW`         | 7 days                                     | query filter                                                                                                                                                                                                                                                                                                                                               |
| `PRIOR_POINTS`           | ½ Σ rubric weights                         | unjudged default                                                                                                                                                                                                                                                                                                                                           |
| Rubric weights           | table-driven                               | retune without LLM calls                                                                                                                                                                                                                                                                                                                                   |

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
7. Ingest-side dependency: `news_items` must carry indexed `url_canonical` and `content_hash` columns, computed in the TS normalization stage (URL canonicalization rules must respect the architecture doc's feed-canonicalization caution — preserve path/query semantics).
8. Embedding retention policy: when Supabase DB size warrants, evict old `embedding` bytea to R2 parquet (rows/text/FTS/Chroma-search remain). Decide from real growth data, not upfront.
