# Clustering autoresearch journal — jul19

## Run contract

- Branch: `autoresearch/jul19` (forked cleanly from `main` at `be87e25`)
- Started: 2026-07-19 03:50 EDT
- Earliest finish: 2026-07-19 11:50 EDT (continuous eight-hour minimum)
- Database: local Supabase only, `127.0.0.1:57422`
- Corpus frozen for the initial series: 9,657 entries, all 9,657 embedded, enriched, and entity-extracted; published 2025-07-18 through 2026-07-17
- Pre-loop concurrency sentinel: run `c92b4ae8-3672-4ac1-8f6c-fa0d90aa6085`, `rank-smoke`, finished 2026-07-19 02:12:57 UTC
- Input selection: all prepared entries; real models; decision cache enabled; `TOPICS_ENABLED=true`
- Golden dataset: intentionally unused per operator instruction
- Reward and judging: `/Users/vincent.le/.codex/skills/clustering-autoresearch/scoring.md`; six blinded vector judges per crawl; false merges weighted -2

## Iteration 00 — baseline

- Target: establish unmodified reference across V1–V6
- Change: none
- Expected effect: reference only; no keep/revert decision
- Cost tier: baseline real-model replay, cache enabled
- Status: restarted on bounded deterministic input

### Completed baseline replay

- Run ID: `cc752797-55d8-4a71-846a-1b914d0e2c33`
- Duration: 3,625.2s; processed 150; cache 4 hits / 231 misses
- Output: 140 episodes, 126 storylines, 13 multi-episode storylines,
  4 live themes, 23 themed storylines, 103 category-only storylines
- Health: overview fallback 0.143; 5 adjudicator errors and 2 category
  classifier errors recorded; no theme-creator errors
- Blinded crawl: V1 14 non-anchor episodes; V2 23 memberships across 4 themes;
  V3 23 category/storyline pairs; V4 0 deterministic merge candidates; V5
  633 entity tokens + 1 event key across 100 entries; V6 10 non-anchor entries
- Intruder self-test: 10/10 (the four live themes were cycled to preserve the
  fixed 10-trial denominator; this limited-theme coverage caveat applies)
- Mechanical scores: V1 0.142857; V2 -0.130357; V3 0.956522; V4 penalty 0;
  V5 0.093207; V6 1.000000; **R = 0.412446**
- Method diagnostic: worst V1 join precision 0.692308 (`adjudicated_join`)
- Decision: baseline reference; no keep/revert action
- Status: complete

### Aborted full-corpus attempt

- Command contract: all 9,657 prepared entries, no input bound
- Result: operational crash; manually interrupted after 18m35s at 78/9,657
  entries (event time 2025-07-21), with no `experiment_runs` row written
- Evidence: 8,620 topology-estimated storylines and uncached card/category/theme
  JSON calls imply a roughly 38-hour replay before any six-vector crawl
- Recovery: the next `experiment` resets the partial derived state
- Decision: keep the unmodified configuration but freeze a deterministic,
  non-golden topology-curated input contract so the requested eight-hour loop
  can perform multiple evaluated iterations

### Fixed input contract for scored iterations

- Topology label set: `acdfcb17-e476-4ee9-a735-d0f4a086641b`
  (`corpus-topology-strict`, provisional selection labels only; not gold truth)
- Limit: 150; published cutoff: 2025-10-01T00:00:00Z
- Mix: 30% expected multi-episode, 10% expected multi-entry/single-episode,
  60% singleton fill
- Seed: `jul19-loop-window`
- Preview receipt: exactly 150 entries spanning 2025-07-18 through 2025-09-30,
  20 agencies, 44 multi-episode entries (whole-group packing), 15
  multi-entry/single-episode entries, 91 singleton entries, 117 estimated
  storylines

### Aborted year-wide topology attempt

- Prior contract: 250 entries, 40/10/50 topology mix, seed `jul19-loop`,
  spanning 2025-07-23 through 2026-07-17
- Result: operational crash; manually interrupted after about 30 minutes at
  64/250 entries, with no `experiment_runs` row written
- Cause: the sparse year-wide sample crossed the 24-hour promotion-sweep
  interval on nearly every entry; every sweep re-ran mop-up membership checks
  over all categorized/unattached storylines, producing nonlinear API work
- Recovery/decision: the final scored contract preserves topology diversity
  inside a 75-day cutoff, reducing sweep count while retaining V1/V6 cases

### Setup note — live config supersedes stale knob prose

`pipeline/config.py` on `be87e25` confirms `STORYLINE_SIM_FLOOR` is wired, while
the older `THEME_STICK_FLOOR` no longer exists. The lazy-promotion design adds
`THEME_PROMOTION_MIN_STORYLINES`, `THEME_PROMOTION_MIN_ACTIVE_DAYS`,
`THEME_PROMOTION_COHESION_FLOOR`, `THEME_PROMOTION_CLUSTER_FLOOR`,
`THEME_DEMOTION_COHESION_FLOOR`, and `THEME_SWEEP_INTERVAL_HOURS`. Future
sweeps will use only keys verified in the live `load_config()` implementation.

## Iteration 01 — recurrent extraction junk lexicon

- Vector targeted: V5 entity extraction validity (baseline 0.093207 vs 0.80
  diagnostic target; largest reward headroom)
- Exact change: add the union of (a) all 48 invalid tokens from the top-50
  `entity_stats` sweep and (b) all sample-invalid tokens occurring at least
  twice to `_COMMON_ENGLISH` in `pipeline/extraction.py`; 114 tokens total;
  bump `EXTRACTOR_VERSION` 2 -> 3 and update its frozen-version test
- Evidence before change: those tokens account for 192 baseline invalid entity
  judgments and 0 valid judgments; constant-sample projected precision rises
  from 0.093207 to 0.133787
- Expected effect: materially higher V5 precision; fewer ubiquitous entity
  gates may also reduce V1/V2 false merges; event-key validity unchanged
- Cost tier: Tier 2 (deterministic extraction only; test, reextract, replay)
- Implementation receipt: committed as `17bbabd`; extraction tests 13/13 pass;
  all 9,657 local entries were regenerated at extractor version 3 before the
  replay
- Run ID: `aa4e1564-5055-47d3-a6f7-2e5288e3371c`
- Duration: 3,215.4s; processed 150; cache 3 hits / 132 misses; 140 episodes,
  127 storylines, 12 multi-episode storylines, 4 themes / 24 themed storylines;
  no model errors
- Blinded crawl: V1 13 non-anchor episodes; V2 24 memberships across 4 themes;
  V3 24 category/storyline pairs; V4 0 deterministic merge candidates; V5
  480 entity tokens + 2 event keys across 100 entries; V6 10 non-anchor entries
- Intruder self-test: 10/10 (four themes cycled to retain 10 independent
  least-fit trials)
- Mechanical scores: V1 0.307692; V2 0.875000; V3 1.000000; V4 penalty 0;
  V5 0.262500; V6 1.000000; **R = 0.689038**
- Delta: +0.276593 versus baseline, far above the targeted V5 reward quantum
  0.000417; worst V1 method precision also improved from 0.692308 to 0.769231
- Decision: **KEEP**
- Reproducibility discovery: the required regeneration exposed a pre-existing
  path mismatch. Normal `prepare` extracts from `summary or body_text`, while
  `reextract` extracts from `body_text or summary`. The scored result therefore
  reflects the committed lexicon plus regeneration through the existing
  body-first command. This is explicitly isolated in iteration 02 rather than
  silently folded into this decision.
- Status: complete

## Iteration 02 — extraction source parity

- Vector targeted: V5 entity extraction validity and feature reproducibility
- Exact change proposed: centralize the extraction input policy and make both
  normal preparation and deterministic regeneration use `summary or body_text`;
  bump the extractor version once to force a coherent local refresh
- Evidence before change: on the fixed 100-entry V5 sample, the version-3
  summary-first policy emits 441 tokens versus 480 body-first. Of 425 shared
  tokens, the blind judge marked 122 valid and 303 invalid; 51/55 body-only
  tokens were invalid. Summary-first removes those 51 known-invalid tokens and
  restores 16 summary-only candidates, while retaining all 59 entities the
  baseline V5 judge marked valid (body-first retained 54/59).
- Expected effect: V5 precision above the current 0.262500 lower bound of
  0.276644 before judging the 16 restored tokens, with one versioned and
  reproducible input policy for current and future entries
- Cost tier: Tier 2 (deterministic source-policy fix, test, reextract, replay)
- Implementation receipt: committed as `d2d9270`; extraction/prepare tests
  26/26 pass; all 9,657 local entries regenerated at extractor version 4
- Run ID: `2a6a9639-c5f2-4b23-86a5-9f05d70e22ce`
- Duration: 3,096.8s; processed 150; cache 36 hits / 73 misses; 140
  episodes, 127 storylines, 12 multi-episode storylines, 3 themes / 19 themed
  storylines; no model errors
- Blinded crawl: V1 13 non-anchor episodes; V2 19 memberships across 3 themes;
  V3 19 category/storyline pairs; V4 0 deterministic merge candidates; V5
  441 entity tokens + 1 event key across 100 entries; V6 10 non-anchor entries
- Intruder self-test: 10/10 (three themes cycled to retain 10 independent
  least-fit trials)
- Mechanical scores: V1 0.307692; V2 0.023810; V3 1.000000; V4 penalty 0;
  V5 0.321995; V6 1.000000; **R = 0.530699**
- Delta: -0.158339 versus the current best; the V5 gain of +0.059495 was
  overwhelmed by a `Global Conflict Diplomacy` false-merge theme (2/8 members
  fit, too broad) and one false `Disaster Relief Efforts` member
- Decision: **REJECT**; revert code and restore version-3 body-first features
- Status: complete

## Iteration 03 — recurring-event adjudicator rubric

- Vector targeted: V1 storyline continuation validity (current best 0.307692;
  3 false merges among 13 non-anchor episodes)
- Exact change proposed: bump the prompt version and add an adjudicator rule
  that recurring-format contacts/notices with different dates are distinct
  events unless a unique incident, order, docket, deadline, or explicit
  continuation ties them together; namespace the decision cache by prompt
  version so the new rubric cannot reuse v1 verdicts
- Evidence before change: all three false joins in the current best match this
  failure mode: Landau-Bu meetings 56 days apart, Rubio-Lammy calls 29 days
  apart, and Grand Canyon water-restriction notices 55 days apart. The 10 valid
  joins provide counterexamples that must remain attached, including the
  explicitly shared Honouliuli anniversary program and concrete FEMA deadlines.
- Expected effect: reject the three recurring-event false merges while
  preserving the 10 real continuations; best-case V1 rises from 0.307692 to
  1.000000 and reward rises by 0.138462
- Cost tier: Tier 2 (prompt/cache-version code, targeted tests, full replay)
- Implementation receipt: committed as `3b254d0`; 44 focused tests passed.
  The first replay reached 65/150 before a model transport timeout and the
  exact retry reached 3/150 before the same failure; neither wrote an
  `experiment_runs` row. A separate non-semantic retry hardening change was
  committed as `82e79a6` with a two-timeout-then-success test, after which the
  unchanged experiment completed.
- Run ID: `2ebb9ac8-a9aa-47f1-9c90-45bee7f49414`
- Duration: 4,081.0s; processed 150; cache 17 hits / 118 misses; 140 episodes,
  128 storylines, 12 multi-episode storylines, 3 themes / 14 themed
  storylines; no model errors
- Blinded crawl: V1 12 non-anchor episodes; V2 14 memberships across 3 themes;
  V3 14 category/storyline pairs; V4 0 deterministic merge candidates; V5
  480 entity tokens + 2 event keys across 100 entries; V6 10 non-anchor
  entries
- Intruder self-test: 10/10 (three themes cycled to retain 10 independent
  least-fit trials)
- Mechanical scores: V1 0.000000; V2 -0.166667; V3 1.000000; V4 penalty 0;
  V5 0.127083; V6 1.000000; **R = 0.392083**
- Delta: -0.296955 versus the current best, below the targeted V1 reward
  quantum 0.050000. Four of 12 continuation joins were still false, and the
  `International Conflict Diplomacy` theme admitted only 1/6 members and was
  judged too broad.
- Decision: **REJECT**; prompt/cache-version code reverted by `24b4404`.
  Keep the independent transport-retry hardening because it changes no
  successful model result and was necessary for a completed crawl.
- Status: complete

## Iteration 04 — recurring-contact gap guard

- Vector targeted: V1 storyline continuation validity (current best 0.307692;
  3 false merges among 13 non-anchor episodes)
- Exact change proposed: before LLM adjudication, decline a candidate when
  both the new item and current storyline evidence are explicitly titled as a
  `call` or `meeting`, their publication gap exceeds 21 days, and they share
  no extracted event key. Other candidate types and shorter gaps retain the
  existing adjudicator path.
- Evidence before change: two incumbent false joins are recurring diplomatic
  contacts 29 and 58 days apart (Rubio-Lammy calls and Landau-Bu meetings).
  No valid incumbent join is a call/meeting beyond 21 days; the only long-gap
  valid chain is a named Honouliuli 10th-anniversary programming series, which
  the narrow contact-title guard does not match.
- Expected effect: split two false contact joins while preserving all 10 valid
  joins and the unrelated 55-day Grand Canyon false join; projected V1 rises
  from 0.307692 (10 valid / 3 false) to 0.727273 (10 / 1), increasing reward
  by about 0.083916 before topology side effects.
- Cost tier: Tier 2 (deterministic attachment guard, targeted tests, full
  replay; no extraction or embedding refresh)
- Implementation receipt: committed as `ad40800`; storyline and transport
  tests 26/26 pass.
- Interrupted attempt: the first replay stopped at 24/150 during the requested
  pause, coincident with an exhausted DNS/connect retry. It wrote no
  `experiment_runs` row; the exact restart resets this partial derived state.
- Run ID: `17bbd82d-feda-4de1-9456-9e4b14082966`
- Duration: 4,259.4s; processed 150; cache 68 hits / 66 misses; 140 episodes,
  128 storylines, 11 multi-episode storylines, 3 themes / 17 themed
  storylines; model fallbacks: 1 adjudicator and 2 category-classifier errors
- Direct target trace: the Landau-Bu meetings split correctly, but the
  Rubio-Lammy calls remained joined because the generated storyline overview
  headline did not contain `call`; the narrow guard inspected that overview
  rather than the latest real member title.
- Blinded crawl: V1 12 non-anchor episodes; V2 17 memberships across 3 themes;
  V3 17 category/storyline pairs; V4 0 deterministic merge candidates; V5
  480 entity tokens + 2 event keys across 100 entries; V6 10 non-anchor
  entries
- Intruder self-test: 10/10 (three themes cycled to retain 10 independent
  least-fit trials)
- Mechanical scores: V1 0.500000; V2 0.041667; V3 1.000000; V4 penalty 0;
  V5 0.112500; V6 1.000000; **R = 0.530833**
- Delta: -0.158205 versus the current best, below the targeted V1 reward
  quantum 0.050000. V1 improved, but `Global Conflict Diplomacy` admitted only
  1/8 members and was judged too broad.
- Decision: **REJECT**; deterministic guard reverted by `5503dee`.
- Status: complete

## Pause handoff — recovered incumbent checkpoint

- Run ID: `a9dc9c1a-3e78-4fb6-ba4f-1d72294b8c70`
- Run name: `jul19-final-best-checkpoint`
- Duration: 4,610.4s; processed 150 entries into 141 episodes, 127
  storylines, 282 cards, and 3 live themes; cache 32 hits / 104 misses.
- Deterministic topology: label set
  `361d307e-0718-49a0-8e81-77a754f635ad`, seed
  `jul19-loop-window`, with 44 multi-episode, 15 multi-entry single-episode,
  and 91 singleton-storyline entries.
- Persistence: the completed run is in `complex_v1_experiment_runs`; its
  immutable replay payload is in `complex_v1_experiment_cluster_snapshots`
  with all 150 memberships and evidence rows. It is marked as the provisional
  dashboard incumbent.
- Evaluation status: fresh six-vector blinded judging was deliberately not
  started after this replay, per the requested stop boundary while separate
  databases are prepared for `complex_v1` and `simple_v1`. Snapshot reward
  metadata says `pending_blind_evaluation`; no row was added to `scorecard.csv`.
- Historical context: the matching incumbent configuration previously scored
  R=0.689038 on run `aa4e1564-5055-47d3-a6f7-2e5288e3371c`; that database
  snapshot was lost during a local reset, so its score is stored only as
  historical metadata and is not attributed to this fresh run.
- Status: paused after successful capture; no further experiment launched.
