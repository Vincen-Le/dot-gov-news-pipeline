# Storyline Clustering and Event Cards — v2 Design

**Date:** 2026-07-18
**Status:** Active design, iterating ("polish the aggregation logic" cycles ongoing)
**Supersedes:** the clustering, schema, ranking-target, and serving sections of `2026-07-17-ranking-pipeline-design.md`. That spec's dedupe layers, entity extraction algorithm, rank_key math, judge rubric, audit-trail model, runtime topology (DO + Container + Workers AI), search, and QA loops remain in force except where amended here.

## Objective change

v1 treated a cluster as a burst-dedupe absorber (sealed at 48 h). v2 redefines it: **clustering must reconstruct chains of sequentially related events across arbitrary time spans (up to a year+)**, so an LLM can compress each chain into event cards. Dedupe remains a first-stage concern; chain reconstruction is the product.

Product target: X-style story reconstruction — updates arriving in 4–6 h pulses over a week (or across months) reliably form one navigable chain with a compressed overview.

## Data model: four levels

```text
feed_entries ──burst clustering──▶ EPISODES ──thread attach──▶ STORYLINES ──LLM compress──▶ EVENT_CARDS
             (pipeline unchanged)  (4 h dormancy,             (unbounded chains,           (overview card +
                                    pulse-scale)               entity-anchored)             1:1 episode cards)
```

- **Episode** = one development pulse. Tight cluster formed by the existing v1 pipeline (exact dedupe → near-dup → centroid nominate → entity gate → adjudicator). Closes after `EPISODE_DORMANCY` (4 h, rolling) of quiet.
- **Storyline** = unbounded chain of episodes about one historical event. No time bound of any kind.
- **Event cards** = the serving surface, write-once rows:
  - **Overview card**: LLM compression of the chain-so-far. Regenerated (new row, old superseded) on every state transition.
  - **Episode cards**: immutable 1:1 representation of each detected episode. Rendered as the chain timeline inside the story page; individually searchable.
  - **n+1 structure**: storyline with n episodes serves 1 overview + n episode cards.

## Pipeline stages

### Stage 0 — Enrichment (new)

Small LLM (8B-class, Workers AI) refines raw `title + summary` into a semantically searchable event description before embedding.

- Validated technique (document-expansion family: Query2doc / HyDE / LLM-augmented retrieval — consistent retrieval gains over raw text; the embedding bottleneck filters hallucinated specifics while preserving semantic pattern).
- **Determinism containment:** temperature 0; output stored as `feed_entries.enriched_text` with `enricher_version`; embeddings always computed from the stored text — re-enrichment only via explicit version bump. Cache keyed on `content_hash`.
- **Poisoning containment (hard rule):** entity extraction runs on RAW title/summary ONLY, never enriched text. Enrichment improves the semantic signal; the identity anchor stays grounded in what the agency published. Enrichment prompt: restate and contextualize, add no facts.

### Stage 1 — Episode formation (v1 pipeline, re-scoped)

Unchanged mechanics, new windows:

- Exact dedupe (`url_canonical`, `content_hash`) and near-dup (Chroma hot) scopes stay at **72 h — deliberately decoupled from episode dormancy.** Syndication echo outlives 4 h; late verbatim copies must fold into the original episode as syndicated sources rather than spawning fake episodes. Only genuinely new content opens episodes.
- Centroid candidates = **open episodes** (not dormancy-expired). Entity gate + split-biased adjudicator unchanged.
- Episode closes at 4 h rolling quiet → status `dormant`; its 1:1 episode card is generated at close (content final at that point).

### Stage 2 — Storyline attachment (new)

When a new episode forms, attach it to a storyline:

1. **Candidate generation by entity, not time window:** GIN index on `storylines.entity_set` — candidates share salient discriminators (drug names, companies, dockets). O(index) over years of corpus; no scan scales with age. Embedding similarity against the Chroma `search` collection is the secondary signal (enriched-text embeddings).
2. **Adjudication against the storyline's latest overview card** (temporal-guided summary-clustering pattern): prompt carries the overview summary, the new episode's titles, storyline `last_active` date and gap length → `{same_event, reason}`. Judged against the evolving narrative, not a stale centroid. Split-biased; error → new storyline.
3. No candidate / adjudicator says no → new storyline born from the episode.

Granularity lock = entity continuity (deterministic, from raw text) + narrative adjudication (LLM, against the chain's own summary). Same-week template twins: disjoint entities → never candidates. Month-apart developments of one event: shared entities + summary confirms → same chain.

**Annual repeats (deferred, sketch recorded):** year tokens (`2026`, `FY27`) already fall out of regex extraction → annual cycles usually differ in entity sets naturally; adjudicator sees `last_active` gap (9-month dormancy = strong new-chain prior). Full policy is a follow-up iteration, not MVP-blocking.

### Stage 3 — Card generation

Triggers (decided): **every episode attach + episode-count doublings** (1, 2, 4, 8 …). Each trigger:

1. LLM compresses chain-so-far → overview card content (headline, summary, timeline bullets) **and rubric bits + reason in the same call** (it is already reading the chain).
2. New `event_cards` row written with `rank_key` computed at birth; previous overview marked `superseded_by`.
3. **Single-episode collapse:** while a storyline has one episode, the episode card doubles as the overview — the separate overview card is generated lazily when episode #2 attaches. Saves the majority of compression calls (most storylines never get a second episode).

Episode cards: generated once at episode close, never superseded.

## Ranking (rank_key on overview cards)

```text
card.rank_key = Σ bit_c · w_c                                  # rubric bits from the compression call
              + w_a · ln(1 + storyline.distinct_agencies)
              + w_f · ln(1 + storyline.distinct_feeds)
              + ln(storyline.source_weight_max)
              + epoch_seconds(storyline.newest_entry_at) / τ    # last-update freshness
```

- Freshness = storyline's most recent activity: a year-old chain with a development today ranks like today's news while carrying a year of accumulated corroboration. Long-chain resurfacing is the product now, not a bug.
- **Cards are write-once → rank_key is computed exactly once and never updated.** Rank refresh happens by supersession: new episode → new overview card born with a fresher time term → naturally ranks above → old card leaves the feed via `superseded_by`. The ranking "updates" without a single UPDATE to any rank value.
- All v1 rank_key properties carry over: log-space additivity, 34.6 h-per-unit exchange rate, capped judge influence, one key serves global + every facet, expiry as query filter.

Feed query:

```sql
SELECT ... FROM event_cards
WHERE superseded_by IS NULL
  AND newest_entry_at > now() - interval '7 days'
ORDER BY rank_key DESC LIMIT 50;
```

## Schema (delta from v1)

```sql
storylines (
  id uuid PK,
  entity_set        text[] NOT NULL DEFAULT '{}',   -- GIN; identity anchor + candidate index
  centroid          bytea,                          -- fp16, secondary signal
  topic             text, cluster_topic text,
  agency_ids        text[] NOT NULL DEFAULT '{}',
  distinct_feeds    int NOT NULL DEFAULT 0,
  entry_count       int NOT NULL DEFAULT 0,
  episode_count     int NOT NULL DEFAULT 0,
  source_weight_max real NOT NULL DEFAULT 1.0,
  first_entry_at    timestamptz NOT NULL,
  newest_entry_at   timestamptz NOT NULL,           -- ranking freshness anchor
  latest_card_id    uuid,                           -- current overview
  merged_into       uuid REFERENCES storylines(id), -- consolidation, permalink 301
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON storylines USING gin (entity_set);

episodes (
  id uuid PK,
  storyline_id      uuid NOT NULL REFERENCES storylines(id),
  status            text NOT NULL DEFAULT 'open',   -- open | dormant
  centroid          bytea,
  entity_set        text[] NOT NULL DEFAULT '{}',
  entry_count       int NOT NULL DEFAULT 0,
  first_entry_at    timestamptz NOT NULL,
  newest_entry_at   timestamptz NOT NULL,
  -- storyline-attach evidence (same audit discipline as entry attaches):
  attach_method     text,        -- entity_candidate | adjudicated_join | new_storyline
  attach_similarity real,
  attach_reason     text,
  adjudicator_model text
);

episode_entries (  -- v1 story_cluster_entries, renamed; audit columns unchanged
  episode_id uuid FK, entry_id uuid FK, is_syndicated boolean,
  attach_method text, similarity real, matched_entry_id uuid,
  threshold_used real, embedding_model text, attached_at timestamptz,
  PRIMARY KEY (episode_id, entry_id)
);

event_cards (
  id uuid PK,
  storyline_id      uuid NOT NULL REFERENCES storylines(id),
  episode_id        uuid REFERENCES episodes(id),   -- NULL = overview card
  kind              text NOT NULL,                  -- overview | episode
  version           int  NOT NULL,
  headline          text NOT NULL,
  summary           text NOT NULL,
  timeline          jsonb,                          -- chain bullets (overview only)
  rubric            jsonb, rubric_version int, interest_reason text,
  og                jsonb,
  representative_entry_id uuid REFERENCES feed_entries(id),
  newest_entry_at   timestamptz NOT NULL,           -- storyline value at generation
  rank_key          float8 NOT NULL,                -- write-once
  superseded_by     uuid REFERENCES event_cards(id),
  judge_model       text, prompt_version int,
  generated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON event_cards (rank_key DESC) WHERE superseded_by IS NULL;
CREATE INDEX ON event_cards (storyline_id, version);

-- feed_entries additions beyond v1:
--   enriched_text text, enricher_version int
```

## Windows (v2)

| Key                  | Default | Governs                                                        |
| -------------------- | ------- | -------------------------------------------------------------- |
| `EPISODE_DORMANCY`   | 4 h     | rolling quiet gap that closes an episode                        |
| `DEDUPE_WINDOW`      | 72 h    | exact + near-dup scope — decoupled from dormancy (syndication tails) |
| `ACTIVE_WINDOW`      | 72 h    | hot Chroma collection; nightly episode-level scan scope          |
| `SERVING_WINDOW`     | 7 d     | feed filter on cards                                            |
| Storyline lifetime   | ∞       | unbounded by design; candidates via entity index, never scans    |

`CLUSTER_GROWTH_WINDOW` / sealing: removed. Sealing solved v1's objective (burst dedupe); v2's chain objective replaces it with episode dormancy + entity-anchored threading.

## Nightly consolidation (v2 scope)

Same six-pass structure, re-targeted:

1. Cohesion refresh over open/recent episodes.
2. Episode merge (false-split repair within `ACTIVE_WINDOW`), same decision table.
3. Episode split detection (bimodal cohesion), as v1.
4. **Storyline merge/split:** entity-overlap candidates among storylines touched this week → adjudicated with both overview summaries in the prompt; `merged_into` for losers; overview cards regenerated for changed storylines.
5. Judge/compression retries; labeling (`cluster_topic`) for changed storylines.
6. Index hygiene (hot prune @ 72 h, search append-only) + QA digest (now including storyline-attach decisions and card-generation counts).

## Cost posture (delta)

- Enrichment: +1 small-model call per entry (~few thousand/day, cached by content_hash) — the largest new cost, still Workers-AI-cheap.
- Storyline adjudication: only on entity-candidate matches — small multiples of episode count.
- Compression+judge: one call per state transition; single-episode collapse eliminates the majority.

## Open items for iteration cycles

1. Enrichment prompt design + eval: does enriched-text embedding measurably improve episode/storyline candidate quality on a real corpus sample vs raw-text embedding? (A/B on stored decisions.)
2. Annual-repeat policy (year tokens + dormancy prior) — quick follow-up, not priority.
3. Overview compression prompt: timeline fidelity vs length; how many episodes fit context before hierarchical compression needed (compress episode cards, not raw entries — cards are already summaries).
4. Storyline-attach threshold for embedding secondary signal; calibrate with entity-candidate precision.
5. Card OG strategy: overview cards need generated OG images or representative-entry OG? (v1 representative-entry OG carries over as default.)
6. v1 spec sections to formally mark superseded once v2 stabilizes.
