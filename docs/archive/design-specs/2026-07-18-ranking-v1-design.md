# Ranking v1 Design: Judged, Decomposed, Audited, Tunable

**Date:** 2026-07-18
**Status:** Approved design, pre-implementation
**Scope:** Make the existing `rank_key` machinery evaluable and tunable: full judge coverage, activated source-authority term, run-scoped rank observability (snapshots + term decomposition), a read-only LLM rank audit that produces tuning signal, weight fitting from audit pairs, and a lab-dashboard Ranking view.
**Builds on:** `2026-07-17-ranking-pipeline-design.md` (rank_key formula, rubric judging), `2026-07-18-storyline-event-cards-design.md` (cards), the executed clustering plans, and the topic-theme clustering work (`20260718100300`).

## Context: what exists today

- `compute_rank_key` (`20260718100000`): rubric points (prior = half total weight when unjudged) + `0.5·ln(1+agencies)` + `0.5·ln(1+feeds)` + `ln(source_weight_max)` + `epoch(newest_entry_at)/τ`. Runs once per card at birth inside `insert_event_card`; cards are write-once, rank refresh happens by supersession.
- Judge rubric (8 binary criteria) fires inside `compress_overview`, which — as of `737ae33` — regenerates on **every** episode close, including single-episode storylines. Every storyline's latest card is an overview carrying judged rubric bits (compressor failure → `rubric = null` → 4.0 prior).
- `rubric_weights` v1 is uniform 1.0 — never tuned, no mechanism to tune.
- `storylines.source_weight_max` defaults 1.0 and **no code path updates it**; `ln(1.0) = 0`, the source-authority term is dead.
- Facets: `agency_ids` populated; `topic_themes` → `topic_categories` landed with the theme clustering work (`storylines.theme_id`, KNN join). `storylines.topic` (old fixed-taxonomy column) is unused and stays unused.
- Experiment harness: `experiment_runs` records each deterministic event-time replay; clustering tables hold the latest run's output.

## Goals

1. Every storyline's latest card carries a judged rubric (LLM-as-judge over the full episode-card chain), not a flat prior.
2. Source authority contributes: important agencies (cabinet departments) outweigh sub-branches via a versioned, auditable tier table.
3. Ranking is **completely observable per run**: for any experiment run, the per-facet ordering, each storyline's rank position, and the exact per-term breakdown of its `rank_key` are persisted and inspectable.
4. A read-only LLM rank audit compares neighboring storylines within a facet and records preference verdicts — **never mutating `rank_key`** — producing (a) placement validation and (b) accumulated pairs for weight fitting.
5. Weight fitting turns audit pairs into a proposed new `rubric_weights` version; humans apply it; the next run measures it.
6. The lab dashboard gains a Ranking view: per-facet ranked lists, term decomposition, formula-vs-LLM disagreement markers, run-to-run diff.

## Non-goals

- Mutating `rank_key` from audit output (rejected: order-dependence, feedback loops, fights folded time decay — see research notes below).
- Serving API / SSE / live ranking (experiment harness only).
- Topic taxonomy or theme work (owned by the theme clustering workstream; this design consumes `theme_id`/`category_id` when present).
- Learned ranker beyond explainable weight fitting; personalization; freshness τ retuning (fixed 24 h half-life).

## Research grounding (decisions locked by literature review)

- **Binary rubric bits over scalar scores** — kept. Pointwise LLM scalar scores are poorly calibrated; binary judgments and pairwise comparisons are reliable (Qin et al. 2023, *Pairwise Ranking Prompting*; MT-Bench/G-Eval lineage).
- **Pairwise audit with position-bias control** — every LLM comparison runs both orderings; only consistent verdicts count (Zheng et al. 2023, *Judging LLM-as-a-Judge*: position bias). Inputs bounded uniformly (verbosity bias).
- **Audit as cascade layer, not score mutation** — formula = L1 scorer, LLM = offline auditor; disagreements are mined as tuning labels (standard LTR bootstrap from judge labels; RankGPT-style windowed comparison used for *evaluation*, not serving).
- **Judge over compressed chain, not raw entries** — episode cards are the hierarchical compression layer; feeding raw entry chains hits long-context degradation (Liu et al., *Lost in the Middle*) for no measured gain.
- **Discrete authority tiers, not continuous weights** — 3–4 auditable tiers; `ln()` already caps influence (ln 3 ≈ 1.1 ≈ one rubric bit). Watch for authority double-count (judge prestige bias + agency term + source term): measured via audit attribution, not prevented upfront.
- **Gold standard = preference pairs** — rank quality metrics are computed against pairwise preferences (LLM with bias controls, human spot-labels overriding), aggregated per facet: pairwise agreement rate and Kendall-τ-style ordering correlation. Never against rank_key magnitudes.

## W1 — Chain-aware judging (amended: coverage already landed)

Commit `737ae33` (concurrent workstream) made `CardEngine.on_episode_closed` regenerate the overview card on **every** close, including the first — so every storyline's latest card already carries judged rubric bits, and single-episode storylines are judged. No new `judge_episode` path is needed.

What remains:

- **Prompt hardening:** `COMPRESSOR_SYSTEM` must instruct the rubric to evaluate the *whole chain of events collectively*, not just the latest development. Chain input already exists (`compress_overview` receives every episode card, oldest first).
- Failure semantics unchanged: compressor error → `rubric = null` → prior points; never blocks a close.
- Overview regeneration fires on every episode close — more frequent than the old spec's power-of-two trigger; acceptable at backfill scale, recorded as an open item for live streaming.

## W2 — Publisher authority weights

New versioned table (house SQL style, seeded in-migration):

```text
publisher_weights (
  weight_version int,      -- versions immutable; edits create a new version
  publisher_key  text,     -- joins news_source_publishers.publisher_key
  tier           text,     -- 'cabinet' | 'independent' | 'sub_office' | 'default'
  weight         real,     -- 3.0 / 2.0 / 1.5 / 1.0
  PK (weight_version, publisher_key)
)
```

- Keyed on `publisher_key` (stable curated agency identity from `news_source_publishers`), never on fetch hostname.
- v1 seed is hand-authored over the curated publisher set, informed by structure: cabinet departments 3.0, major independent agencies 2.0, sub-offices/regional 1.5, everything else default 1.0 (absent rows read as 1.0).
- **Wiring:** `attach_entry_to_episode` recomputes storyline aggregates from junction rows; extend that recompute so `source_weight_max` = max member weight via `news_entries → news_source_publishers → publisher_weights` (active version passed as an RPC arg from config, recorded per run). `insert_event_card` then picks it up with zero changes.
- Active version is config (`PUBLISHER_WEIGHT_VERSION`), snapshotted in `experiment_runs.config` — a weight-table change between runs is visible in run diffs.

## W3 — Run-scoped rank observability

### Term decomposition (single source of truth)

`compute_rank_key_terms(...)` — same signature as `compute_rank_key`, returns jsonb:

```json
{"rubric_points": 4.0, "prior_used": true, "agency_term": 0.55,
 "feed_term": 0.35, "source_term": 1.10, "freshness_term": 14321.9}
```

Lives in the same migration family, next to `compute_rank_key`. pgTAP asserts the terms sum to `compute_rank_key`'s result (float epsilon) across representative inputs — decomposition drift is a test failure, not a hope.

### Rank snapshots

After each experiment run (final stage of `run_experiment`, also standalone `pipeline rank snapshot --run <id>`), persist the full ordering per facet:

```text
rank_snapshots (
  run_id       uuid,     -- experiment_runs
  facet_type   text,     -- 'global' | 'category' | 'theme' | 'agency'
  facet_key    text,     -- '' for global; category/theme id; agency key
  position     int,      -- rank() within (run, facet)
  storyline_id uuid,
  card_id      uuid,     -- latest card at snapshot time
  rank_key     float8,
  terms        jsonb,    -- compute_rank_key_terms output
  judged       boolean,  -- rubric present (not prior)
  -- denormalized display fields: experiment resets wipe the clustering
  -- tables, so old runs' snapshots must render standalone
  headline text, summary text, rubric jsonb, interest_reason text,
  agencies int, feeds int, entry_count int, newest_entry_at timestamptz,
  PK (run_id, facet_type, facet_key, position)
)
```

- A storyline appears once per facet it belongs to (each of its agencies; its theme; its theme's category) plus global. Null `theme_id` → global + agency only.
- Written via a `security definer` RPC per house style; snapshot is a pure function of database state + config → deterministic replay yields identical snapshots.
- Config fingerprint (rubric_version, weight_version, τ, judge/audit models, prompt versions) already lives in `experiment_runs.config`; snapshots inherit run identity.

### LLM rank audit (read-only)

`pipeline rank audit --run <id>` — separate CLI stage, never part of the scoring path:

- **Sampling:** within each facet's top-K (`RANK_AUDIT_TOP_K`, default 30), compare each position *i* against *i+1 … i+w* (`RANK_AUDIT_WINDOW`, default 3) — adjacent-and-near pairs, where placement errors matter and are decidable.
- **Protocol:** each pair judged twice with orders swapped, temperature 0, bounded identical-shape inputs (headline, summary, agency count, feed count, entry count, age in hours — the LLM sees freshness explicitly so it doesn't fight decay blindly). Consistent verdicts record `llm_prefers a|b`; contradictory verdicts record `inconsistent` and are excluded from fitting.
- **Storage:**

```text
rank_audit_pairs (
  id, run_id, facet_type, facet_key,
  position_a, position_b, storyline_a, storyline_b,
  formula_prefers text,        -- always 'a' (a = higher-ranked by formula)
  llm_prefers     text,        -- 'a' | 'b' | 'inconsistent'
  llm_reason      text,
  judge_model, prompt_version, sampled_at
)

rank_audit_runs (
  id, run_id, config jsonb, metrics jsonb, created_at
)
```

**Human spot-labels** follow the console's existing `LabelStore` file pattern (not a DB write path — the lab DB connection is read-only from the console): `docs/eval/rank-labels.csv` with header `run_id,storyline_a,storyline_b,preferred` (`a`/`b`). Labels are run-scoped (snapshot and audit rows persist per run even after clustering resets); fitting reads the CSV and overrides `llm_prefers` on matching pairs.

- `metrics` per audit: pairwise agreement rate (overall + per facet), inconsistency rate, disagreement attribution (mean per-term delta among disagreeing pairs — shows *which* formula term the LLM disputes, including the authority double-count check).
- Audit LLM calls go through the existing response cache keyed by (pair content, prompt_version) — replays are free.

### Weight fitting

`pipeline rank fit --runs <id,...> [--write]`:

- Training pairs: all consistent audit pairs across the given runs; `rank-labels.csv` rows override `llm_prefers`.
- Features per pair: the 8 rubric-bit differences between the two storylines; the fixed-term deltas (agency, feed, source, freshness) enter as a fixed offset in the logit, not as fitted coefficients — only rubric weights are tunable. Target: which side preferred.
- Model: logistic regression (numpy gradient descent, zero-init, L2, deterministic — no new dependency). Fitted rubric coefficients are rescaled onto the current weight scale and printed alongside v-current for review.
- `--write` inserts the proposal as a **new** `rubric_weights` version (never updates in place, never auto-selects); runs pick weights via `RUBRIC_VERSION` config. Fit → apply → rerun → compare snapshots is the tuning loop, fully recorded.

## W4 — Dashboard Ranking view

New page in the operator console (follows the StorylinesPage data-access pattern):

1. **Run picker** (experiment_runs, newest first) + **facet selector** (global / category / theme / agency).
2. **Ranked table:** position, headline (links to storyline detail), rank_key, term breakdown (stacked bar + exact values — rubric vs prior badge, agency/feed/source/freshness), agencies count, distinct feeds, rubric bit chips, `interest_reason`.
3. **Audit overlay:** rows involved in disagreeing audit pairs get a marker; expanding shows the pair, the LLM's reason, and a spot-label control appending to `docs/eval/rank-labels.csv`.
4. **Run diff:** pick a second run → position-delta column (▲/▼ n) for storylines present in both, plus config diff (weights/versions) between the runs.
5. **Audit metrics strip:** agreement rate, inconsistency rate, top disagreement attribution from `rank_audit_runs.metrics`.

## Evaluation metrics (definition of "good ranking")

- **Primary:** pairwise agreement rate between formula order and preference pairs (LLM, human-overridden), per facet and overall. Tracked run-over-run in `rank_audit_runs`.
- **Secondary:** ordering correlation over the audited top-K (Kendall-τ computed from the sampled pair verdicts); judged-coverage rate (share of snapshot rows with `judged = true` — W1 should push this to ~100%); disagreement attribution per term.
- Human spot-labels are the trust anchor: periodically sample LLM-labeled pairs for human review; sustained LLM/human divergence gates any weight fit built on LLM pairs.

## Configuration additions

| Key                        | Default              | Notes                                        |
| -------------------------- | -------------------- | -------------------------------------------- |
| `PUBLISHER_WEIGHT_VERSION` | 1                    | active publisher_weights version             |
| `RANK_AUDIT_TOP_K`         | 30                   | audited depth per facet                      |
| `RANK_AUDIT_WINDOW`        | 3                    | compare position i with i+1…i+w              |
| `AUDIT_MODEL`              | = `JUDGE_MODEL`      | separate key so it can diverge               |
| `RANK_AUDIT_FACETS`        | global,category      | facets audited by default (cost control)     |

## Failure semantics

- Compressor/judge error → overview born with prior, unchanged from today.
- Audit LLM error on a pair → pair recorded `inconsistent` with the error reason; audit continues.
- Snapshot stage failure → experiment run still recorded (snapshot is re-runnable standalone from the same DB state).
- Weight fitting refuses to run below a minimum consistent-pair count (config, default 50) — no fits from noise.

## Sequencing

W1 (chain-judging prompt hardening) → W2 (publisher weights — activates dead term) → W3 (decomposition, snapshots, audit, fitting) → W4 (dashboard). W2 and W1 are independent and can parallelize; W3 snapshots want both landed so recorded values are the real formula.

## Open items

1. Overview regeneration fires every episode close (≥ 2), not on doubling — cost fine for backfill; revisit before live streaming.
2. Authority double-count (judge prestige bias + agency term + source term): measured via audit disagreement attribution; blind the judge to agency identity only if data shows crowding-out of small-but-critical publishers.
3. Publisher tier seed is hand-authored v1; revisit with GSA structural data (budget/traffic) if tier disputes show up in audits.
4. Theme floors are uncalibrated (owned by theme workstream); category-facet snapshot quality inherits whatever theme assignment quality exists per run.
5. Migration numbering: next free band starts at `20260718100700` (…100600 exists uncommitted in-tree).
