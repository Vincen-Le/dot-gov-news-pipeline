# Storyline Vector Representation: Anchor Docs, Multi-Vector Scoring, Prospective Continuations

**Date:** 2026-07-18
**Status:** Draft — pending review
**Builds on:** `2026-07-18-clustering-retrieval-enrichment-hypotheses-design.md` (H1–H3),
`docs/operations/clustering-experimentation-spec-2026-07-18.md` (Tracks A/B/D, E0),
`docs/operations/topic-clustering-research-validation-2026-07-18.md`

## Problem

The goal: a new news event should land close to its existing storyline in
vector space. Today it often does not, and the failure is in *what the
storyline vector is*, not in the embedding model.

The storyline vector is the embedding of the **latest overview card's 1–2
sentence compressed summary** (`CardEngine._regenerate_overview`,
`pipeline/cards.py:63`; the `insert_card` RPC copies `overview_embedding`
into `storylines.centroid`). Three representation-level mismatches follow,
each with direct support in the retrieval literature:

1. **Prose-summary vector drops the discriminators.** Abstractive
   compression removes rare entities, docket/case/recall numbers, program
   names — precisely the highest-signal tokens for matching. This is the
   core finding behind contextual retrieval (Anthropic 2024: augmenting
   chunks with dense situating context cut retrieval failures ~35%, ~49%
   with hybrid lexical, ~67% with rerank): *augment* the embedded text with
   structure, never replace it with smooth prose.
2. **Temporal register mismatch.** The overview describes the chain's
   *past* ("agency proposed rule X; comment period closed"); the incoming
   entry describes a *new development* ("court blocks rule X"). Same chain,
   systematically depressed cosine. This is why `storyline_sim_floor` must
   sit low (0.60), which in turn admits noise into adjudication.
3. **Single-vector drift.** One vector per storyline drifts toward the mean
   of old coverage. TDT / story-link-detection results are consistent:
   max-similarity over members beats a centroid for *evolving* stories,
   because the new development resembles one recent episode more than the
   compressed whole.

A fourth, structural, problem is already recorded as H2 in the companion
hypotheses doc and restated here because it bounds everything below:
**vector similarity never nominates storyline candidates** — candidates come
exclusively from entity GIN overlap (`storylines_by_entities`,
`pipeline/storylines.py:42`). Zero shared entities → the right storyline is
never scored, however good its vector. H4–H6 define *what vector* H2's
embedding-nomination path should search; H2 without them searches a weak one.

## Research context (why these hypotheses, not others)

Mapping of the retrieval literature onto this pipeline, recorded so we do
not re-derive it:

- **doc2query / docT5query** (Nogueira & Cho 2019): generate likely queries
  from a document, index those, to bridge query↔document register mismatch.
  **doc2query--** (Gospodinov et al. 2023): generated queries hallucinate;
  filtering them improves quality *and* shrinks the index. The storyline
  analog is not "questions users might ask" but **hypothetical
  next-development headlines** — the register the incoming entry actually
  arrives in (H6).
- **Contextual retrieval** (Anthropic 2024): embed structured, entity-dense
  augmented text, not summaries (H4).
- **Multi-representation indexing**: several vectors per object, score by
  max-sim — never blend into one averaged vector (H5, H6 scoring rule).
- **HyDE** (Gao et al. 2022): query-side mirror — generate a hypothetical
  parent-overview from the incoming entry and compare against overview
  vectors. Costs one LLM call per entry at cluster time; deferred (see Out
  of scope).
- **Asymmetric instruction prefixes**: not applicable — bge-m3 dense mode is
  prefix-free; the model is not the bottleneck, the representation is.
  Embedding-model swaps stay owned by Track D (D1 sparse+dense, D3
  Matryoshka).
- **Hybrid + rerank**: the pipeline already has the moral equivalent —
  entity GIN is the lexical leg, the adjudicator is the reranker. H2's
  union-of-sources completes the hybrid; nothing new needed here.

## Hypotheses

Numbering continues from the companion doc (H1–H3 live there).

### H4 — Anchor document beats prose summary as the storyline vector

**Change:** in `CardEngine._regenerate_overview`, embed a structured anchor
instead of `card["summary"]` alone:

```
headline
summary
timeline bullet texts (most recent first, capped)
rare entities (daily_ema below ambient_ema_ceiling, capped ~16)
event keys
```

Deterministic composition from data already in hand at card-write time (the
compressor output plus the storyline's entity/event-key sets) — no new LLM
call. Display surfaces untouched: the anchor is embedded, never shown, same
internal/external split as `enriched_text`.

**Mechanics:** anchor text capped well under the embed input limit; bump
`prompt_version` or introduce an `anchor_version` so replays attribute the
change; `overview_embedding` (and thus `storylines.centroid` via the RPC
coalesce) regenerates on the next overview refresh — a `--clear` lab replay
regenerates the whole corpus's storyline vectors, so no separate backfill
path is needed.

**Validates if:** on the E0 gold pair set, the same-chain vs different-chain
similarity distributions separate more (means further apart, fewer same-chain
pairs under `storyline_sim_floor`); nomination recall@3 up.

**Risks:** entity-list bloat diluting the vector (hence caps, rare-only);
anchor composition becomes another versioned artifact to record alongside
`enricher_version` / embedding tag in calibration provenance.

### H5 — Multi-vector storyline scoring: max-sim over recent episode centroids

**Change:** in `StorylineEngine.resolve`, score each candidate storyline as

```
score = max(cos(entry, storyline_anchor),
            max over K most-recent episode centroids of cos(entry, ep_centroid))
```

Episode centroids already exist (running mean per episode,
`pipeline/episodes.py`); the missing piece is one read: recent episode
centroids per candidate storyline (K ≈ 3–5). No LLM cost, no writes.

**Why:** fixes drift (problem 3) and partially fixes overview staleness
(companion doc H2 risk: overview refreshes only on episode close; episode
centroids are always fresher). A chain whose latest development resembles
its previous episode but not its compressed history stops being invisible.

**Split-bias guard:** max over more vectors inflates scores — every floor
this score feeds must be recalibrated (A1 procedure) on the same replay.
Decision for review: the deterministic join rule (≥2 shared rare entities
AND sim ≥ `cluster_join_threshold`) also consumes this score. Proposed:
yes, but recalibrate `cluster_join_threshold` against the max-sim
distribution; if wrong joins rise, restrict max-sim to nomination + floor
and keep the deterministic join on anchor-sim only.

**Validates if:** nomination recall@3 up, concentrated on long chains
(`episode_count ≥ 3`) and stale-overview cases (entry arrives while an
episode is open, overview lags); wrong-join rate flat.

### H6 — Prospective continuation vectors (doc2query adapted to event chains)

**Change:** when the compressor regenerates an overview, it additionally
emits 3–5 `expected_developments` — short hypothetical *next-development
headlines* for the chain ("appeals court rules on X", "agency finalizes X",
"recall expanded to additional lots"). Each is embedded; the vectors are
stored as auxiliary storyline vectors and replaced wholesale on every
overview refresh (they describe the future as of that refresh; stale
continuations are wrong continuations).

Scoring: continuation vectors join the H5 max-sim pool **for nomination and
floor only** — never for the deterministic entity+threshold join. This is
the doc2query-- lesson applied: generated text is speculative; it may
propose candidates, the adjudicator decides. The existing split-biased
architecture absorbs this safely — a hallucinated continuation can at worst
send one extra candidate to a prompt that is already biased to say no.

**Mechanics:** one added field in the compressor JSON schema (same call, no
new LLM invocation); storage as a packed-fp16 array alongside
`overview_embedding` (same card row or a small side table — implementation
detail for the plan); embed cost +3–5 texts per episode close, batched with
the overview embed.

**Validates if:** nomination recall improves specifically on the
**register-shift slice** of the gold set — pairs where the new development's
type differs from the chain's history (proposal→ruling, arrest→sentencing,
recall→expansion). E0 labeling should tag this slice explicitly. Wrong-join
rate flat (adjudicator gate holds). Candidate-source attribution (H2's
logging) extended with a `continuation` source so the win is directly
observable.

**Risks:** hallucinated continuations attract wrong entries — mitigated by
nomination-only scoring + adjudicator + attribution tracking; if the
`continuation`-sourced wrong-nomination rate is high, cap to 3 or add the
doc2query-- filter (score each continuation against the chain's own anchor,
drop outliers). Compressor JSON schema change touches the fallback path in
`CardEngine._regenerate_overview` — fallback simply emits no continuations.

## Relation to existing hypotheses and tracks

| This spec | Companion work | Relationship |
|---|---|---|
| H4 anchor doc | H1 acronym enrichment | Same-register canonicalization, two sides: H1 fixes the entry text, H4 the storyline text. H1 lands first (it forces corpus re-embed + recalibration anyway). |
| H4 anchor doc | D2 entity-injected embed text | D2 is the entry-side twin probe; if H1+H4 validate, D2 is likely subsumed — record the verdict rather than running both. |
| H5 max-sim | H2 hybrid retrieval | H2 adds the vector-NN *nomination* source; H5 defines the *score* once nominated. H2's embedding leg should search H4 anchors and score via H5. |
| H6 continuations | H3 multi-candidate adjudication | H6 widens the candidate pool H3 adjudicates; H3's single-call design is unchanged. |
| all | E0 gold labels, A1 calibration | Hard prerequisites — every hypothesis here shifts similarity distributions and is unmeasurable without them. |
| all | Track D model swaps | Orthogonal by design: H4–H6 change *text and scoring*, D changes *the space*. Do not interleave — attribution dies. |

## Sequencing

Order chosen so each landing has clean attribution and thresholds are
recalibrated exactly when invalidated, not more often:

1. **E0** — gold pair set (~200 storyline-attach pairs, stratified by sim
   band; tag the register-shift slice for H6) + B³/pairwise-F1 in the replay
   report. Blocks everything.
2. **H1** (companion doc) — enricher v2, corpus re-enrich + re-embed.
3. **A1 calibration** — floors set against the v2 space. This is the
   baseline all later replays diff against.
4. **H4** — anchor composition; replay; recalibrate `storyline_sim_floor`
   (anchor shifts the storyline-side distribution only — entry vectors
   untouched, episode floors stay).
5. **H5** — max-sim scoring; replay; recalibrate the floors it feeds.
   Separate landing from H4 — one changes vector content, the other scoring;
   attribution requires the diff between them.
6. **H2** (companion doc) — vector-NN nomination over H4 anchors, scored per
   H5.
7. **H6** — continuation vectors into the nomination pool.
8. **H3** (companion doc) — multi-candidate adjudication over the full
   hybrid pool.

Steps 4–7 are cluster-phase-only changes; the prepare/cluster split keeps
each replay cheap (`pnpm ops lab run`, features cached). Step 2 is the one
expensive re-embed, and it is already mandated by the companion doc.

## Eval plan

Shared metrics, reported per replay by the existing experiment tooling plus
the E0 extension:

- **Nomination recall@3** — correct storyline in the top-3 candidate list
  above floor (the number H4/H5/H6 exist to move).
- **Sim-margin separation** — same-chain vs different-chain distribution gap
  on the gold set, per representation version.
- **Attach-method mix** — `new_storyline` rate down, `adjudicated_join*` up,
  deterministic joins stable.
- **Wrong-join tripwire** — hand-checked false merges on the gold set; any
  rise blocks the hypothesis that caused it (split-bias is the house rule).
- **Candidate-source attribution** — which source produced the winning
  candidate: `entity`, `embedding_anchor`, `episode_centroid`,
  `continuation`, `event_key`. Directly tests H2/H5/H6 individually.
- **Register-shift slice** — H6's specific claim; report recall on that
  slice separately.
- **Adjudicator call volume** — cost guard; H5/H6 widen nomination and must
  not blow up call count (cap candidate pool at ~10 per H2).

## Known risks

- **Threshold churn** — every hypothesis shifts a similarity distribution.
  Provenance rule: calibration artifacts record `enricher_version`,
  embedding tag, and anchor/scoring version. Never compare floors across
  representation versions.
- **Score inflation compounding** (H5+H6) — max over an ever-larger vector
  pool ratchets scores upward. Recalibrate after each landing, not once at
  the end; watch the wrong-join tripwire per step.
- **Continuation hallucination** (H6) — bounded by nomination-only scoring;
  the doc2query-- filter is the prepared fallback.
- **Anchor drift from display text** (H4) — the embedded anchor and the
  user-visible overview diverge by design; QA tooling that eyeballs "why did
  this attach" must render the anchor, not assume the summary was embedded.
- **Compressor schema coupling** (H6) — one more field the fallback path and
  `validate_timeline`-style guards must tolerate missing.

## Out of scope

- **HyDE entry-side probe** — generate a hypothetical parent-overview from
  the incoming entry at cluster time. Per-entry LLM cost where H4–H6 are
  free or amortized; revisit only if the register-shift slice stays weak
  after H6.
- **Embedding model swaps** — Track D (D1 sparse+dense, D3 Matryoshka) owns
  the space; this spec owns what goes into it.
- **pgvector / ANN index** — deferred per H2's scale note; brute-force scan
  acceptable at current corpus size.
- **Cross-encoder reranker** — the adjudicator already occupies this slot;
  E1 (verdict-distilled pre-filter) is the economics play, tracked in the
  experimentation spec.
- **Theme-stage representation** — Stage 4 has its own centroid scheme and
  its own research-validation follow-ups; nothing here touches
  `pipeline/topics.py`.
