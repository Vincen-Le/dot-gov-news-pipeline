# Topic Clustering — Design

Organize storylines under filterable topics: a small, mostly-stable **broad
category** level and an emergent **theme** level built incrementally from
storyline overview embeddings with LLM merge adjudication.

Validated in brainstorming 2026-07-18. Experiment-pipeline scope only: the
prod worker path is untouched until experiments validate thresholds.

## Decisions (from brainstorming)

- Two levels: broad category (~15-25, seed taxonomy + LLM-proposed additions)
  and theme (grows with news, embedding-clustered).
- Category origin is audited: `seed` vs `llm`, surfaced as a badge in the
  dashboard.
- Theme assignment happens at a storyline's first overview card and is
  re-checked on every overview refresh (drift handling with hysteresis).
- Overview cards are generated even for single-episode storylines, and the
  LLM compressor still runs for them (enrichment, not passthrough).
- Theme naming is folded into the join adjudication call — no separate
  naming calls.
- Lives in the experiment pipeline (`pipeline/` Python + bench db + lab
  dashboard), gated behind `topics_enabled` so old-style runs stay
  reproducible.

## Mechanism (chosen approach)

Incremental nearest-centroid + LLM adjudication — the same shape as
storyline attachment (`pipeline/storylines.py`), one level up:

1. Storyline gets an overview card → overview embedding is its centroid.
2. Load all theme centroids (brute force in memory; hundreds of themes ×
   fp16 is trivial — `pipeline/vectors.py` cosine).
3. Top 10 candidates above `theme_sim_floor`.
4. No candidates → spawn a theme deterministically (name from overview
   headline, centroid = storyline centroid). Zero LLM cost for outliers.
5. Candidates → one adjudicator call: storyline overview (headline +
   summary) vs candidates (name + top member headlines + similarity).
   Returns `{theme_id | null, updated_name?, reason}`. Null → spawn, with
   the LLM proposing the name in the same call.
6. On join: theme centroid = mean of member storyline centroids (recomputed
   from members, exact). `updated_name` applied if returned.

Rejected alternatives: nightly batch clustering (HDBSCAN/agglomerative) —
theme ids/names churn every rebuild, filters unstable; pure LLM
classification against the full theme list — no scale past ~100 themes, no
similarity audit trail.

## §1 Data model

New migration, same style as existing (RLS enabled, revoke-all,
service_role select grants, bounded check constraints):

**`topic_themes`**: `id` uuid pk, `display_name` text, `centroid` bytea
(fp16, mean of member storyline centroids), `category_id` uuid FK →
topic_categories (nullable), `storyline_count` int, `first_storyline_at` /
`newest_storyline_at` timestamptz, `merged_into` uuid self-FK (schema-ready
for future consolidation; unused for now), `name_model` text, `created_at`.

**`topic_categories`**: `id` uuid pk, `display_name` text, `origin` text
check in (`seed`, `llm`), `proposal_reason` text (null for seed rows),
`created_at`. Seed rows (~15-25) inserted by the migration; list approved
during planning.

**`storylines`** additions: `theme_id` uuid FK, `theme_attach_method` text
check in (`adjudicated_join`, `new_theme`, `reassigned`),
`theme_similarity` real, `theme_reason` text. Existing `topic` /
`cluster_topic` placeholder columns are left alone.

New write RPCs alongside the existing clustering write RPCs:
`upsert_theme`, `assign_theme` (storyline → theme + audit columns),
`insert_category`.

Every assign/reassign is audited — clustering QA stays plain SQL, same
philosophy as `episode_entries`.

## §2 Pipeline flow

**Change 1 — overview at birth (`pipeline/cards.py`).** Drop the
single-episode collapse (`< 2` early return): the first episode close also
runs `_regenerate_overview`, LLM compressor included. Every storyline has a
centroid from its first close. More compressor calls per run — visible in
cache stats, acceptable for experiments.

**Change 2 — new `pipeline/topics.py`, stage 4.** `ThemeEngine` mirrors
`StorylineEngine`; triggered in the runner after every overview card insert
(first-time and refresh). Steps as in Mechanism above.

**Change 3 — re-check on refresh (hysteresis).** Overview refresh → new
centroid → if cosine to own theme centroid ≥ `theme_stick_floor`, stay (no
LLM call). Below → full re-run of assignment,
`theme_attach_method = 'reassigned'`. The gap between `theme_sim_floor`
(join) and `theme_stick_floor` (stay) prevents flapping.

**Change 4 — category on theme spawn only.** New theme → one classifier
call: theme name + storyline overview vs category list (name + origin).
Returns an existing category or proposes a new one (`origin = 'llm'`,
`proposal_reason`). Themes are never re-categorized on rename; category is
sticky unless fixed manually.

**Config additions** (`pipeline/config.py`, env-overridable like the rest):
`topics_enabled` (default false), `theme_sim_floor` (start 0.55),
`theme_stick_floor` (start 0.50), `theme_namer_model` (defaults to the
adjudicator model).

LLM cost per storyline: ~1 adjudication at first overview + rare re-checks
+ 1 classification per new theme.

## §3 Lab dashboard + experiment report

Follows the patterns landed in fa017be (agency dropdown fed by an options
endpoint; every filter plumbed query layer → route → URL param → CLI flag;
pagination via over-fetch `hasMore`).

**Queries (`apps/operator-console/src/lab/queries.ts`).**
- `storylines()` filter gains `theme?` (theme id) and `category?` — same
  optional-fragment pattern, joined through `s.theme_id`. List rows gain
  `themeName`, `categoryName`.
- New `topicThemes()` (name, category, origin, storyline_count) and
  `topicCategories()` (name, origin) for dropdown options and list views.
- `storylineDetail()` gains a theme block: name, category,
  `theme_attach_method`, `theme_similarity`, `theme_reason`.

**Routes.** New GET `/api/lab/topics/themes` and
`/api/lab/topics/categories`; the storylines route accepts the new query
params. CLI gains matching `--theme` / `--category` flags (CLI parity house
rule).

**StorylinesPage.** Category + Theme dropdowns (picking a category narrows
theme options); theme chip on storyline rows; origin badge on categories
(`seed` plain, `llm` marked — auditability requirement). Composes with the
existing pagination and episode sort. No theme name history (YAGNI —
`name_model` records who named it; reasons live in the attach audit).

**Experiment report (`pipeline/experiment.py`).** `summarize()` gains a
topics section when enabled: theme count, category count (seed vs llm
split), storylines-per-theme distribution, top themes by storyline count,
theme attach mix (`adjudicated_join` / `new_theme` / `reassigned`),
reassignment rate. These numbers are how `theme_sim_floor` gets tuned
across runs.

## §4 Error handling + testing

**Error handling — LLM failure never blocks the run** (same doctrine as the
compressor fallback in `pipeline/cards.py`):

- Adjudicator failure during assignment → deterministic fallback: spawn a
  new theme named from the overview headline,
  `theme_reason = "adjudicator_error: <exc>"`. A storyline with an overview
  is never left themeless.
- Category classifier failure on spawn → `category_id = null`, retried the
  next time the theme is touched. Dashboard shows an "Uncategorized" option
  so nulls stay visible.
- Re-check failure → keep the current theme, log the reason; drift
  correction retries on the next refresh.
- Malformed LLM output → validated like `validate_timeline`: unknown
  theme_id treated as null (spawn); names truncated to column bounds.

**Testing (TDD, matching existing suites):**

- SQL: `topic_themes.test.sql` + tests for new storyline columns and write
  RPCs — constraints, RLS, grants (shape of
  `clustering_write_rpcs.test.sql`).
- pytest `test_topics.py` (fakes from `tests/fakes.py`): spawn-on-empty,
  join-on-yes, spawn-on-no, name update applied, hysteresis both sides,
  adjudicator-failure fallback, category propose-new vs match-seed.
- pytest `test_cards.py`: single-episode storyline now gets an overview
  card; compressor called with one episode card.
- pytest `test_experiment.py`: topics section present when enabled, absent
  when disabled.
- vitest: lab-queries integration (new filters + options endpoints),
  lab-routes (params + CLI parity), storylines-page (dropdowns, origin
  badge).

## Experiment workflow

No pipeline versioning — named runs with config embedded in every report:

```bash
TOPICS_ENABLED=1 uv run python -m pipeline.cli experiment topics-baseline
THEME_SIM_FLOOR=0.65 TOPICS_ENABLED=1 uv run python -m pipeline.cli experiment topics-simfloor-065
```

Convention: `topics-*` prefix for this track. Reports land in
`docs/eval/<name>/report.md` + `experiment_runs`; the lab runs/comparisons
page diffs runs side by side.

Mechanics:
- `reset_clusters` also wipes topic state: themes and llm-origin categories
  deleted; seed categories survive (migration data, not run output).
- `DecisionCache` wraps theme adjudications like every other decision —
  re-runs with unchanged prompts hit cache, so tuning floors only pays for
  decisions the new floor actually changes.

Feature-level verification: run `topics-baseline` on the bench db, eyeball
the themes list in the dashboard, sanity-check report metrics (theme count,
reassignment rate, singleton-theme rate).
