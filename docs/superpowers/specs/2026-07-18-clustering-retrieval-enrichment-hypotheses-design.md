# Clustering Improvement Hypotheses: Enrichment Text + Hybrid Retrieval + Multi-Candidate Adjudication

**Date:** 2026-07-18
**Status:** Draft — pending review
**Builds on:** `2026-07-18-topic-clustering-design.md`, `2026-07-18-theme-adjudicator-design.md`,
`docs/operations/topic-clustering-research-validation-2026-07-18.md`

## Problem

Two suspected weaknesses in Stage 1/2 attachment quality:

1. **Embedding text is not optimized for semantic space.** The enricher
   (`ENRICHER_SYSTEM`, `pipeline/prompts.py`) produces a dense event
   description but says nothing about acronyms or identifying terminology.
   Government news is acronym-dense (OFAC, CISA, NOAA, USCIS); an entry that
   says "OFAC sanctions" and an overview that says "Office of Foreign Assets
   Control" can land far apart in embedding space for the same subject.
2. **Storyline candidate retrieval is entity-only.** `StorylineEngine.resolve`
   retrieves candidates exclusively via entity GIN overlap
   (`storylines_by_entities`), ranked by rare-entity score, top-3, then
   adjudicates pairwise-sequentially. When extraction misses or names vary
   ("DOJ" vs "Justice Department" vs "U.S. Attorney's Office"), the right
   storyline never enters the candidate pool — recall bounded by the
   extractor, and the LLM never gets a chance to correct it.

Non-problem, recorded to prevent re-litigating: the internal/external text
split **already exists**. `enriched_text` is embedded and never shown;
display surfaces use raw title/summary; extraction deliberately runs on raw
text only (`pipeline/extraction.py` line 4). Only the enricher prompt needs
work, not the architecture.

## Hypotheses

### H1 — Acronym-aware enrichment improves same-subject cosine

**Change:** extend `ENRICHER_SYSTEM` to (a) expand acronyms while keeping
both forms — "Office of Foreign Assets Control (OFAC)" — so either surface
form anchors retrieval; (b) preserve identifying terminology verbatim (case
numbers, docket numbers, rule numbers, vessel names, place names); (c) expand
only acronyms grounded in the input — government acronyms collide across
agencies, and a hallucinated expansion poisons the vector worse than none.

**Display text unaffected** — raw title/summary stays the user-facing text;
acronyms remain as published.

**Mechanics:** bump `enricher_version` (config default 1 → 2). `enriched_text`
is the cache, so the corpus needs re-enrich + re-embed. All cosine
distributions shift → every similarity threshold must be recalibrated after
this lands (they are uncalibrated placeholders anyway per the research-
validation doc, follow-up #1 — this is a reason to do H1 *first*, not extra
cost).

**Validates if:** on a hand-labeled pair set (~200 same-storyline /
different-storyline entry–overview pairs), the separation between the two
similarity distributions widens vs enricher v1 (larger gap between
distribution crossover and means; fewer same-subject pairs below the
storyline sim floor).

### H2 — Hybrid candidate retrieval beats entity-only retrieval

**Change:** storyline candidate pool becomes the union of three sources,
deduped, capped at ~10:

1. **Event keys** (existing tier 1, unchanged — deterministic, wins outright).
2. **Entity GIN overlap** (existing, EMA-ranked) — keeps recall when
   embeddings drift but hard identifiers match.
3. **New: embedding similarity against storyline `overview_embedding`** —
   top-K cosine of the entry vector against overview embeddings. Infra
   half-exists: `CardEngine._regenerate_overview` already embeds every
   overview summary and stores `overview_embedding` on refresh
   (`pipeline/cards.py`). Missing: a read that returns top-K storylines by
   overview-embedding cosine, and a centroid fallback for storylines with no
   overview yet (new storyline before first compressor run — centroid lives
   in the same embedding space).

Entity and embedding retrieval fail in complementary ways: embeddings miss
when a new development reads semantically unlike the chain summary
("indictment" vs "sentencing") but shares identifiers; entities miss when
extraction fails or naming varies. Union covers both.

**Scale note:** cosine over all storylines is a brute-force Python scan today.
Acceptable at current corpus size; plan pgvector (or equivalent ANN index) on
`overview_embedding` before the corpus reaches months of data. Not in this
iteration.

**Validates if:** attach-method mix shifts — fewer `new_storyline` spawns
that a human would have joined (measured on the gold pair set / B-Cubed
sample), without a rise in wrong joins. Track candidate-pool hit rate: of
adjudicated joins, how many candidates came from embedding-only vs
entity-only vs both.

### H3 — One multi-candidate adjudication call, with episode context

**Change:** replace the pairwise-sequential adjudication loop in
`StorylineEngine.resolve` with a single fast-LLM call over the full candidate
pool — the contract the theme adjudicator already ships (join/spawn +
verbatim-ID guard). Per candidate storyline, the prompt carries: overview
headline + summary, days since last activity, shared entities, and its
most recent episodes (up to 5 per candidate: episode card headline + date,
open episodes flagged). Output decides one of:

- `join_episode` — entry belongs to a specific listed open episode,
- `join_storyline` — same chain, new development → new episode of that
  storyline,
- `new_storyline`.

```json
{"decision": "join_episode" | "join_storyline" | "new_storyline",
 "episode_id": "<candidate episode id, only when join_episode>",
 "storyline_id": "<candidate storyline id, only when join_*>",
 "reason": "one sentence"}
```

**Scope decision (H3a chosen):** this replaces the *storyline resolver* only.
The episode-formation tiers in `EpisodeEngine.process_entry` stay untouched:
content-hash, near-dup, event-key, and centroid+rare-entity+adjudicator
(tier 4) still run first and resolve most volume with zero or one LLM call.
H3 fires only where `resolve_storyline` fires today — when a new episode is
about to spawn. `join_episode` gives the resolver a way to route into an open
episode of a storyline that tier 4 missed (tier 4 only sees open-episode
centroids; the resolver sees overview-level candidates). The alternative
(H3b: collapse tier 4 + resolver into one retrieval + one call) is cleaner on
paper but rewrites `episodes.py` semantics (dormancy, dedupe interplay,
`_open` cache) in the same change as two other hypotheses — too many moving
parts to attribute eval movement. Revisit H3b only if H3a validates and
tier-4/resolver disagreement shows up in audit columns.

**Guards (house precedents):**

- Split-biased prompt: false join costs more than false spawn; uncertain →
  `new_storyline`. Same bias as `ADJUDICATOR_SYSTEM`.
- Verbatim-ID guard: returned `storyline_id`/`episode_id` not among presented
  candidates → treat as `new_storyline` (mirrors
  `test_invalid_theme_id_from_llm_treated_as_spawn`).
- `join_episode` targeting a closed episode → downgrade to `join_storyline`.
- LLM error/unparseable → fall back to the current deterministic path
  (rare-entity + threshold join, else new storyline). Attachment never blocks
  on the LLM.
- Audit columns: `attach_method` values `adjudicated_join_episode` /
  `adjudicated_join` / `new_storyline`, plus reason and model, following the
  existing storyline audit-column style.

**Cost:** one adjudicator call per would-be-new-episode entry (replacing up
to 3 sequential pairwise calls). Same `adjudicator_model`
(`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). Net call count drops.

**Validates if:** B-Cubed / pairwise F1 on the gold sample improves over the
sequential-pairwise baseline at equal-or-lower LLM call volume; wrong-join
rate does not rise (split-bias check).

## Sequencing

Order matters — H1 invalidates thresholds, and H2/H3 eval needs calibrated
floors as baseline:

1. **H1** — enricher prompt v2, re-enrich + re-embed corpus.
2. **Calibrate** — hand-label ~200 pairs, plot same/different similarity
   distributions, set `storyline_sim_floor`, `near_dup_threshold`,
   `cluster_join_threshold`, `theme_sim_floor`/`theme_stick_floor` near
   crossovers (executes research-validation follow-up #1). This pair set is
   also the eval baseline for H2/H3.
3. **H2 + H3** — land together as one change to `StorylineEngine.resolve`
   (H3's prompt is shaped by H2's candidate pool; separate landings would
   build a throwaway pairwise-over-hybrid-pool intermediate). Evaluate via
   experiment replay (prepare/cluster split makes reruns cheap) against the
   step-2 baseline.

## Eval plan

- Gold pair set (~200 labeled pairs) from step 2; B-Cubed / pairwise F1 per
  the research-validation doc's follow-up #6.
- Attach-method mix per replay run (existing experiment tooling): watch
  `new_storyline` rate down, `adjudicated_join*` up, wrong joins flat.
- Candidate-source attribution: log which retrieval source produced the
  winning candidate (entity / embedding / both) — directly tests H2.
- Megacluster guards stay in scope for themes only (research follow-up #3);
  storyline-level megaclusters get the same largest-share metric added to the
  replay report as a tripwire.

## Known risks

- **Enricher expansion errors** (H1): wrong acronym expansion is silent vector
  poison. Mitigation: grounded-only instruction + spot-check a sample of v2
  enrichments against v1 before corpus-wide re-embed.
- **Overview staleness** (H2): overview embeddings refresh only on episode
  close; a hot storyline's overview lags its newest episodes. Mitigation:
  centroid fallback + episode context in the H3 prompt (recent episode
  headlines are newer than the overview).
- **Single-call anchoring** (H3): one call over 10 candidates can anchor on
  the first plausible candidate where pairwise-sequential would have rejected
  it. Split-bias phrasing + eval wrong-join tracking is the check; if wrong
  joins rise, drop to pairwise over the hybrid pool (keeps H2, reverts H3).
- **Threshold churn**: every embedding-text change (H1 now, any future
  enricher/model bump) invalidates calibration. Record enricher version +
  embedding tag alongside every calibration artifact (columns already exist:
  `enricher_version`, `embedding_model` tag).

## Out of scope

- pgvector / ANN index (noted in H2, deferred until corpus size forces it).
- H3b full tier-4 + resolver collapse (revisit after H3a eval).
- Theme-stage changes — Stage 4 just shipped its own adjudicator; let it
  soak.
- Temporal decay of centroids (research follow-up #2) — orthogonal, separate
  iteration.
