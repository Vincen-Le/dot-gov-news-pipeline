# Clustering Evaluation Loop — Autonomous Experiment/Tune/Verify Plan

> **For the executing agent:** You run clustering experiments in a loop: evaluate the produced artifacts on five vectors (you are the LLM judge), tune one parameter or implementation detail per iteration, re-run, and verify improvement. This plan is self-contained; vectors 1–2 defer their detailed judging calibration to `docs/superpowers/plans/2026-07-18-artifact-coherence-report.md` (read it before the first crawl).

**Goal:** Converge the clustering + topic pipeline (episodes → storylines → themes → categories, plus entity extraction feeding all of it) toward the quality targets below, leaving behind: a scorecard time-series, a decision journal, per-iteration eval reports, and a final verified configuration (and/or code changes) with evidence.

## Environment

- Local Supabase Postgres, port **57422**. `DATABASE_URL` never goes in `.env`; export per command:
  `DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:57422/postgres'`
- No `psql` on this machine. All reads via the pipeline Db helper:

```bash
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:57422/postgres' uv run python - <<'EOF'
from pipeline.db import Db
import os
db = Db(os.environ["DATABASE_URL"])
print(db.all("select 1 as ok"))   # .all -> list[dict], .one -> dict|None
EOF
```

- Experiments run through the pipeline CLI (`sync/prepare/reextract/cluster/rank/reset/experiment`). `experiment <name>` = reset-clusters + event-time replay + report + `experiment_runs` row, in one command. It is structurally local-DSN-guarded.
- **Themes only exist when `TOPICS_ENABLED=true`** (config default is false). Every experiment in this loop must set it:

```bash
TOPICS_ENABLED=true DATABASE_URL=... uv run python -m pipeline.cli experiment loop-01-baseline --out docs/eval
```

- Config knobs ride as env vars on the command (they map 1:1 to `pipeline/config.py`): `NEAR_DUP_THRESHOLD`, `CLUSTER_JOIN_THRESHOLD`, `STORYLINE_SIM_FLOOR`, `AMBIENT_EMA_CEILING`, `EPISODE_DORMANCY_HOURS`, `DEDUPE_WINDOW_HOURS`, `THEME_SIM_FLOOR`, `THEME_STICK_FLOOR`, `THEME_KNN_K`, `TAU_SECONDS`, plus model/version keys.
- Real (non-stub) runs call Workers AI; the response cache makes replays cheap — only decisions that actually change hit the API. Never pass `--stub` in this loop: stub embeddings make every quality vector meaningless.

## Safety rails

1. **Local DB only, reads + pipeline CLI only.** Never write SQL directly; the CLI owns all mutation. Never touch the hosted database.
2. **Shared bench warning:** artifact counts have been observed changing between queries minutes apart — other sessions use this bench. Before starting, record the newest `experiment_runs` row; if a run you didn't start appears mid-loop, stop and tell the user. Do not run two experiments concurrently.
3. **One change per iteration.** Config knob or code change, never both, never two knobs. Otherwise attribution dies.
4. **Cost tiers — stay in tier 1–2 unless the user opts in:**
   - Tier 1 (free replay): threshold/knob env changes → `experiment`. Cached LLM calls replay; only changed decisions cost.
   - Tier 2 (free, no LLM): `pipeline/extraction.py` changes → bump `EXTRACTOR_VERSION`, run `reextract`, then `experiment`.
   - Tier 3 (moderate LLM cost): prompt changes (`pipeline/prompts.py`) → bump `PROMPT_VERSION`; affected calls miss cache.
   - Tier 4 (expensive, **user opt-in required**): `EMBEDDING_MODEL` / `ENRICHMENT_ENABLED` changes → `reset --features` + `prepare` re-embeds the full corpus (~9.6k entries).
5. **Code-change discipline:** pure functions stay pure and versioned (bump `EXTRACTOR_VERSION` / `PROMPT_VERSION` when behavior changes); `uv run pytest` green before any experiment uses changed code; commit each kept iteration (`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`); revert abandoned code changes cleanly via git.
6. **Budget:** max 10 iterations, then report regardless of state.

## The five evaluation vectors

Run the full crawl after every experiment. Verdict CSVs land in `docs/eval/loop/<iteration>/`; judging rules for V1–V2 (same-story-vs-same-topic calibration, entity gate, intruder test, reason discipline) are in the coherence-report plan — follow them exactly.

### V1 — Storyline chain coherence
Multi-episode storylines: per-episode `belongs y/n` + per-chain `coherent|has_intruders|should_split`. **Metrics:** chain purity (non-anchor `y` rate), per-`attach_method` join precision, broken-chain rate.

### V2 — Theme membership coherence
Per (theme, storyline): `fits y/n`; deterministic entity gate (entity-named theme → every member's `entity_set`/headline mentions it — hard rule); 10-theme intruder test for judge self-validation. **Metrics:** theme purity (overall and by `theme_attach_method`), entity-consistency rate, intruder detection rate.

### V3 — Category correctness (new)
Themes carry `category_id` into the seeded 23-category taxonomy (`topic_categories`; classifier may add `origin='llm'` rows).

Pull:
```sql
select t.id as theme_id, t.display_name, tc.display_name as category, tc.origin,
       t.storyline_count,
       array_agg(coalesce(c.headline, '(no card)') order by s.newest_entry_at desc) as member_headlines
from public.topic_themes t
left join public.topic_categories tc on tc.id = t.category_id
join public.storylines s on s.theme_id = t.id and s.merged_into is null
left join public.event_cards c on c.id = s.latest_card_id
where t.merged_into is null
group by t.id, t.display_name, tc.display_name, tc.origin, t.storyline_count
order by t.id;
```
Judge per theme against the full taxonomy (query `topic_categories` live, present all names): is the filed category the best fit? Verdicts to `category-verdicts.csv` (`theme_id,theme_name,filed_category,verdict,suggested_category,reason`); `verdict ∈ correct|wrong|ambiguous` (ambiguous = two categories genuinely defensible — counts as correct for the metric, but list them). Audit every `origin='llm'` category: was proposing a new category justified, or does a seed category cover it? **Metrics:** category accuracy = correct+ambiguous / themes-with-category; uncategorized rate (`category_id is null`); unjustified-llm-category count.

### V4 — Theme granularity (new)
Is the theme layer sliced at the right altitude? Both failure directions:

**Fragmentation (too many themes).** Candidate duplicate pairs = theme pairs with centroid cosine ≥ 0.75 (decode `topic_themes.centroid` with `pipeline.vectors.unpack_fp16`, cosine via `pipeline.vectors.cosine`) **or** same category + shared distinctive display-name token. Judge each candidate: should these merge? `granularity-merge-verdicts.csv` (`theme_a,theme_b,name_a,name_b,cosine,should_merge,reason`).

**Over-breadth (too few).** For themes with ≥ 8 members or V2 purity < 0.7: judge "is this one theme or several?" — if several, name the split. `granularity-split-verdicts.csv` (`theme_id,theme_name,should_split,proposed_split,reason`).

**Structural stats (free):** singleton-theme rate, members-per-theme histogram, themes-per-category distribution. Baseline observation to beat: 26/30 themes were singletons on the pre-loop bench state — likely over-fragmented for a 115-storyline corpus.

**Metrics:** should-merge pair count, should-split count, singleton-theme rate (directional: falling is good until theme purity starts paying for it — always read V4 jointly with V2).

### V5 — Entity extraction validity (new)
Entities anchor episode joins, theme entity gates, and ambient-entity vetoes — noise here poisons everything upstream of it.

**Deterministic sweep (free):** top 50 rows of `entity_stats` by `total_count`. Flag generic/junk tokens. Known bad signals already observed on the bench: `available`, `fourth`, `host`, `america`, `washington`, `financial` — generic words leaking through the lexicons. Also verify no token in `entity_set`s violates the extraction lexicons (a leak = bug, not tuning).

**Judged sample:** 100 entries, seed 42, stratified across agencies:
```sql
select id, title, summary, entity_set, event_keys, agency() ...
-- use: select ne.id, ne.title, ne.summary, ne.entity_set, ne.event_keys,
--             split_part(ns.canonical_url, '/', 3) as agency
--      from public.news_entries ne join public.news_sources ns on ns.id = ne.news_source_id
--      where ne.entity_set is not null order by ne.id;
-- then stratify/sample in python with random.Random(42)
```
Per entry judge: (a) each `entity_set` token — salient discriminator for *this* story, `y/n`? (b) up to 2 salient entities the extractor missed; (c) each `event_key` — real identifier or regex artifact? `entity-verdicts.csv` (`entry_id,token,kind,valid,reason`) + `entity-misses.csv` (`entry_id,missed_entity`).

**Metrics:** entity precision (valid tokens / judged tokens), mean missed-per-entry, event-key validity rate, junk-token list (this list feeds the lexicon fix directly).

## Scorecard and targets

After each crawl, append one row to `docs/eval/loop/scorecard.csv`:

```
iteration,run_id,config_delta,chain_purity,chains_n,method_precision_worst,theme_purity,entity_consistency,intruder_detection,category_accuracy,singleton_theme_rate,should_merge_pairs,should_split,entity_precision,entity_missed_mean,notes
```

Targets (report `n` alongside every rate — with ~3 multi-episode chains, purity moves in huge quanta; never claim significance the sample can't support):

| Vector | Metric | Target |
|---|---|---|
| V1 | chain purity | ≥ 0.90 |
| V1 | worst attach-method precision | ≥ 0.75 |
| V2 | theme purity | ≥ 0.85 |
| V2 | entity-consistency rate | 1.00 (hard rule) |
| V2 | intruder detection | ≥ 7/10, else purity numbers are flagged weak |
| V3 | category accuracy | ≥ 0.90 |
| V4 | judged should-merge pairs | 0 outstanding |
| V4 | singleton-theme rate | directional ↓ from 0.87 without V2 purity loss |
| V5 | entity precision | ≥ 0.80 |
| V5 | event-key validity | ≥ 0.95 |

## Tuning playbook (vector → lever, cheapest first)

- **V1 low / method leaking:** `centroid_join` leaking → raise `CLUSTER_JOIN_THRESHOLD`; storyline joins leaking → raise `STORYLINE_SIM_FLOOR`; joins riding on ubiquitous entities → lower `AMBIENT_EMA_CEILING`; `event_key` leaking → the key regexes in `pipeline/extraction.py` are too loose (tier 2). Chains failing to form at all (multi-episode count falling) → thresholds too strict; back off.
- **V2 low:** raise `THEME_SIM_FLOOR` (stricter membership) or `THEME_STICK_FLOOR`; adjust `THEME_KNN_K` (small k = noisy votes, big k = mushy votes); adjudicator/naming prompt in `pipeline/prompts.py` (tier 3). Entity-gate violations specifically → adjudicator prompt or theme naming, not thresholds.
- **V3 low:** classifier prompt (tier 3); present the taxonomy more explicitly. Unjustified llm-origin categories → tighten the proposal criteria in the prompt.
- **V4 fragmented:** lower `THEME_SIM_FLOOR` cautiously (watch V2), raise `THEME_KNN_K`; duplicate themes surviving → the merge path (`merge_topic_theme` adjudication) is under-firing — implementation lever in `pipeline/topics.py` (tier 2–3). V4 over-broad: opposite direction.
- **V5 low precision:** extend `_BOILERPLATE_LEXICON` / `_COMMON_ENGLISH` in `pipeline/extraction.py` with the junk-token list, tighten `_CAP_SPAN` handling; misses → widen capture patterns. Always tier 2: bump `EXTRACTOR_VERSION`, `uv run pytest tests/test_extraction.py`, `reextract`, then `experiment`. Note: entity fixes can shift V1/V2 (entities feed joins and gates) — expect cross-vector movement and re-judge everything.

## Loop protocol

**Iteration 0 — baseline.** Confirm bench idle (safety rail 2). Run:
```bash
TOPICS_ENABLED=true DATABASE_URL=... uv run python -m pipeline.cli experiment loop-00-baseline --out docs/eval
```
Full five-vector crawl → scorecard row → journal entry. This is the reference row; nothing is tuned yet.

**Each subsequent iteration:**
1. Read the scorecard. Pick the worst vector relative to target (tie-break: V5 first — it feeds the others — then V1, V2, V4, V3).
2. Write the hypothesis in `docs/eval/loop/journal.md` **before** changing anything: `iteration, vector targeted, change (exact env key/value or file+diff summary), expected effect, cost tier`.
3. Apply exactly one change. Tier 2+ code changes: tests green first.
4. Run `experiment loop-NN-<slug>` (name encodes the change, e.g. `loop-03-join-0.82`).
5. Re-crawl all five vectors fresh (corpus is small; do not carry verdicts over — artifact IDs change every replay). Judge from artifact content only; do not consult previous verdicts while judging, only when comparing after.
6. Compare against best-so-far row: targeted metric moved as hypothesized? Any other vector regressed past its target? **Keep** (commit if code) or **revert** (unset env / git revert). Record decision + numbers in the journal.
7. Stop when: all targets met → final verification; or 10 iterations spent; or the focused vector fails to improve 2 iterations running (move to next-worst vector; if none left, stop).

**Final verification (verify skill mindset — exercise, don't assume):**
1. Fresh run of the winning configuration under a clean name (`loop-final`), full crawl, confirm scorecard reproduces within noise.
2. `uv run pytest` green; `pnpm --filter @dot-gov-news/operator-console test` green if anything console-adjacent moved.
3. If winning config differs from `pipeline/config.py` defaults: propose the default change as a diff in the final report — do not silently change defaults without the user seeing the evidence table.
4. Write `docs/eval/loop/final-report.md`: verdict up front (what improved, from→to, at what cost), scorecard table across all iterations, per-vector before/after, the journal's kept/reverted ledger, remaining gaps with the levers you'd pull next, and honest caveats (sample sizes, judge self-consistency, anything the intruder test flagged).

## Deliverables checklist

- `docs/eval/loop/scorecard.csv` — one row per iteration incl. baseline and final.
- `docs/eval/loop/journal.md` — hypothesis-before, decision-after, every iteration.
- `docs/eval/loop/<iteration>/*.csv` — verdict files per crawl (chain, theme, category, granularity ×2, entity ×2, intruder).
- `docs/eval/loop/final-report.md` — as specified above.
- Committed code changes for every kept tier-2+ iteration; clean tree otherwise.
- Final message to user: verdict-first summary, config recommendation, report path.
