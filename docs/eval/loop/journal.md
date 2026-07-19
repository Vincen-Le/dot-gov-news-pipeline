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
