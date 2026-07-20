# Artifact Coherence Report — Agent Crawl Plan

> **For the executing agent:** You are the LLM judge. This plan tells you how to crawl the clustering artifacts in the local bench database, judge them on two coherence vectors, and write a report. You do not build or modify any code, and you never write to the database. Follow the steps in order; every verdict you issue must carry a reason.

**Goal:** Produce `docs/eval/artifact-coherence-<YYYY-MM-DD>.md` (plus verdict CSVs) measuring:

1. **Storyline chain coherence** — for every multi-episode storyline, are the member episodes truly developments of one evolving real-world story?
2. **Theme coherence** — for every topic theme, do the member storylines belong together? If the theme names a specific entity, every member storyline must mention that entity.

These layers are built by embeddings + LLM adjudicators, so this report is the independent check on them.

## Environment and guardrails

- Local Supabase Postgres runs on port **57422** (not the pipeline default 54322).
- `DATABASE_URL` is never in `.env`. Export it per command.
- `psql` is not installed on this machine. Run every query through the pipeline's own Db helper (verified working):

```bash
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:57422/postgres' uv run python - <<'EOF'
from pipeline.db import Db
import os
db = Db(os.environ["DATABASE_URL"])
print(db.all("select 1 as ok"))   # .all(sql) -> list[dict]; .one(sql) -> dict | None
EOF
```

For the crawl itself, prefer one script that runs all queries and dumps JSON to a scratch file, then judge from that file — fewer round trips than a query per artifact.

- **Read-only.** Use only `select` statements. Never call RPCs, never `update/insert/delete`, never reset anything. The bench database holds the live corpus and real experiment runs.
- The clustering tables hold the state of the **latest** experiment run. Record which run that is (Step 0) so the report is attributable.
- Deterministic ordering everywhere (`order by id`) so a re-run judges the same artifacts in the same order.

## Sampling caps

Judge exhaustively when small; sample honestly when large:

- Multi-episode storylines: judge **all** if ≤ 150; otherwise the 150 with the highest `episode_count` plus a random 50 of the rest (seed 42), and say so in the report.
- Themes: judge **all** themes with `storyline_count >= 2` if ≤ 100; otherwise the 100 largest plus a random 30 (seed 42).
- Per theme, if `storyline_count > 40`, judge the 40 newest members and note truncation.

Any cap that fires must be stated in the report's Coverage section — never let a sample read as a census.

## Step 0 — Inventory and attribution

```sql
select
  (select count(*) from public.storylines where merged_into is null) as storylines,
  (select count(*) from public.storylines where merged_into is null and episode_count >= 2) as multi_episode,
  (select count(*) from public.topic_themes where merged_into is null) as themes,
  (select count(*) from public.topic_themes where merged_into is null and storyline_count >= 2) as multi_storyline_themes,
  (select count(*) from public.news_entries) as entries;

select id, name, finished_at from public.experiment_runs
order by finished_at desc limit 1;
```

Abort with a clear message if `multi_episode` is 0 or the clustering tables are empty — there is nothing to judge, do not fabricate a report.

## Step 1 — Storyline chain coherence

### 1a. Pull the chains

```sql
select s.id as storyline_id,
       coalesce(oc.headline, '(no overview card)') as storyline_headline,
       s.episode_count, s.entry_count,
       e.id as episode_id,
       e.attach_method, e.attach_similarity, e.attach_reason,
       e.first_entry_at, e.newest_entry_at, e.entry_count as episode_entries,
       coalesce(ec.headline, '(no episode card)') as episode_headline,
       coalesce(ec.summary, '') as episode_summary
from public.storylines s
left join public.event_cards oc on oc.id = s.latest_card_id
join public.episodes e on e.storyline_id = s.id
left join public.event_cards ec
       on ec.episode_id = e.id and ec.kind = 'episode' and ec.superseded_by is null
where s.merged_into is null and s.episode_count >= 2
order by s.id, e.first_entry_at;
```

If an episode has no card (open/unflushed episodes), supplement with its top entry titles:

```sql
select ne.title, ne.published_at
from public.episode_entries ee
join public.news_entries ne on ne.id = ee.entry_id
where ee.episode_id = '<episode_id>'
order by ne.published_at limit 3;
```

### 1b. Judge each chain

For each storyline, read the episodes in date order and answer, per episode: **is this episode a development of the same underlying story as the rest of the chain?**

Calibration — the distinction that matters:

- **Same story** = one continuing real-world event or saga: a recall then its expansion; a rule proposed then finalized; a breach disclosed then patched then litigated. Episodes share the concrete referent (same recall, same docket, same incident), not just the subject area.
- **Same topic is NOT same story.** Two unrelated FDA drug recalls are the same topic but different stories — an episode like that is an intruder. Chains exist to reconstruct sagas, not to group categories; category-grouping is the theme layer's job.
- The first episode anchors the chain. Judge later episodes against the story the chain is telling, not merely against the immediately preceding episode.

Record one row per episode in `docs/eval/chain-verdicts.csv`:

```
storyline_id,episode_id,attach_method,attach_similarity,belongs,reason
<uuid>,<uuid>,event_key,0.82,y,"expansion of the same Valsatrex recall (shared recall number)"
<uuid>,<uuid>,centroid_join,0.79,n,"different drug entirely; topically similar but a separate recall"
```

`belongs` is `y`/`n`. Reasons ≤ 200 chars, concrete, naming the entity or referent that ties (or fails to tie) the episode in. First episode of each chain is the anchor: mark it `y` with reason `anchor` unless the chain is so incoherent no anchor exists (then judge the majority story as anchor).

Also record one row per storyline in `docs/eval/chain-summary.csv`:

```
storyline_id,episodes,verdict,note
<uuid>,4,coherent,
<uuid>,3,has_intruders,"episode 2 is a different recall"
<uuid>,5,should_split,"two interleaved stories: shutdown funding vs appropriations lawsuit"
```

`verdict` ∈ `coherent | has_intruders | should_split`.

## Step 2 — Theme coherence

### 2a. Pull themes and members

```sql
select t.id as theme_id, t.display_name, t.storyline_count,
       tc.display_name as category,
       s.id as storyline_id,
       coalesce(c.headline, '(no card)') as storyline_headline,
       s.theme_attach_method, s.theme_similarity, s.theme_reason,
       s.entity_set
from public.topic_themes t
left join public.topic_categories tc on tc.id = t.category_id
join public.storylines s on s.theme_id = t.id and s.merged_into is null
left join public.event_cards c on c.id = s.latest_card_id
where t.merged_into is null and t.storyline_count >= 2
order by t.id, s.newest_entry_at desc;
```

### 2b. Entity gate (deterministic — do this before any judgment)

For each theme, decide whether `display_name` names a **specific entity** — a proper noun that is a concrete organization, person, product, program, or place (e.g. "Valsatrex", "Boeing", "Colonial Pipeline"), as opposed to a generic subject ("Drug Recalls", "Border Security", "Interest Rates"). Agencies acting in their ordinary capacity (FDA, EPA) count as generic subject matter unless the theme is *about* the agency itself (e.g. "FDA Leadership Shakeup" → entity-specific on FDA leadership).

For every member of an entity-specific theme, check mechanically: does the entity (case-insensitive) appear in the storyline's `entity_set` **or** its card headline? Record violations in `docs/eval/theme-entity-violations.csv`:

```
theme_id,theme_name,entity,storyline_id,storyline_headline
```

This gate is a hard rule from the operator — a violation is a failure regardless of how plausible the grouping feels.

### 2c. Membership judgment

For each theme, read `display_name` + the member storyline headlines and judge per member: **does this storyline belong under this theme?** Here thematic grouping IS the right altitude (opposite of Step 1): members need to share the theme's subject, not a single referent. A member fails when a reader scanning the theme would be surprised to find it there.

Record one row per (theme, storyline) in `docs/eval/theme-verdicts.csv`:

```
theme_id,theme_name,storyline_id,theme_attach_method,fits,reason
```

### 2d. Intruder test (judge self-validation)

Pick 10 themes (largest first). For each, privately select one storyline from a *different* theme (random, seed 42), mix it into the member list, and — judging the mixed list fresh, without consulting which one you planted — identify the member least likely to belong. Score: did the planted intruder rank as the worst fit? Record in `docs/eval/intruder-test.csv` (`theme_id,planted_storyline_id,detected y/n`). Detection rate < 7/10 means membership verdicts in 2c are weak evidence — say so prominently in the report rather than presenting purity numbers as solid.

## Step 3 — Metric rollup

From the verdict CSVs compute:

**Chains**
- **Chain purity** = `y` episode verdicts (excluding anchors) / all non-anchor verdicts.
- **Per-attach-method join precision** — same ratio grouped by `attach_method`. This is the actionable table: it says which join mechanism (event_key / centroid_join / entity_candidate / adjudicated_join) is leaking.
- Broken-chain rate = storylines with verdict ≠ `coherent` / storylines judged.

**Themes**
- **Theme purity** = `fits=y` / all membership verdicts; also grouped by `theme_attach_method` (knn_join vs adjudicated_join vs new_theme).
- **Entity-consistency rate** = entity-specific themes with zero violations / entity-specific themes.
- Intruder detection rate (from 2d).

## Step 4 — Write the report

`docs/eval/artifact-coherence-<YYYY-MM-DD>.md`, sections in this order:

1. **Verdict up front** — 3–5 sentences: are chains and themes trustworthy, what is the single worst leak, what config knob or mechanism does the evidence implicate.
2. **Attribution** — latest experiment run (id, name, finished_at), corpus size, judge = this agent session (record model name), date.
3. **Coverage** — counts judged vs total per vector; every sampling cap that fired.
4. **Chain coherence** — purity, per-method precision table, broken-chain rate, then the 5 worst chains with their stories told plainly (headline, which episode intrudes, why).
5. **Theme coherence** — purity, per-method table, entity-gate results with every violation listed, intruder-test result, 5 worst themes.
6. **Recommendations** — ranked, each tied to a specific mechanism or config key (e.g. "centroid_join precision 0.68 → raise CLUSTER_JOIN_THRESHOLD or route borderline joins to the adjudicator"). No recommendation without a metric behind it.
7. **Appendix** — pointers to the four CSVs.

Style: plain prose, tables for the metric rollups, every claim traceable to a CSV row. Where a judgment was genuinely uncertain, the reason field should say so — do not launder uncertainty into confident verdicts.

## Done criteria

- All four/five CSVs written under `docs/eval/` with the exact columns above.
- Report file written, every section present, coverage honest.
- Zero database writes issued at any point.
- Final message: verdict-first summary + report path.
