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

Testing space is small (<2000 articles; golden slice is 1,181 labeled
entries). Simplicity and measurability beat cleverness.

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
| 7 | Evaluation | **Gap in current harness confirmed.** Only operational proxies exist (singleton rates, attach mixes); the 1,181-entry golden set is curated but nothing scores against it (spec follow-up "E0"). B³ alone under-penalizes fragmentation of small clusters — and this corpus is mostly small storylines. | First deliverable is a **golden scorer** (B³ P/R/F1 for episodes and storylines, pairwise F1, ARI) wired into every experiment report — it scores the classic engine too, so spine-vs-classic is a real quality comparison from day one. |

Everything else in the proposal survives unchanged: two-phase
prepare/replay, judge-gated joins, master node for singletons, event cards
as per-episode checkpoints (this is literally how `event_cards` already
works — write-once rows with `version`/`superseded_by`), and rank_key reuse
(`compute_rank_key` fires inside the `insert_event_card` RPC; zero new work).

## Amended architecture

### Data flow

```
prepare (shared machinery, spine prompt):
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
| `pipeline/score.py` | **Shared** golden scorer (B³, pairwise F1, ARI) — engine-agnostic |

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

### Success criteria

1. `pnpm ops lab run --stub --set LAB_ENGINE=spine` completes: report +
   `experiment_runs` row + rank snapshot.
2. Golden scorer emits episode-B³/storyline-B³/pairwise-F1/ARI for both
   engines in every report.
3. A real spine run over the golden slice produces scores comparable to a
   classic baseline run — the A/B the whole exercise exists for.

### Out of scope (v1)

Kleinberg burst modeling; storyline-level retroactive repair (margins are
logged to enable it later); learned ranking; CEAF-e (needs Hungarian
matching — revisit if B³/ARI disagree); hosted/scheduled operation; theme
hierarchy.
