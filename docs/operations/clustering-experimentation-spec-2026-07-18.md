# Clustering Experimentation Spec

2026-07-18. Research spec: ranked experiment catalog for the clustering
pipeline (entries → episodes → storylines → themes), derived from two
deep-research passes over the news-clustering literature and production
systems (Feedly, NewsCatcher, Event Registry, Miranda/Priberam lineage,
USTORY, Hanley & Durumeric Matryoshka), mapped onto the current code.

Companions:

- `docs/operations/topic-clustering-research-validation-2026-07-18.md` —
  theme-stage verdicts and its 7 ranked follow-ups. This spec covers the whole
  pipeline and does not repeat those; intersections are cross-referenced.
- `docs/operations/clustering-lab.md` — how every experiment here is run.
- `docs/operations/lazy-theme-promotion-2026-07-19.md` — theme-stage redesign
  (2026-07-19): category-first stream, promotion-sweep theme birth. Theme-knob
  experiments below apply to the new knob set.

## Headline verdicts from the research

Two findings from the literature the current design **already implements** —
these need no experiment, only measurement:

1. **Dedup-before-cluster** (Feedly: LSH first, 80% of articles are dupes,
   dupes inherit cluster id) = tiers 1–2 in `pipeline/complex/episodes.py`. Worth one
   query: what share of attaches are `content_hash`/`near_dup` on the real
   corpus? That share is the latency/cost lever.
2. **Dense embeddings alone under-cluster at event granularity; entity
   features fix it** (Saravanakumar 2021: entity-aware BERT alone 68.98 B³-F1,
   TF-IDF 86.36, hybrid + time 94.76) = the rare-entity gate + ambient EMA
   ceiling. The mechanism is validated; experiments below tune it, not
   replace it.

The reference numbers cited per experiment come from: Miranda et al. 2018
(EMNLP, D18-1483), Saravanakumar et al. 2021 (EACL, arXiv:2101.11059), USTORY
(SIGIR 2023, arXiv:2304.04099), Hanley & Durumeric (ACL 2025,
arXiv:2506.00277), Event Registry (WWW 2014), Feedly engineering blog (2024),
NewsCatcher v3 docs.

## Current knobs (baseline)

| Knob                                    | Value                                      | Status                          |
| --------------------------------------- | ------------------------------------------ | ------------------------------- |
| `embedding_model`                       | `@cf/baai/bge-m3` (Workers AI, dense only) | fixed reference                 |
| `near_dup_threshold`                    | 0.90                                       | placeholder, uncalibrated       |
| `cluster_join_threshold`                | 0.78                                       | placeholder, uncalibrated       |
| `theme_sim_floor` / `theme_stick_floor` | 0.55 / 0.50                                | placeholder (see companion doc) |
| `ambient_ema_ceiling`                   | 3.0                                        | placeholder                     |
| `dedupe_window_hours`                   | 72                                         | assumed, unmeasured             |
| `episode_dormancy_hours`                | 4                                          | assumed, unmeasured             |

---

## Track 0 — eval prerequisite (do first)

### E0. Gold labels + B³ harness at episode and storyline level

Everything below needs a change-detection metric better than attach-mix
deltas. The field standard is B-Cubed F1 on labeled pairs; operational
metrics (singleton rate, attach mix) cannot say whether a change _helped_.

- **Do**: extend the lab label queue (`pnpm ops lab borderline`,
  `docs/eval/labels.csv`) beyond theme pairs: sample ~150–200 episode-attach
  decisions and ~150 storyline-attach decisions stratified by similarity band
  (0.50–0.95) and by method, hand-label same-event / same-chain. One-time
  cost; labels survive resets by design.
- **Success criterion**: `pipeline.cli eval --labels` (or equivalent) reports
  pairwise/B³ F1 per stage on every experiment run report.
- **Evidence**: B³-F1 on labeled corpora is the de facto standard (Miranda
  2018 dataset, WCEP18/19); Event Registry trained its cluster-merge SVM to
  87% accuracy on just 85 labeled pairs — small label sets carry far.
- **Cost**: an afternoon of labeling + a small eval extension. Blocks nothing
  but de-risks everything.

---

## Track A — threshold calibration (cheap, no code changes)

### A1. Calibrate floors from logged adjudicator verdicts

The adjudicator is already a learned join/spawn decision (the literature's
biggest single win: Miranda 82.8 → 94.1 F1 replacing a grid-searched
threshold with a classifier). For episode-to-storyline assignment, event keys
and entity overlap now only generate candidates and every join requires the
judge; storyline similarity is diagnostic rather than a routing floor. Stage
1 episode formation still uses static thresholds, and every attach row logs
`method`, `similarity`, and `threshold`.

- **Hypothesis**: adjudicator verdicts bucketed by similarity band reveal how
  well stage 1 thresholds nominate same-event episodes and whether the
  storyline candidate ranking should change, without reintroducing a
  deterministic storyline auto-join.
- **Do**: one SQL pass over historical attaches + cached decisions
  (`.cache/decisions.sqlite`): P(same | sim band) for episode tier 4 and the
  judge-only storyline candidate pool. Tune the episode floor and evaluate
  storyline ranking separately; confirm with a lab run and E0 metrics.
- **Run**: `pnpm ops lab run --name floors-v2 --set CLUSTER_JOIN_THRESHOLD=…`
- **Success**: unchanged or better B³ with fewer adjudicator calls (cache
  misses shown per run).
- **Note**: re-do whenever `EMBEDDING_MODEL` changes; the floors are
  embedding-space-specific. Companion doc follow-up 1 is the theme-stage
  version of this.

### A2. Near-dup threshold sweep

- **Hypothesis**: 0.90 is mis-set for bge-m3 on gov press releases (heavy
  templated boilerplate inflates cosine between _different_ events from the
  same agency; the fp16 quantization also compresses the top of the range).
- **Do**: sweep 0.87–0.94; inspect false-merge pairs at each step via the
  storyline QA view. Boilerplate-heavy agencies (State nav-blob class) are
  the failure mode to watch.
- **Run**: `pnpm ops lab run --name neardup-088 --set NEAR_DUP_THRESHOLD=0.88` (etc.)
- **Success**: maximize dup recall at zero observed false merges in a
  labeled/spot-checked sample; report the syndication share while at it
  (headline verdict 1).

### A3. Ambient EMA ceiling sweep

- **Hypothesis**: 3.0 mislabels mid-frequency entities. Too low → real
  discriminators treated as ambient (missed joins); too high → agency
  boilerplate terms treated as rare (false joins past the gate).
- **Do**: distribution of `daily_ema` over the real corpus first (query, no
  run); pick 2–3 candidate ceilings at distribution features; sweep.
- **Run**: `pnpm ops lab run --name ema-45 --set AMBIENT_EMA_CEILING=4.5`
- **Success**: B³ at episode level; secondary: share of tier-4 joins passing
  the rare gate vs falling to the adjudicator.

---

## Track B — candidate generation (small code changes)

### B1. Entity-nominated tier-4 episode candidates

Asymmetry today: storylines nominate candidates by entity (GIN) and gate by
embedding; episodes nominate by centroid only. An entry sharing 2+ rare
entities with an open episode but cosine < 0.78 never reaches the episode
adjudicator — the same-event-different-vocabulary case (the one Ground News
markets, and the one entity features exist to catch).

- **Hypothesis**: entity-nominated candidates recover missed joins with
  bounded adjudicator cost.
- **Do**: in `EpisodeEngine.process_entry` tier 4, union centroid candidates
  with open episodes sharing ≥ 2 rare entities (EMA below ceiling); those
  below `cluster_join_threshold` go to the adjudicator instead of
  auto-joining. Split-bias preserved: adjudicator still arbitrates.
- **Run**: feature-flag it (`--set` env), A/B against baseline on same corpus.
- **Success**: episode B³ recall up, precision flat; adjudicator call count
  increase bounded (report shows cache misses); no megacluster regression
  (largest-episode share).
- **Evidence**: entity similarity as a _feature_ (not just a gate) worth ~3 F1
  (Saravanakumar); Event Registry weights entities above ordinary words in
  the clustering vector itself.

### B2. Gaussian recency term in storyline candidate ranking

`StorylineEngine._rank_candidates` scores by rarity-weighted entity overlap
only — no recency. Two chains sharing the same rare entities rank identically
whether last active 2 days or 2 years ago (recurring recall series, annual
rule cycles).

- **Hypothesis**: adding `exp(-Δt²/2σ²)` against `newest_entry_at` to the
  ranking key puts the right chain in the top-3 more often.
- **Do**: add the term to the sort key (ranking order only — never a hard
  gate; chains are unbounded-time by design and the adjudicator already sees
  `gap_days`). Sweep σ ∈ {72h, 7d, 30d} — gov storylines move slower than the
  consumer-news 72h the literature tuned; expect the best σ well above 72h.
- **Success**: storyline B³ up; `adjudicated_join` hit rate within top-3
  candidates up (fewer right-chain-not-in-shortlist misses).
- **Evidence**: twice-replicated. Miranda: time features EN 92.7→94.1, DE
  90.7→97.1 (σ=72h, tuned); Saravanakumar: 86.36→91.72 B³, corrected cluster
  count 530→222 (true). Time alone is useless (F1 61.1) — it is a
  disambiguator between plausible candidates, which is exactly what this
  ranking does.

---

## Track C — temporal windows (measure first, then maybe change)

### C1. Dedupe window: 72h vs 7d

Cross-system consensus event lifetime is ~1 week (Feedly clusters against the
past week; Event Registry expires clusters after k days; USTORY 7-day
window). Gov syndication (GovDelivery re-posts, cross-agency mirrors) can lag
past 72h.

- **Do (measurement, no run)**: count content-hash and ≥ near-dup-sim matches
  landing in the 72–168h band on the real corpus. If ≈ 0, close the question.
- **If nonzero**: `pnpm ops lab run --name dedup-168 --set DEDUPE_WINDOW_HOURS=168`;
  watch tier-2 scan cost (linear over `recent_embedded`) and false-merge rate.

### C2. Episode dormancy sweep (low priority)

4h is aggressive vs the literature's multi-day event lifetime — but episodes
here are event-time bursts by design; multi-day coverage chains through the
storyline, and the event-key tier catches reopens. Only worth a 4h/12h/24h
sweep if QA shows same-burst fragmentation (one press event split across
episodes). Metric: share of storylines whose consecutive episodes are < 24h
apart with near-identical entity sets.

### C3. Time-decayed theme centroids

Companion doc follow-up 2 — flagged there as the theme stage's largest
divergence from practice (flat all-time mean centroid = known megacluster
recipe: Aggarwal & Yu fading droplets, USTORY time-decayed keywords). Owned
by that doc; listed here only so the temporal track reads complete.

---

## Track D — embeddings (expensive: re-embed + tag bump each)

All D experiments require `--clear-features` runs and an embedding-tag bump;
run them after Track A so floor comparisons are clean. The offline Python
pipeline binds embeddings only through the client in `pipeline/shared/ai.py` — local
HF inference is an implementation detail plus the tag.

### D1. Hybrid sparse+dense scoring via local BGE-M3

The model already in use natively emits sparse lexical weights (and ColBERT
multi-vectors) when run via FlagEmbedding locally; the Workers AI endpoint
returns dense only. Sparse+dense is the Miranda-lineage hybrid recipe without
changing embedding space — existing dense centroids stay comparable.

- **Do**: local FlagEmbedding inference; score tier-4/storyline candidates
  with `α·dense + (1−α)·sparse` cosine; sweep α.
- **Success**: B³ up at episode level, specifically on
  boilerplate-heavy-agency pairs where dense cosine is inflated.
- **Risk**: sparse vectors need storage (new column or packed format);
  inference moves from API to local compute.

### D2. Entity-injected embedding text

- **Hypothesis**: appending `entity_set` + `event_keys` to the text before
  embedding sharpens event-level separation.
- **Do**: `--clear-features` run with the enrichment step composing the
  embed-text variant; compare attach decisions against baseline run.
- **Evidence**: unproven for this domain — strictly a lab question. Cheapest
  of the D track; if D1 lands, skip this.

### D3. Matryoshka granularity hierarchy

Today one bge-m3 vector serves three granularities with three scalar floors
(0.78/0.60/0.55) — the literature says granularity is not a scalar threshold
in one space (dense encoders blur event vs topic; that is _why_ the floors
fight each other). Hanley & Durumeric: multilingual-e5-base fine-tuned so
full dims decide same-event, mid dims same-topic, low dims same-theme;
per-level calibrated thresholds; bi-encoder SOTA on SemEval 2022 Task 8
(ρ 0.816); weights released
(github.com/hanshanley/multilingual-matryoshka-news).

- **Do**: local inference with released weights; episodes score on full dims,
  storylines on mid, themes on low; re-calibrate the three floors (A1
  procedure) in the new space; full replay; diff attach decisions + B³ per
  stage against baseline.
- **Success**: B³ up at ≥ 2 of 3 stages, or same B³ with a visibly wider
  sim-floor margin (less threshold sensitivity).
- **Cost**: highest of the spec — full re-embed, new model serving, three
  floor recalibrations. Highest ceiling too: one embedding space aligned with
  the pipeline's actual hierarchy.
- **Caveat**: fp16 pack/unpack is dimension-agnostic (storage indifferent),
  but every stored centroid regenerates; run isolation via the lab reset is
  mandatory.

---

## Track E — adjudicator economics (later)

### E1. Verdict-distilled pre-filter

Every adjudicator call is a labeled pair accumulating in
`.cache/decisions.sqlite`. Once volume is real (thousands of verdicts), train
a cheap logistic/SVM pre-filter over (sim, shared-rare count, EMA stats,
gap-days) to short-circuit the unanimous bands and reserve the LLM for the
genuinely ambiguous middle — ClusterLLM's query-only-ambiguous discipline,
Event Registry's 85-pair SVM precedent. Not worth building until LLM cost or
latency actually bites; the cache already absorbs replay cost.

---

## Suggested order

| #   | Experiment                         | Type             | Cost | Blocked by            |
| --- | ---------------------------------- | ---------------- | ---- | --------------------- |
| 1   | E0 gold labels + B³ harness        | eval infra       | S    | —                     |
| 2   | A1 floor calibration from verdicts | query + sweep    | S    | E0 (for confirmation) |
| 3   | C1 dedupe-window measurement       | query            | XS   | —                     |
| 4   | A2 near-dup sweep                  | sweep            | S    | E0                    |
| 5   | B1 entity-nominated tier-4         | code + A/B       | M    | E0                    |
| 6   | B2 recency in storyline ranking    | code + σ sweep   | M    | E0                    |
| 7   | A3 ambient EMA ceiling             | query + sweep    | S    | E0                    |
| 8   | D1 sparse+dense hybrid             | infra + re-embed | L    | A1 (clean floors)     |
| 9   | D3 Matryoshka hierarchy            | infra + re-embed | L    | A1                    |
| 10  | E1 verdict-distilled pre-filter    | model            | M    | volume                |

D2 is an optional cheap probe before committing to D1/D3. C2 only on QA
evidence of same-burst fragmentation. C3 tracked in the companion doc.

Rule of thumb from both research passes: measure before changing (C1, A3
start as queries), calibrate before swapping models (A before D), and keep
the split-bias — every experiment that loosens a gate must show the false
merges it did _not_ create, not just the joins it gained.
