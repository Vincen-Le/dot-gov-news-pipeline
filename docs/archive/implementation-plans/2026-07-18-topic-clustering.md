# Topic Clustering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Organize storylines under filterable topics: seed+LLM broad categories and emergent embedding-clustered themes with LLM merge adjudication, in the experiment pipeline only.

**Architecture:** A new stage-4 `ThemeEngine` (mirroring `StorylineEngine`) assigns every storyline to a `topic_themes` row at its first overview card and re-checks on refresh with hysteresis. Theme naming folds into the join adjudication call. New themes get one category-classification call against a seed taxonomy the LLM may extend (`origin='llm'`, audited). Everything is gated behind `topics_enabled` (default false).

**Tech Stack:** Python (pipeline, pytest), Postgres/Supabase (pgTAP tests, SECURITY DEFINER RPCs), TypeScript (operator-console: postgres.js, express, zod, React, vitest).

**Spec:** `docs/archive/design-specs/2026-07-18-topic-clustering-design.md`

## Global Constraints

- `topics_enabled` defaults **false**; with it false, pipeline behavior must be byte-identical to today except overview-at-birth (Task 3, unconditional).
- Default thresholds: `theme_sim_floor = 0.55`, `theme_stick_floor = 0.50`.
- Theme display names ≤ 256 chars; category display names ≤ 128 chars; reasons ≤ 2048.
- LLM failure never blocks a run: adjudicator failure → spawn fallback; classifier failure → `category_id = null` (retried next touch).
- All table writes from Python go through SECURITY DEFINER RPCs (bench reset is the sanctioned direct-SQL exception).
- New tables: RLS enabled, revoke-all, `service_role` select only. New RPCs: revoke from public/anon/authenticated, grant execute to service_role.
- Every touched line traces to the spec; no drive-by refactors.
- Python: run tests with `uv run pytest`. Console: `pnpm --filter @dot-gov-news/operator-console test`.
- Commit after every task (steps below say when).

---

### Task 1: Migration — topic tables, storyline columns, RPCs, seed categories

**Files:**
- Create: `supabase/migrations/20260718100300_create_topic_clustering.sql`
- Test: `supabase/tests/database/topic_clustering.test.sql`

**Interfaces:**
- Produces tables `public.topic_categories`, `public.topic_themes`; columns `storylines.theme_id / theme_attach_method / theme_similarity / theme_reason`; RPCs `upsert_topic_category(text, text, text) -> uuid`, `create_topic_theme(text, bytea, uuid, text) -> uuid`, `update_topic_theme(uuid, text, bytea, uuid) -> void`, `assign_storyline_theme(uuid, uuid, text, real, text, bytea, text) -> void`. Tasks 4–7 consume all of these.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/database/topic_clustering.test.sql`:

```sql
begin;

select plan(14);

select has_table('public', 'topic_categories', 'topic_categories table exists');
select has_table('public', 'topic_themes', 'topic_themes table exists');
select has_column('public', 'storylines', 'theme_id', 'storylines gained theme_id');
select has_column('public', 'storylines', 'theme_attach_method',
    'storylines gained theme attach audit');

select is(
    (
        select count(*)::integer
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname in ('topic_categories', 'topic_themes')
          and pg_class.relrowsecurity
    ),
    2,
    'RLS enabled on both topic tables'
);

select ok(
    not has_table_privilege('anon', 'public.topic_categories', 'select')
    and not has_table_privilege('anon', 'public.topic_themes', 'select'),
    'anon cannot read topic tables'
);

select ok(
    (select count(*) from public.topic_categories where origin = 'seed') >= 15,
    'seed taxonomy is populated'
);

select throws_ok(
    $$insert into public.topic_categories (display_name, origin)
      values ('Bogus', 'invented')$$,
    '23514', null, 'origin outside seed/llm rejected'
);

-- RPC round-trip fixtures
select lives_ok(
    $$select public.upsert_topic_category('Test LLM Cat', 'llm', 'proposed by test')$$,
    'upsert_topic_category inserts'
);
select is(
    public.upsert_topic_category('Test LLM Cat', 'llm', 'dup call'),
    (select id from public.topic_categories where display_name = 'Test LLM Cat'),
    'upsert_topic_category is idempotent on display_name'
);

insert into public.storylines (id, first_entry_at, newest_entry_at)
values ('00000000-0000-0000-0000-0000000000a1', now() - interval '2 days', now());

select lives_ok(
    $$select public.create_topic_theme(
        'FDA drug recalls', decode('0011', 'hex'),
        (select id from public.topic_categories where display_name = 'Test LLM Cat'),
        'test-model')$$,
    'create_topic_theme inserts'
);

select lives_ok(
    $$select public.assign_storyline_theme(
        '00000000-0000-0000-0000-0000000000a1',
        (select id from public.topic_themes where display_name = 'FDA drug recalls'),
        'adjudicated_join', 0.81, 'same regulatory thread',
        decode('0012', 'hex'), 'FDA drug safety actions')$$,
    'assign_storyline_theme joins storyline and updates the theme'
);

select is(
    (select storyline_count from public.topic_themes
     where display_name = 'FDA drug safety actions'),
    1,
    'assign recomputes storyline_count and applies the rename'
);

select is(
    (select theme_attach_method from public.storylines
     where id = '00000000-0000-0000-0000-0000000000a1'),
    'adjudicated_join',
    'assign audits the attach method on the storyline'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run the SQL test to verify it fails**

Run: `supabase test db` (from repo root; local Supabase must be running)
Expected: FAIL — `topic_categories` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260718100300_create_topic_clustering.sql`:

```sql
begin;

create table public.topic_categories (
    id uuid primary key default gen_random_uuid(),
    display_name text not null,
    origin text not null,
    proposal_reason text,
    created_at timestamptz not null default now(),
    constraint topic_categories_display_name_bounded
        check (length(display_name) between 1 and 128),
    constraint topic_categories_origin_valid
        check (origin in ('seed', 'llm')),
    constraint topic_categories_proposal_reason_bounded
        check (proposal_reason is null or length(proposal_reason) <= 2048)
);

comment on table public.topic_categories is
    'Broad filter taxonomy. Seed rows ship in this migration; the classifier may propose additions (origin=llm, audited via proposal_reason and a dashboard badge).';

create unique index topic_categories_display_name_idx
    on public.topic_categories (lower(display_name));

create table public.topic_themes (
    id uuid primary key default gen_random_uuid(),
    display_name text not null,
    centroid bytea,
    category_id uuid references public.topic_categories(id),
    storyline_count integer not null default 0,
    first_storyline_at timestamptz,
    newest_storyline_at timestamptz,
    merged_into uuid references public.topic_themes(id),
    name_model text,
    created_at timestamptz not null default now(),
    constraint topic_themes_display_name_bounded
        check (length(display_name) between 1 and 256),
    constraint topic_themes_centroid_bounded
        check (centroid is null or octet_length(centroid) between 2 and 4096),
    constraint topic_themes_storyline_count_nonnegative
        check (storyline_count >= 0),
    constraint topic_themes_name_model_bounded
        check (name_model is null or length(name_model) <= 256)
);

comment on table public.topic_themes is
    'Mid-level emergent topics. Centroid = mean of member storyline centroids; display_name maintained by the join adjudicator. merged_into reserved for future consolidation.';

create index topic_themes_category_idx on public.topic_themes (category_id);

alter table public.storylines
    add column theme_id uuid references public.topic_themes(id),
    add column theme_attach_method text,
    add column theme_similarity real,
    add column theme_reason text,
    add constraint storylines_theme_attach_method_valid
        check (theme_attach_method is null or theme_attach_method in
            ('adjudicated_join', 'new_theme', 'reassigned')),
    add constraint storylines_theme_similarity_valid
        check (theme_similarity is null
            or (theme_similarity >= -1.0 and theme_similarity <= 1.0)),
    add constraint storylines_theme_reason_bounded
        check (theme_reason is null or length(theme_reason) <= 2048);

comment on column public.storylines.theme_id is
    'Current topic theme; audit trio theme_attach_method/theme_similarity/theme_reason records the decision in force, same philosophy as episode_entries.';

create index storylines_theme_idx on public.storylines (theme_id);

create or replace function public.upsert_topic_category(
    p_display_name text,
    p_origin text,
    p_proposal_reason text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_id uuid;
begin
    insert into public.topic_categories (display_name, origin, proposal_reason)
    values (p_display_name, p_origin, p_proposal_reason)
    on conflict (lower(display_name)) do nothing
    returning id into v_id;
    if v_id is null then
        select id into v_id from public.topic_categories
        where lower(display_name) = lower(p_display_name);
    end if;
    return v_id;
end
$fn$;

create or replace function public.create_topic_theme(
    p_display_name text,
    p_centroid bytea,
    p_category_id uuid,
    p_name_model text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_id uuid;
begin
    insert into public.topic_themes (display_name, centroid, category_id, name_model)
    values (left(p_display_name, 256), p_centroid, p_category_id, p_name_model)
    returning id into v_id;
    return v_id;
end
$fn$;

create or replace function public.update_topic_theme(
    p_theme_id uuid,
    p_display_name text,
    p_centroid bytea,
    p_category_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    update public.topic_themes set
        display_name = coalesce(left(p_display_name, 256), display_name),
        centroid = coalesce(p_centroid, centroid),
        category_id = coalesce(p_category_id, category_id)
    where id = p_theme_id;
end
$fn$;

create or replace function public.assign_storyline_theme(
    p_storyline_id uuid,
    p_theme_id uuid,
    p_method text,
    p_similarity real,
    p_reason text,
    p_theme_centroid bytea,
    p_theme_display_name text
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_old uuid;
begin
    select theme_id into v_old from public.storylines where id = p_storyline_id;

    update public.storylines set
        theme_id = p_theme_id,
        theme_attach_method = p_method,
        theme_similarity = p_similarity,
        theme_reason = left(p_reason, 2048)
    where id = p_storyline_id;

    -- recompute-from-source, same as attach_entry_to_episode: replays converge
    update public.topic_themes t set
        display_name = coalesce(left(p_theme_display_name, 256), t.display_name),
        centroid = coalesce(p_theme_centroid, t.centroid),
        storyline_count = (select count(*) from public.storylines s where s.theme_id = t.id),
        first_storyline_at = (select min(s.first_entry_at) from public.storylines s where s.theme_id = t.id),
        newest_storyline_at = (select max(s.newest_entry_at) from public.storylines s where s.theme_id = t.id)
    where t.id = p_theme_id;

    if v_old is not null and v_old <> p_theme_id then
        update public.topic_themes t set
            storyline_count = (select count(*) from public.storylines s where s.theme_id = t.id),
            first_storyline_at = (select min(s.first_entry_at) from public.storylines s where s.theme_id = t.id),
            newest_storyline_at = (select max(s.newest_entry_at) from public.storylines s where s.theme_id = t.id)
        where t.id = v_old;
    end if;
end
$fn$;

comment on function public.assign_storyline_theme is
    'Sole storyline->theme write path. Storyline carries the attach audit; both themes'' aggregates recompute from storylines rows. Optional rename/centroid piggyback on the join.';

alter table public.topic_categories enable row level security;
alter table public.topic_themes enable row level security;

revoke all privileges on table public.topic_categories
    from public, anon, authenticated, service_role;
revoke all privileges on table public.topic_themes
    from public, anon, authenticated, service_role;

grant select on table public.topic_categories, public.topic_themes
    to service_role;

do $grants$
declare
    v_sig text;
begin
    foreach v_sig in array array[
        'public.upsert_topic_category(text, text, text)',
        'public.create_topic_theme(text, bytea, uuid, text)',
        'public.update_topic_theme(uuid, text, bytea, uuid)',
        'public.assign_storyline_theme(uuid, uuid, text, real, text, bytea, text)'
    ] loop
        execute format('revoke execute on function %s from public, anon, authenticated', v_sig);
        execute format('grant execute on function %s to service_role', v_sig);
    end loop;
end
$grants$;

insert into public.topic_categories (display_name, origin) values
    ('Immigration & Border', 'seed'),
    ('Public Health', 'seed'),
    ('Food & Drug Safety', 'seed'),
    ('Defense & Military', 'seed'),
    ('Veterans Affairs', 'seed'),
    ('Justice & Law Enforcement', 'seed'),
    ('Courts & Legal Rulings', 'seed'),
    ('Economy & Labor', 'seed'),
    ('Taxes & Revenue', 'seed'),
    ('Financial Regulation', 'seed'),
    ('Energy & Environment', 'seed'),
    ('Transportation & Infrastructure', 'seed'),
    ('Education', 'seed'),
    ('Housing & Urban Development', 'seed'),
    ('Social Security & Benefits', 'seed'),
    ('Science & Space', 'seed'),
    ('Technology & Cybersecurity', 'seed'),
    ('Elections & Government Operations', 'seed'),
    ('Foreign Affairs & Trade', 'seed'),
    ('Disaster Response & Emergency', 'seed');

commit;
```

- [ ] **Step 4: Apply and run the SQL tests**

Run: `supabase db reset` (rebuilds bench db with all migrations — local only) then `supabase test db`
Expected: all pgTAP suites PASS including the new `topic_clustering` plan of 14.
Note: `supabase db reset` wipes the local corpus; re-sync afterwards is covered in Task 8.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260718100300_create_topic_clustering.sql supabase/tests/database/topic_clustering.test.sql
git commit -m "feat: add topic clustering schema, write RPCs, and seed taxonomy"
```

---

### Task 2: Model layer — config knobs, prompts, WorkersAI, stub, cache

**Files:**
- Modify: `pipeline/config.py`
- Modify: `pipeline/prompts.py`
- Modify: `pipeline/ai.py`
- Modify: `pipeline/stub.py`
- Modify: `pipeline/cache.py`
- Test: `tests/test_prompts.py`, `tests/test_stub.py`, `tests/test_cache.py`, `tests/test_config.py`

**Interfaces:**
- Produces `Config.topics_enabled/theme_sim_floor/theme_stick_floor`; `models.adjudicate_theme(storyline: dict, candidates: list[dict]) -> dict` returning `{"theme_id": str|None, "updated_name": str|None, "reason": str}`; `models.classify_category(theme_name: str, storyline: dict, categories: list[dict]) -> dict` returning `{"category_id": str|None, "new_category_name": str|None, "reason": str}`. Task 4's `ThemeEngine` consumes both; the engine treats a reason starting with `adjudicator_error`/`classifier_error` as a failed call.
- `storyline` dict shape (both methods): `{"headline": str, "summary": str}`. `candidates` items: `{"id": str, "display_name": str, "headlines": list[str], "similarity": float}`. `categories` items: `{"id": str, "display_name": str, "origin": str}`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_config.py`:

```python
def test_topics_config_defaults_off():
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t")
    assert cfg.topics_enabled is False
    assert cfg.theme_sim_floor == 0.55
    assert cfg.theme_stick_floor == 0.50
```

(If the file constructs `Config` differently, mirror its existing construction helper.)

Append to `tests/test_prompts.py`:

```python
from pipeline.prompts import build_category_prompt, build_theme_adjudicator_prompt


def test_theme_adjudicator_prompt_lists_candidates_with_ids():
    system, user = build_theme_adjudicator_prompt(
        {"headline": "FDA recalls Valsatrex", "summary": "Contamination."},
        [{"id": "t-1", "display_name": "FDA drug recalls",
          "headlines": ["FDA recalls Xarnib"], "similarity": 0.71}])
    assert "theme_id" in system and "updated_name" in system
    assert "t-1" in user and "FDA drug recalls" in user and "0.71" in user


def test_category_prompt_lists_categories_with_origin():
    system, user = build_category_prompt(
        "FDA drug recalls",
        {"headline": "FDA recalls Valsatrex", "summary": "Contamination."},
        [{"id": "c-1", "display_name": "Food & Drug Safety", "origin": "seed"}])
    assert "category_id" in system and "new_category_name" in system
    assert "c-1" in user and "Food & Drug Safety" in user
```

Append to `tests/test_stub.py`:

```python
def test_stub_adjudicate_theme_joins_on_shared_token():
    result = StubModels().adjudicate_theme(
        {"headline": "FDA recalls Valsatrex", "summary": ""},
        [{"id": "t-1", "display_name": "FDA recalls",
          "headlines": ["FDA recalls Xarnib"], "similarity": 0.7}])
    assert result["theme_id"] == "t-1"
    assert result["reason"].startswith("stub")


def test_stub_adjudicate_theme_spawns_on_disjoint_tokens():
    result = StubModels().adjudicate_theme(
        {"headline": "SSA field office closures", "summary": ""},
        [{"id": "t-1", "display_name": "FDA recalls",
          "headlines": ["FDA recalls Xarnib"], "similarity": 0.7}])
    assert result["theme_id"] is None
    assert result["updated_name"] == "SSA field office closures"


def test_stub_classify_category_matches_token_else_none():
    hit = StubModels().classify_category(
        "FDA drug recalls", {"headline": "FDA recalls Valsatrex", "summary": ""},
        [{"id": "c-1", "display_name": "Drug Safety", "origin": "seed"}])
    assert hit["category_id"] == "c-1"
    miss = StubModels().classify_category(
        "SSA closures", {"headline": "SSA field office closures", "summary": ""},
        [{"id": "c-1", "display_name": "Drug Safety", "origin": "seed"}])
    assert miss["category_id"] is None
    assert miss["new_category_name"] == "General Government"
```

Append to `tests/test_cache.py` (reuse the file's existing temp-path fixture pattern for the `DecisionCache` path):

```python
def test_cached_models_memoizes_theme_adjudication(tmp_path):
    class CountingModels(StubModels):
        calls = 0
        def adjudicate_theme(self, storyline, candidates):
            CountingModels.calls += 1
            return super().adjudicate_theme(storyline, candidates)

    cache = DecisionCache(str(tmp_path / "d.sqlite"))
    models = CachedModels(CountingModels(), cache, "tag")
    args = ({"headline": "FDA recalls Valsatrex", "summary": ""},
            [{"id": "t-1", "display_name": "FDA recalls",
              "headlines": [], "similarity": 0.7}])
    first = models.adjudicate_theme(*args)
    second = models.adjudicate_theme(*args)
    assert first == second
    assert CountingModels.calls == 1
    assert models.hits == 1


def test_cached_models_never_caches_theme_errors(tmp_path):
    class FailingModels(StubModels):
        calls = 0
        def adjudicate_theme(self, storyline, candidates):
            FailingModels.calls += 1
            return {"theme_id": None, "updated_name": None,
                    "reason": "adjudicator_error: boom"}

    cache = DecisionCache(str(tmp_path / "d.sqlite"))
    models = CachedModels(FailingModels(), cache, "tag")
    models.adjudicate_theme({"headline": "x", "summary": ""}, [])
    models.adjudicate_theme({"headline": "x", "summary": ""}, [])
    assert FailingModels.calls == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_config.py tests/test_prompts.py tests/test_stub.py tests/test_cache.py -v`
Expected: new tests FAIL (`AttributeError` / `ImportError`); existing tests still PASS.

- [ ] **Step 3: Implement config knobs**

In `pipeline/config.py`, add to the dataclass after `tau_seconds`:

```python
    topics_enabled: bool = False
    theme_sim_floor: float = 0.55
    theme_stick_floor: float = 0.50
```

and to `load_config()` after the `tau_seconds` line:

```python
        topics_enabled=_b("TOPICS_ENABLED", Config.topics_enabled),
        theme_sim_floor=_f("THEME_SIM_FLOOR", Config.theme_sim_floor),
        theme_stick_floor=_f("THEME_STICK_FLOOR", Config.theme_stick_floor),
```

- [ ] **Step 4: Implement prompts**

Append to `pipeline/prompts.py`:

```python
THEME_ADJUDICATOR_SYSTEM = (
    "You organize US government news storylines into ongoing topic themes. "
    "Given one storyline and candidate themes, decide whether the storyline "
    "belongs to one of them. Join only when the storyline covers the same "
    "ongoing topic; when uncertain, do not join. "
    'Respond with JSON only: {"theme_id": string or null (copy verbatim from '
    'the candidates, null = none fit), "updated_name": string or null (a '
    "better display name — for a joined theme whose name should broaden, or "
    "a proposed name for a new theme when theme_id is null), "
    '"reason": "one sentence"}'
)

CATEGORY_CLASSIFIER_SYSTEM = (
    "You classify a US government news theme into one broad category. "
    "Prefer an existing category; propose a new one only when nothing fits. "
    'Respond with JSON only: {"category_id": string or null (copy verbatim), '
    '"new_category_name": string or null (only when category_id is null), '
    '"reason": "one sentence"}'
)


def build_theme_adjudicator_prompt(storyline: dict, candidates: list[dict]) -> tuple[str, str]:
    shaped = [
        {"theme_id": c["id"], "name": c["display_name"],
         "similarity": round(float(c["similarity"]), 2),
         "sample_headlines": c["headlines"][:5]}
        for c in candidates
    ]
    user = (
        f"Storyline headline: {storyline['headline']}\n"
        f"Storyline summary: {storyline.get('summary') or '(none)'}\n\n"
        "Candidate themes (closest first):\n" + json.dumps(shaped, indent=2)
    )
    return THEME_ADJUDICATOR_SYSTEM, user


def build_category_prompt(theme_name: str, storyline: dict,
                          categories: list[dict]) -> tuple[str, str]:
    shaped = [
        {"category_id": c["id"], "name": c["display_name"], "origin": c["origin"]}
        for c in categories
    ]
    user = (
        f"Theme: {theme_name}\n"
        f"Example storyline: {storyline['headline']} — "
        f"{storyline.get('summary') or '(none)'}\n\n"
        "Categories:\n" + json.dumps(shaped, indent=2)
    )
    return CATEGORY_CLASSIFIER_SYSTEM, user
```

- [ ] **Step 5: Implement WorkersAI methods**

Append to `pipeline/ai.py` (inside `WorkersAI`; add `build_category_prompt, build_theme_adjudicator_prompt` to the `pipeline.prompts` import):

```python
    def adjudicate_theme(self, storyline: dict, candidates: list[dict]) -> dict:
        system, user = build_theme_adjudicator_prompt(storyline, candidates)
        try:
            parsed = _extract_json(self._chat(self.cfg.adjudicator_model, system, user))
            theme_id = parsed.get("theme_id")
            updated = parsed.get("updated_name")
            return {
                "theme_id": str(theme_id) if theme_id else None,
                "updated_name": str(updated) if updated else None,
                "reason": str(parsed.get("reason", "")),
            }
        except Exception as exc:  # engine spawns a new theme on failure
            return {"theme_id": None, "updated_name": None,
                    "reason": f"adjudicator_error: {exc}"}

    def classify_category(self, theme_name: str, storyline: dict,
                          categories: list[dict]) -> dict:
        system, user = build_category_prompt(theme_name, storyline, categories)
        try:
            parsed = _extract_json(self._chat(self.cfg.adjudicator_model, system, user))
            category_id = parsed.get("category_id")
            proposed = parsed.get("new_category_name")
            return {
                "category_id": str(category_id) if category_id else None,
                "new_category_name": str(proposed) if proposed else None,
                "reason": str(parsed.get("reason", "")),
            }
        except Exception as exc:  # engine leaves category null on failure
            return {"category_id": None, "new_category_name": None,
                    "reason": f"classifier_error: {exc}"}
```

- [ ] **Step 6: Implement stub methods**

Append to `pipeline/stub.py` (inside `StubModels`; add module helper `_tokens` above the class):

```python
def _tokens(text: str) -> set[str]:
    return {t.strip(".,;:!?()'\"").casefold()
            for t in text.split() if len(t.strip(".,;:!?()'\"")) >= 4}
```

```python
    def adjudicate_theme(self, storyline: dict, candidates: list[dict]) -> dict:
        mine = _tokens(storyline["headline"])
        for cand in candidates:
            theirs = _tokens(cand["display_name"] + " " + " ".join(cand["headlines"]))
            overlap = mine & theirs
            if overlap:
                return {"theme_id": cand["id"], "updated_name": None,
                        "reason": f"stub: shared tokens {sorted(overlap)}"}
        return {"theme_id": None,
                "updated_name": storyline["headline"][:256],
                "reason": "stub: no candidate shares tokens"}

    def classify_category(self, theme_name: str, storyline: dict,
                          categories: list[dict]) -> dict:
        mine = _tokens(theme_name + " " + storyline["headline"])
        for cat in categories:
            if mine & _tokens(cat["display_name"]):
                return {"category_id": cat["id"], "new_category_name": None,
                        "reason": "stub: token match"}
        return {"category_id": None, "new_category_name": "General Government",
                "reason": "stub: no category token match"}
```

- [ ] **Step 7: Implement cache support**

In `pipeline/cache.py`:

Add to `DecisionCache.__init__` after the existing `create table`:

```python
        self.conn.execute(
            "create table if not exists json_decisions ("
            "key text primary key, payload text not null)")
        self.conn.commit()
```

Add methods to `DecisionCache`:

```python
    def get_json(self, key: str) -> dict | None:
        row = self.conn.execute(
            "select payload from json_decisions where key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def put_json(self, key: str, payload: dict) -> None:
        self.conn.execute(
            "insert or replace into json_decisions (key, payload) values (?, ?)",
            (key, json.dumps(payload, sort_keys=True)))
        self.conn.commit()
```

Add to `CachedModels` (below `adjudicate_same_event`):

```python
    def _memo_json(self, kind: str, parts: list, call) -> dict:
        key = hashlib.sha256(
            json.dumps([self.model_tag, kind, *parts], sort_keys=True, default=str)
            .encode()).hexdigest()
        cached = self.cache.get_json(key)
        if cached is not None:
            self.hits += 1
            return cached
        self.misses += 1
        result = call()
        reason = result.get("reason", "")
        if not reason.startswith(("adjudicator_error", "classifier_error")):
            self.cache.put_json(key, result)
        return result

    def adjudicate_theme(self, storyline: dict, candidates: list[dict]) -> dict:
        return self._memo_json("theme", [storyline, candidates],
                               lambda: self.inner.adjudicate_theme(storyline, candidates))

    def classify_category(self, theme_name: str, storyline: dict,
                          categories: list[dict]) -> dict:
        return self._memo_json(
            "category", [theme_name, storyline, categories],
            lambda: self.inner.classify_category(theme_name, storyline, categories))
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `uv run pytest tests/test_config.py tests/test_prompts.py tests/test_stub.py tests/test_cache.py -v`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add pipeline/config.py pipeline/prompts.py pipeline/ai.py pipeline/stub.py pipeline/cache.py tests/test_config.py tests/test_prompts.py tests/test_stub.py tests/test_cache.py
git commit -m "feat: add theme adjudication and category classification model layer"
```

---

### Task 3: Overview card at birth

**Files:**
- Modify: `pipeline/cards.py:40-44`
- Test: `tests/test_cards.py`

**Interfaces:**
- Consumes nothing new. Produces: every episode close now ends with a fresh overview card (LLM compressor runs even with one episode card), so `storylines.centroid` is set from the first close — Task 4's `ThemeEngine` relies on this.

- [ ] **Step 1: Update the failing test**

In `tests/test_cards.py`, replace `test_episode_card_written_at_close_single_episode_no_overview` with:

```python
def test_single_episode_close_also_writes_overview():
    store = CardFakeStore()  # episode_count param dies in Step 3's cleanup
    CardEngine(store, StubModels(), CFG).on_episode_closed(episode())
    kinds = [c["kind"] for c in store.cards]
    assert kinds == ["episode", "overview"]  # overview at birth: themes need a centroid
    overview = store.cards[1]
    assert overview["overview_embedding"] is not None
```

Also in this step: change `CardFakeStore.__init__` to `def __init__(self):` (drop the `episode_count` param and attribute) and delete its `storyline_episode_count` method; update the other tests' `CardFakeStore(episode_count=...)` constructions to `CardFakeStore()`.

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_cards.py -v`
Expected: new test FAILS (`kinds == ["episode"]`).

- [ ] **Step 3: Implement**

In `pipeline/cards.py`, delete these lines from `on_episode_closed`:

```python
        # single-episode collapse: only compress once a second episode exists
        if self.store.storyline_episode_count(str(episode["storyline_id"])) < 2:
            return
```

Then remove `storyline_episode_count` from `tests/test_cards.py::CardFakeStore` and the `episode_count` constructor param IF no other test uses it — the two clamp tests construct `CardFakeStore(episode_count=1)`; simplify all constructions to `CardFakeStore()` and drop the param. (Your change orphaned it; clean it up.) `Store.storyline_episode_count` in `pipeline/store.py` stays — do not remove pre-existing code that other callers may use; verify with `grep -rn storyline_episode_count pipeline apps` and remove it only if the grep shows the cards call was the sole consumer.

- [ ] **Step 4: Run the whole pytest suite**

Run: `uv run pytest`
Expected: PASS (the multi-episode overview tests already pass; single-episode path now also writes overviews).

- [ ] **Step 5: Commit**

```bash
git add pipeline/cards.py pipeline/store.py tests/test_cards.py
git commit -m "feat: generate overview cards for single-episode storylines"
```

---

### Task 4: Store surface + ThemeEngine

**Files:**
- Modify: `pipeline/store.py`
- Create: `pipeline/topics.py`
- Modify: `tests/fakes.py`
- Test: `tests/test_topics.py` (create)

**Interfaces:**
- Consumes: Task 1 RPCs, Task 2 model methods, `pipeline.vectors.cosine/pack_fp16/unpack_fp16`.
- Produces: `ThemeEngine(store, models, cfg)` with a single public method `sync(storyline_id: str) -> None`. Task 5 wires it into the runner.
- New `Store` methods (FakeStore mirrors them):
  - `all_themes() -> list[dict]` — `{id, display_name, centroid: np|None, category_id, storyline_count}`
  - `theme_headlines(theme_id: str, limit: int = 5) -> list[str]`
  - `theme_member_centroids(theme_id: str) -> list[np.ndarray]`
  - `storyline_theme_state(storyline_id: str) -> dict | None` — `{centroid: np|None, theme_id, headline, summary}` (headline/summary from the latest card)
  - `all_categories() -> list[dict]` — `{id, display_name, origin}`
  - `create_theme(display_name, centroid: bytes, category_id, name_model) -> str`
  - `assign_theme(storyline_id, theme_id, method, similarity, reason, theme_centroid: bytes|None, theme_display_name: str|None) -> None`
  - `update_theme(theme_id, display_name=None, centroid=None, category_id=None) -> None`
  - `upsert_category(display_name, origin, proposal_reason) -> str`

- [ ] **Step 1: Extend FakeStore**

Append to `tests/fakes.py` inside `FakeStore` (add `self.themes: dict[str, dict] = {}` and `self.categories: dict[str, dict] = {}` to `__init__`):

```python
    # -- topics ----------------------------------------------------------
    def all_themes(self):
        return [dict(t, centroid=unpack_fp16(t["centroid"]) if t["centroid"] is not None else None)
                for t in self.themes.values()]

    def theme_headlines(self, theme_id, limit=5):
        return [s.get("headline", "") for s in self.storylines.values()
                if s.get("theme_id") == theme_id][:limit]

    def theme_member_centroids(self, theme_id):
        return [unpack_fp16(s["centroid"]) for s in self.storylines.values()
                if s.get("theme_id") == theme_id and s.get("centroid") is not None]

    def storyline_theme_state(self, storyline_id):
        s = self.storylines.get(storyline_id)
        if s is None:
            return None
        return {"centroid": unpack_fp16(s["centroid"]) if s.get("centroid") is not None else None,
                "theme_id": s.get("theme_id"),
                "headline": s.get("headline", ""), "summary": s.get("summary", "")}

    def all_categories(self):
        return list(self.categories.values())

    def create_theme(self, display_name, centroid, category_id, name_model):
        theme_id = str(uuid.uuid4())
        self.themes[theme_id] = {"id": theme_id, "display_name": display_name,
                                 "centroid": centroid, "category_id": category_id,
                                 "storyline_count": 0}
        return theme_id

    def assign_theme(self, storyline_id, theme_id, method, similarity, reason,
                     theme_centroid, theme_display_name):
        s = self.storylines[storyline_id]
        s.update(theme_id=theme_id, theme_attach_method=method,
                 theme_similarity=similarity, theme_reason=reason)
        theme = self.themes[theme_id]
        if theme_display_name is not None:
            theme["display_name"] = theme_display_name
        if theme_centroid is not None:
            theme["centroid"] = theme_centroid
        for t in self.themes.values():
            t["storyline_count"] = sum(
                1 for x in self.storylines.values() if x.get("theme_id") == t["id"])

    def update_theme(self, theme_id, display_name=None, centroid=None, category_id=None):
        theme = self.themes[theme_id]
        if display_name is not None:
            theme["display_name"] = display_name
        if centroid is not None:
            theme["centroid"] = centroid
        if category_id is not None:
            theme["category_id"] = category_id

    def upsert_category(self, display_name, origin, proposal_reason):
        for cat in self.categories.values():
            if cat["display_name"].casefold() == display_name.casefold():
                return cat["id"]
        cat_id = str(uuid.uuid4())
        self.categories[cat_id] = {"id": cat_id, "display_name": display_name,
                                   "origin": origin}
        return cat_id
```

- [ ] **Step 2: Write the failing engine tests**

Create `tests/test_topics.py`:

```python
import numpy as np

from pipeline.config import Config
from pipeline.stub import StubModels
from pipeline.topics import ThemeEngine
from pipeline.vectors import pack_fp16
from tests.fakes import FakeStore

CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             topics_enabled=True)


def vec(*hot):
    v = np.zeros(8, dtype=np.float32)
    for i in hot:
        v[i] = 1.0
    return v


def add_storyline(store, headline, v, theme_id=None):
    sid = f"s-{len(store.storylines)}"
    store.storylines[sid] = {
        "id": sid, "entity_set": [], "event_keys": [], "episode_count": 1,
        "centroid": pack_fp16(v), "headline": headline, "summary": "",
        "theme_id": theme_id, "newest_entry_at": None,
    }
    return sid


def test_first_storyline_spawns_theme_named_from_headline():
    store = FakeStore()
    sid = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(sid)
    assert len(store.themes) == 1
    theme = next(iter(store.themes.values()))
    assert theme["display_name"] == "FDA recalls Valsatrex"
    assert store.storylines[sid]["theme_id"] == theme["id"]
    assert store.storylines[sid]["theme_attach_method"] == "new_theme"


def test_similar_storyline_joins_via_adjudicator():
    store = FakeStore()
    engine = ThemeEngine(store, StubModels(), CFG)
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    engine.sync(first)
    second = add_storyline(store, "FDA recalls expand to Xarnib", vec(0, 1, 2))
    engine.sync(second)
    assert len(store.themes) == 1  # stub joins on shared "recalls" token
    assert store.storylines[second]["theme_attach_method"] == "adjudicated_join"
    assert store.storylines[second]["theme_similarity"] is not None
    theme = next(iter(store.themes.values()))
    assert theme["storyline_count"] == 2


def test_dissimilar_storyline_below_floor_spawns_without_llm():
    class ExplodingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            raise AssertionError("no candidates above floor -> no LLM call")

    store = FakeStore()
    engine = ThemeEngine(store, ExplodingModels(), CFG)
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "SSA closes offices", vec(6, 7))  # orthogonal
    engine.sync(second)
    assert len(store.themes) == 2


def test_adjudicator_no_join_spawns_with_proposed_name():
    store = FakeStore()
    engine = ThemeEngine(store, StubModels(), CFG)
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    engine.sync(first)
    # similar vector (above floor) but disjoint tokens -> stub says no join
    second = add_storyline(store, "USDA beef contamination alert", vec(0, 1))
    engine.sync(second)
    assert len(store.themes) == 2
    names = {t["display_name"] for t in store.themes.values()}
    assert "USDA beef contamination alert" in names


def test_stick_floor_keeps_assignment_without_llm():
    class ExplodingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            raise AssertionError("above stick floor -> no re-adjudication")

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    # refresh with the same centroid: still fits its own theme
    ThemeEngine(store, ExplodingModels(), CFG).sync(first)
    assert store.storylines[first]["theme_attach_method"] == "new_theme"  # unchanged


def test_drift_below_stick_floor_reassigns():
    store = FakeStore()
    engine = ThemeEngine(store, StubModels(), CFG)
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    engine.sync(first)
    other = add_storyline(store, "SSA closes offices statewide", vec(6, 7))
    engine.sync(other)
    # storyline drifts fully onto the SSA vector and headline
    store.storylines[first]["centroid"] = pack_fp16(vec(6, 7))
    store.storylines[first]["headline"] = "SSA closes offices in Tulsa"
    engine.sync(first)
    assert store.storylines[first]["theme_id"] == store.storylines[other]["theme_id"]
    assert store.storylines[first]["theme_attach_method"] == "reassigned"


def test_adjudicator_failure_falls_back_to_spawn():
    class FailingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            return {"theme_id": None, "updated_name": None,
                    "reason": "adjudicator_error: boom"}

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "FDA recalls expand again", vec(0, 1))
    ThemeEngine(store, FailingModels(), CFG).sync(second)
    assert store.storylines[second]["theme_id"] is not None
    assert len(store.themes) == 2  # fallback spawned rather than joined
    assert store.storylines[second]["theme_reason"].startswith("adjudicator_error")


def test_new_theme_gets_category_seed_match_or_llm_proposal():
    store = FakeStore()
    store.categories["c-1"] = {"id": "c-1", "display_name": "Drug Safety",
                               "origin": "seed"}
    engine = ThemeEngine(store, StubModels(), CFG)
    drug = add_storyline(store, "FDA recalls Valsatrex drug", vec(0, 1))
    engine.sync(drug)
    theme = next(iter(store.themes.values()))
    assert theme["category_id"] == "c-1"
    ssa = add_storyline(store, "SSA closes offices", vec(6, 7))
    engine.sync(ssa)
    proposed = [c for c in store.categories.values() if c["origin"] == "llm"]
    assert [c["display_name"] for c in proposed] == ["General Government"]


def test_invalid_theme_id_from_llm_treated_as_spawn():
    class LyingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            return {"theme_id": "not-a-real-theme", "updated_name": None,
                    "reason": "hallucinated"}

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "FDA recalls expand", vec(0, 1))
    ThemeEngine(store, LyingModels(), CFG).sync(second)
    assert len(store.themes) == 2
    assert store.storylines[second]["theme_id"] != "not-a-real-theme"
```

- [ ] **Step 3: Run to verify failure**

Run: `uv run pytest tests/test_topics.py -v`
Expected: FAIL — `ModuleNotFoundError: pipeline.topics`.

- [ ] **Step 4: Implement Store methods**

Append to `pipeline/store.py` (uses existing imports plus `pack_fp16` — add it to the `pipeline.vectors` import):

```python
    # -- topics (stage 4) ----------------------------------------------
    def all_themes(self) -> list[dict]:
        rows = self.db.all(
            """
            select id, display_name, centroid, category_id, storyline_count
            from public.topic_themes where merged_into is null
            """
        )
        return [dict(r, centroid=unpack_fp16(r["centroid"]) if r["centroid"] is not None else None)
                for r in rows]

    def theme_headlines(self, theme_id: str, limit: int = 5) -> list[str]:
        rows = self.db.all(
            """
            select c.headline from public.storylines s
            join public.event_cards c on c.id = s.latest_card_id
            where s.theme_id = %(t)s
            order by s.newest_entry_at desc limit %(limit)s
            """,
            {"t": theme_id, "limit": limit},
        )
        return [r["headline"] for r in rows]

    def theme_member_centroids(self, theme_id: str) -> list:
        rows = self.db.all(
            "select centroid from public.storylines "
            "where theme_id = %(t)s and centroid is not null",
            {"t": theme_id},
        )
        return [unpack_fp16(r["centroid"]) for r in rows]

    def storyline_theme_state(self, storyline_id: str) -> dict | None:
        row = self.db.one(
            """
            select s.centroid, s.theme_id, c.headline, c.summary
            from public.storylines s
            left join public.event_cards c on c.id = s.latest_card_id
            where s.id = %(s)s
            """,
            {"s": storyline_id},
        )
        if row is None:
            return None
        return dict(row, centroid=unpack_fp16(row["centroid"])
                    if row["centroid"] is not None else None,
                    theme_id=str(row["theme_id"]) if row["theme_id"] else None)

    def all_categories(self) -> list[dict]:
        return [dict(r, id=str(r["id"]))
                for r in self.db.all(
                    "select id, display_name, origin from public.topic_categories")]

    def create_theme(self, display_name: str, centroid: bytes,
                     category_id: str | None, name_model: str | None) -> str:
        return str(self.db.rpc("create_topic_theme", p_display_name=display_name,
                               p_centroid=centroid, p_category_id=category_id,
                               p_name_model=name_model))

    def assign_theme(self, storyline_id: str, theme_id: str, method: str,
                     similarity: float | None, reason: str | None,
                     theme_centroid: bytes | None,
                     theme_display_name: str | None) -> None:
        self.db.rpc("assign_storyline_theme", p_storyline_id=storyline_id,
                    p_theme_id=theme_id, p_method=method,
                    p_similarity=Float4(similarity) if similarity is not None else None,
                    p_reason=reason, p_theme_centroid=theme_centroid,
                    p_theme_display_name=theme_display_name)

    def update_theme(self, theme_id: str, display_name: str | None = None,
                     centroid: bytes | None = None,
                     category_id: str | None = None) -> None:
        self.db.rpc("update_topic_theme", p_theme_id=theme_id,
                    p_display_name=display_name, p_centroid=centroid,
                    p_category_id=category_id)

    def upsert_category(self, display_name: str, origin: str,
                        proposal_reason: str | None) -> str:
        return str(self.db.rpc("upsert_topic_category", p_display_name=display_name,
                               p_origin=origin, p_proposal_reason=proposal_reason))
```

- [ ] **Step 5: Implement ThemeEngine**

Create `pipeline/topics.py`:

```python
"""Stage 4 — topic themes: incremental nearest-centroid over storyline
overview embeddings, LLM-adjudicated joins with naming folded into the same
call. Assignment at first overview, hysteresis re-check on refresh."""

from __future__ import annotations

import numpy as np

from pipeline.config import Config
from pipeline.vectors import cosine, pack_fp16

_TOP_K = 10
_MAX_NAME = 256


class ThemeEngine:
    def __init__(self, store, models, cfg: Config) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg

    def sync(self, storyline_id: str) -> None:
        state = self.store.storyline_theme_state(storyline_id)
        if state is None or state["centroid"] is None:
            return
        vec = state["centroid"]
        if state["theme_id"] is not None:
            theme = next((t for t in self.store.all_themes()
                          if str(t["id"]) == str(state["theme_id"])), None)
            if theme is not None and theme["centroid"] is not None \
                    and cosine(vec, theme["centroid"]) >= self.cfg.theme_stick_floor:
                return  # hysteresis: still fits, no LLM
            self._assign(storyline_id, state, vec, method="reassigned")
            return
        self._assign(storyline_id, state, vec, method=None)

    # -- assignment -----------------------------------------------------

    def _assign(self, storyline_id: str, state: dict, vec: np.ndarray,
                method: str | None) -> None:
        storyline = {"headline": state.get("headline") or "(no card)",
                     "summary": state.get("summary") or ""}
        scored = sorted(
            ((cosine(vec, t["centroid"]), t) for t in self.store.all_themes()
             if t["centroid"] is not None),
            key=lambda pair: -pair[0])
        candidates = [(sim, t) for sim, t in scored
                      if sim >= self.cfg.theme_sim_floor][:_TOP_K]

        if not candidates:
            self._spawn(storyline_id, storyline, vec,
                        name=storyline["headline"][:_MAX_NAME],
                        method=method or "new_theme",
                        similarity=None, reason="no theme above sim floor")
            return

        payload = [{"id": str(t["id"]), "display_name": t["display_name"],
                    "headlines": self.store.theme_headlines(str(t["id"])),
                    "similarity": sim}
                   for sim, t in candidates]
        verdict = self.models.adjudicate_theme(storyline, payload)
        by_id = {str(t["id"]): (sim, t) for sim, t in candidates}
        chosen = by_id.get(str(verdict.get("theme_id") or ""))

        if chosen is None:
            name = (verdict.get("updated_name") or storyline["headline"])[:_MAX_NAME]
            self._spawn(storyline_id, storyline, vec, name=name,
                        method=method or "new_theme",
                        similarity=candidates[0][0], reason=verdict["reason"])
            return

        sim, theme = chosen
        old_theme_id = state.get("theme_id")
        members = self.store.theme_member_centroids(str(theme["id"]))
        new_centroid = np.mean(members + [vec], axis=0) if members else vec
        rename = verdict.get("updated_name")
        self.store.assign_theme(
            storyline_id, str(theme["id"]),
            method="adjudicated_join" if method is None else method,
            similarity=sim, reason=verdict["reason"],
            theme_centroid=pack_fp16(new_centroid),
            theme_display_name=rename[:_MAX_NAME] if rename else None)
        if old_theme_id is not None and str(old_theme_id) != str(theme["id"]):
            self._refresh_centroid(str(old_theme_id))
        if theme.get("category_id") is None:
            self._classify(str(theme["id"]), theme["display_name"], storyline)

    def _spawn(self, storyline_id: str, storyline: dict, vec: np.ndarray,
               name: str, method: str, similarity: float | None,
               reason: str) -> None:
        theme_id = self.store.create_theme(
            name, pack_fp16(vec), category_id=None,
            name_model=getattr(self.cfg, "adjudicator_model", None))
        self.store.assign_theme(storyline_id, theme_id, method=method,
                                similarity=similarity, reason=reason,
                                theme_centroid=None, theme_display_name=None)
        self._classify(theme_id, name, storyline)

    def _refresh_centroid(self, theme_id: str) -> None:
        members = self.store.theme_member_centroids(theme_id)
        if members:
            self.store.update_theme(theme_id,
                                    centroid=pack_fp16(np.mean(members, axis=0)))

    def _classify(self, theme_id: str, theme_name: str, storyline: dict) -> None:
        categories = self.store.all_categories()
        verdict = self.models.classify_category(theme_name, storyline, categories)
        valid = {str(c["id"]) for c in categories}
        category_id = verdict.get("category_id")
        if category_id is not None and str(category_id) in valid:
            self.store.update_theme(theme_id, category_id=str(category_id))
            return
        proposed = verdict.get("new_category_name")
        if proposed:
            new_id = self.store.upsert_category(
                proposed[:128], "llm", verdict.get("reason"))
            self.store.update_theme(theme_id, category_id=new_id)
        # classifier failure / nothing proposed: category stays null,
        # retried the next time a join touches this theme
```

- [ ] **Step 6: Run to verify pass**

Run: `uv run pytest tests/test_topics.py -v`
Expected: PASS (all 9).

- [ ] **Step 7: Run the whole suite and commit**

Run: `uv run pytest`
Expected: PASS.

```bash
git add pipeline/topics.py pipeline/store.py tests/fakes.py tests/test_topics.py
git commit -m "feat: add stage-4 theme engine with store surface and fakes"
```

---

### Task 5: Runner wiring, bench reset, experiment report

**Files:**
- Modify: `pipeline/runner.py:77-110` (`cluster`)
- Modify: `pipeline/bench.py:31-41` (`reset_clusters`)
- Modify: `pipeline/experiment.py` (`summarize`, `render_report`)
- Test: `tests/test_cluster_phase.py`, `tests/test_bench.py`, `tests/test_experiment.py`

**Interfaces:**
- Consumes: `ThemeEngine.sync(storyline_id)` (Task 4), `cfg.topics_enabled` (Task 2).
- Produces: `summarize()` gains a `topics` key (dict, see Step 1) — the console's `ExperimentSummarySchema` is a `looseObject`, so no contract change needed.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_cluster_phase.py` (reuse the file's existing fixture helpers for corpus rows; the assertions are the new part):

```python
def test_cluster_with_topics_enabled_assigns_every_storyline_a_theme():
    store, models, cfg = make_harness(topics_enabled=True)  # mirror the file's harness builder
    run_cluster(store, models, cfg)
    themed = [s for s in store.storylines.values() if s.get("theme_id")]
    assert len(themed) == len(store.storylines)
    assert len(store.themes) >= 1


def test_cluster_with_topics_disabled_never_touches_themes():
    store, models, cfg = make_harness(topics_enabled=False)
    run_cluster(store, models, cfg)
    assert store.themes == {}
    assert all(s.get("theme_id") is None for s in store.storylines.values())
```

(`make_harness`/`run_cluster` stand for the file's existing setup + `cluster(...)` invocation pattern — follow the file's real names. FakeStore storylines gain `headline` lazily; runner tests use the card fakes already present. If the existing harness stores storylines without `headline`/`summary`/`centroid` keys, `storyline_theme_state` in FakeStore handles the misses via `.get`.)

Append to `tests/test_bench.py` (mirror its existing `reset_clusters` test, which asserts the delete list):

```python
def test_reset_clusters_wipes_topics_but_keeps_seed_categories(bench_db):
    reset_clusters(bench_db)
    executed = " ".join(bench_db.statements)  # or the file's equivalent capture
    assert "delete from public.topic_themes" in executed
    assert "delete from public.topic_categories where origin = 'llm'" in executed
```

Append to `tests/test_experiment.py`:

```python
def test_summary_includes_topics_section():
    summary = summarize(make_summary_db())  # the file's existing fake-db helper
    assert "topics" in summary
    for key in ("themes", "categories_seed", "categories_llm",
                "theme_attach_mix", "top_themes", "singleton_theme_rate"):
        assert key in summary["topics"]
```

(Extend the file's fake db helper so the new SQL in Step 4 returns rows; follow its established pattern for adding canned query results.)

- [ ] **Step 2: Run to verify failures**

Run: `uv run pytest tests/test_cluster_phase.py tests/test_bench.py tests/test_experiment.py -v`
Expected: new tests FAIL.

- [ ] **Step 3: Wire the runner**

In `pipeline/runner.py`:

Add import: `from pipeline.topics import ThemeEngine`.

In `cluster()`, after `episode_engine = EpisodeEngine(...)`:

```python
    theme_engine = ThemeEngine(replay, models, cfg) if cfg.topics_enabled else None
```

Replace both `card_engine.on_episode_closed(...)` call sites (the in-loop close and the finalize loop) with:

```python
            card_engine.on_episode_closed(closed)
            if theme_engine is not None:
                theme_engine.sync(str(closed["storyline_id"]))
```

(second site uses `episode` instead of `closed`.)

- [ ] **Step 4: Bench reset + experiment summary**

In `pipeline/bench.py::reset_clusters`, the existing deletes run before `delete from public.storylines`; theme deletes must come **after** storylines (FK). Replace the tail of the function with:

```python
    db.conn.execute("delete from public.episodes")
    db.conn.execute("delete from public.storylines")
    db.conn.execute("delete from public.entity_stats")
    db.conn.execute("delete from public.topic_themes")
    db.conn.execute("delete from public.topic_categories where origin = 'llm'")
```

In `pipeline/experiment.py::summarize`, add before the `return`:

```python
    topics_totals = db.one("""
        select
          (select count(*) from public.topic_themes where merged_into is null) as themes,
          (select count(*) from public.topic_categories where origin = 'seed') as categories_seed,
          (select count(*) from public.topic_categories where origin = 'llm') as categories_llm
    """)
    singleton_theme = db.one("""
        select round(avg((storyline_count = 1)::int)::numeric, 3) as rate
        from public.topic_themes where merged_into is null
    """)
    top_themes = db.all("""
        select t.display_name as theme, coalesce(c.display_name, '(uncategorized)') as category,
               t.storyline_count as storylines
        from public.topic_themes t
        left join public.topic_categories c on c.id = t.category_id
        where t.merged_into is null
        order by t.storyline_count desc, t.display_name limit 10
    """)
    topics = {
        "themes": topics_totals["themes"],
        "categories_seed": topics_totals["categories_seed"],
        "categories_llm": topics_totals["categories_llm"],
        "theme_attach_mix": mix(
            "select theme_attach_method as attach_method, count(*) as n "
            "from public.storylines where theme_attach_method is not null "
            "group by 1 order by n desc"),
        "top_themes": top_themes,
        "singleton_theme_rate": (
            float(singleton_theme["rate"]) if singleton_theme["rate"] is not None else None),
    }
```

and add `"topics": topics,` to the returned dict.

In `render_report`, add after the "Top chains" block:

```python
        "", "## Topics", "",
        f"- themes: {summary['topics']['themes']}  "
        f"categories: {summary['topics']['categories_seed']} seed "
        f"+ {summary['topics']['categories_llm']} llm",
        f"- singleton-theme rate: {summary['topics']['singleton_theme_rate']}",
        "", "## Theme attach mix (storyline -> theme)", "",
        *[f"- {m}: {n}" for m, n in summary["topics"]["theme_attach_mix"].items()],
        "", "## Top themes", "",
        *[f"- [{t['storylines']} storylines] {t['theme']} ({t['category']})"
          for t in summary["topics"]["top_themes"]],
```

- [ ] **Step 5: Run the whole suite**

Run: `uv run pytest`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pipeline/runner.py pipeline/bench.py pipeline/experiment.py tests/test_cluster_phase.py tests/test_bench.py tests/test_experiment.py
git commit -m "feat: wire theme engine into cluster replay, reset, and reports"
```

---

### Task 6: Console — contracts, queries, routes, CLI, fixture

**Files:**
- Modify: `apps/operator-console/src/lab/contracts.ts`
- Modify: `apps/operator-console/src/lab/queries.ts`
- Modify: `apps/operator-console/src/lab/routes.ts`
- Modify: `apps/operator-console/src/cli.ts`
- Modify: `apps/operator-console/test/fixtures/lab-fixture.sql`
- Test: `apps/operator-console/test/lab-queries.integration.test.ts`, `apps/operator-console/test/lab-routes.test.ts`

**Interfaces:**
- Consumes Task 1 tables.
- Produces: `LabQueries.storylines(filter)` accepts `category?: string; theme?: string` (both uuids); list items gain `categoryName/themeId/themeName` (all `string | null`); `LabQueries.topicThemes(filter: { category?: string })` and `LabQueries.topicCategories()`; routes `GET /api/lab/topics/themes` (optional `?category=`) and `GET /api/lab/topics/categories`; `storylineDetail` gains `categoryId/themeAttachMethod/themeReason/themeSimilarity`. Task 7 consumes all of these.

- [ ] **Step 1: Extend the fixture**

Append to `apps/operator-console/test/fixtures/lab-fixture.sql` (id-independent updates so existing fixture rows keep working):

```sql
-- topics fixture: one llm category (seed rows come from the migration),
-- one theme, the Valsatrex storyline assigned to it
insert into public.topic_categories (id, display_name, origin, proposal_reason)
values ('00000000-0000-4000-8000-0000000000c9', 'Test LLM Category', 'llm', 'fixture');

insert into public.topic_themes
    (id, display_name, category_id, storyline_count, first_storyline_at, newest_storyline_at)
values
    ('00000000-0000-4000-8000-0000000000d1', 'Valsatrex recall fallout',
     (select id from public.topic_categories where display_name = 'Food & Drug Safety'),
     1, '2026-05-14T14:00:00Z', '2026-05-17T15:00:00Z'),
    ('00000000-0000-4000-8000-0000000000d2', 'Field office access',
     '00000000-0000-4000-8000-0000000000c9', 0, null, null);

update public.storylines
set theme_id = '00000000-0000-4000-8000-0000000000d1',
    theme_attach_method = 'adjudicated_join',
    theme_similarity = 0.81,
    theme_reason = 'fixture join'
where 'valsatrex' = any(entity_set);
```

- [ ] **Step 2: Write the failing integration tests**

Append inside the `describe` block of `apps/operator-console/test/lab-queries.integration.test.ts`:

```typescript
  it("filters storylines by theme and category and shapes theme fields", async () => {
    const byTheme = await withFixture((queries) =>
      queries.storylines({ theme: "00000000-0000-4000-8000-0000000000d1" }),
    );
    expect(byTheme).toHaveLength(1);
    expect(byTheme[0]!.themeName).toBe("Valsatrex recall fallout");
    expect(byTheme[0]!.categoryName).toBe("Food & Drug Safety");

    const foodAndDrug = await withFixture(async (queries) => {
      const categories = await queries.topicCategories();
      const target = categories.find(
        (category) => category.displayName === "Food & Drug Safety",
      );
      return queries.storylines({ category: target!.id });
    });
    expect(foodAndDrug).toHaveLength(1);

    const unthemed = await withFixture((queries) =>
      queries.storylines({ theme: "00000000-0000-4000-8000-0000000000d2" }),
    );
    expect(unthemed).toHaveLength(0);
  });

  it("lists themes with category origin and narrows by category", async () => {
    const themes = await withFixture((queries) => queries.topicThemes({}));
    expect(themes.map((theme) => theme.displayName)).toContain(
      "Valsatrex recall fallout",
    );
    const llmOnly = await withFixture((queries) =>
      queries.topicThemes({ category: "00000000-0000-4000-8000-0000000000c9" }),
    );
    expect(llmOnly.map((theme) => theme.displayName)).toEqual([
      "Field office access",
    ]);
  });

  it("lists categories with origin badges", async () => {
    const categories = await withFixture((queries) => queries.topicCategories());
    const llm = categories.find(
      (category) => category.displayName === "Test LLM Category",
    );
    expect(llm?.origin).toBe("llm");
    expect(
      categories.some((category) => category.origin === "seed"),
    ).toBe(true);
  });

  it("exposes the theme attach audit on storyline detail", async () => {
    const all = await withFixture((queries) => queries.storylines({}));
    const valsatrex = all.find((item) => item.headline !== null);
    const detail = await withFixture((queries) =>
      queries.storylineDetail(valsatrex!.id),
    );
    expect(detail?.themeName).toBe("Valsatrex recall fallout");
    expect(detail?.themeAttachMethod).toBe("adjudicated_join");
    expect(detail?.themeSimilarity).toBeCloseTo(0.81, 2);
  });
```

- [ ] **Step 3: Run gated tests to verify failure**

Run: `LAB_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57422/lab_test pnpm --filter @dot-gov-news/operator-console test -- lab-queries`
(the lab_test database must have Task 1's migration applied first: run the migration file against it with psql, matching how the other migrations got there)
Expected: new tests FAIL (unknown column / method).

- [ ] **Step 4: Implement contracts**

In `apps/operator-console/src/lab/contracts.ts`:

Extend `StorylineListItemSchema` with (alphabetical position among existing keys):

```typescript
  categoryName: z.string().nullable(),
  themeId: z.string().nullable(),
  themeName: z.string().nullable(),
```

Extend `StorylineDetailSchema`:

```typescript
export const StorylineDetailSchema = StorylineListItemSchema.extend({
  categoryId: z.string().nullable(),
  episodes: z.array(EpisodeDetailSchema),
  overviewCards: z.array(EventCardSchema),
  themeAttachMethod: z.string().nullable(),
  themeReason: z.string().nullable(),
  themeSimilarity: z.number().nullable(),
});
```

Add new schemas + types:

```typescript
export const TopicCategorySchema = z.object({
  displayName: z.string(),
  id: z.string(),
  origin: z.enum(["seed", "llm"]),
  proposalReason: z.string().nullable(),
  themeCount: z.number(),
});

export const TopicThemeSchema = z.object({
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  categoryOrigin: z.enum(["seed", "llm"]).nullable(),
  displayName: z.string(),
  id: z.string(),
  newestStorylineAt: z.string().nullable(),
  storylineCount: z.number(),
});

export type TopicCategory = z.infer<typeof TopicCategorySchema>;
export type TopicTheme = z.infer<typeof TopicThemeSchema>;
```

- [ ] **Step 5: Implement queries**

In `apps/operator-console/src/lab/queries.ts`:

`storylines()` — add `category?: string; theme?: string;` to the filter type, join the topic tables, add the fragments and output fields:

```typescript
      select s.id, s.entity_set, s.event_keys, s.agency_ids, s.distinct_feeds,
             s.entry_count, s.episode_count, s.first_entry_at, s.newest_entry_at,
             s.theme_id, tt.display_name as theme_name, tc.display_name as category_name,
             c.headline
      from public.storylines s
      left join public.event_cards c on c.id = s.latest_card_id
      left join public.topic_themes tt on tt.id = s.theme_id
      left join public.topic_categories tc on tc.id = tt.category_id
      where s.merged_into is null
        ${filter.entity === undefined ? sql`` : sql`and ${filter.entity} = any(s.entity_set)`}
        ${filter.agency === undefined ? sql`` : sql`and ${filter.agency} = any(s.agency_ids)`}
        ${filter.minEpisodes === undefined ? sql`` : sql`and s.episode_count >= ${filter.minEpisodes}`}
        ${filter.theme === undefined ? sql`` : sql`and s.theme_id = ${filter.theme}`}
        ${filter.category === undefined ? sql`` : sql`and tt.category_id = ${filter.category}`}
```

and in the row mapping add:

```typescript
      categoryName: (row.category_name as string | null) ?? null,
      themeId: row.theme_id === null ? null : String(row.theme_id),
      themeName: (row.theme_name as string | null) ?? null,
```

`storylineDetail()` — extend the first select with `s.theme_id, s.theme_attach_method, s.theme_similarity, s.theme_reason, tt.display_name as theme_name, tt.category_id, tc.display_name as category_name` plus the same two left joins, and add to the returned object:

```typescript
      categoryId: storyline.category_id === null ? null : String(storyline.category_id),
      categoryName: (storyline.category_name as string | null) ?? null,
      themeAttachMethod:
        storyline.theme_attach_method === null
          ? null
          : String(storyline.theme_attach_method),
      themeId: storyline.theme_id === null ? null : String(storyline.theme_id),
      themeName: (storyline.theme_name as string | null) ?? null,
      themeReason:
        storyline.theme_reason === null ? null : String(storyline.theme_reason),
      themeSimilarity:
        storyline.theme_similarity === null
          ? null
          : Number(storyline.theme_similarity),
```

New methods (after `storylineAgencies`):

```typescript
  async topicThemes(filter: { category?: string }): Promise<TopicTheme[]> {
    const { sql } = this;
    const rows = await sql`
      select t.id, t.display_name, t.category_id, t.storyline_count,
             t.newest_storyline_at, c.display_name as category_name,
             c.origin as category_origin
      from public.topic_themes t
      left join public.topic_categories c on c.id = t.category_id
      where t.merged_into is null
        ${filter.category === undefined ? sql`` : sql`and t.category_id = ${filter.category}`}
      order by t.storyline_count desc, t.display_name
    `;
    return rows.map((row) => ({
      categoryId: row.category_id === null ? null : String(row.category_id),
      categoryName: (row.category_name as string | null) ?? null,
      categoryOrigin:
        row.category_origin === null
          ? null
          : (String(row.category_origin) as "seed" | "llm"),
      displayName: String(row.display_name),
      id: String(row.id),
      newestStorylineAt: iso(row.newest_storyline_at),
      storylineCount: Number(row.storyline_count),
    }));
  }

  async topicCategories(): Promise<TopicCategory[]> {
    const rows = await this.sql`
      select c.id, c.display_name, c.origin, c.proposal_reason,
             (select count(*)::integer from public.topic_themes t
              where t.category_id = c.id and t.merged_into is null) as theme_count
      from public.topic_categories c
      order by c.display_name
    `;
    return rows.map((row) => ({
      displayName: String(row.display_name),
      id: String(row.id),
      origin: String(row.origin) as "seed" | "llm",
      proposalReason: (row.proposal_reason as string | null) ?? null,
      themeCount: Number(row.theme_count),
    }));
  }
```

Add `TopicCategory, TopicTheme` to the type imports from `./contracts`.

- [ ] **Step 6: Implement routes + route tests**

In `apps/operator-console/src/lab/routes.ts`, inside the `/storylines` handler's `queries.storylines({...})` call add:

```typescript
        category: asString(request.query.category),
        theme: asString(request.query.theme),
```

Add after the `/agencies` route:

```typescript
  router.get(
    "/topics/themes",
    handle(async (request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      const category =
        typeof request.query.category === "string" &&
        request.query.category.length > 0
          ? request.query.category
          : undefined;
      response.json({ data: { themes: await queries.topicThemes({ category }) } });
    }),
  );

  router.get(
    "/topics/categories",
    handle(async (_request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      response.json({
        data: { categories: await queries.topicCategories() },
      });
    }),
  );
```

Append to `apps/operator-console/test/lab-routes.test.ts` (reuse the file's `listen` helper and fake-queries pattern used by the existing storylines/agencies route tests):

```typescript
  it("serves topic themes and categories and passes storyline topic filters", async () => {
    const seen: Record<string, unknown>[] = [];
    const base = await listen({
      capability: async () => ({
        experimentsEnabled: false,
        status: "available" as const,
      }),
      queries: {
        storylines: async (filter: Record<string, unknown>) => {
          seen.push(filter);
          return [];
        },
        topicCategories: async () => [
          {
            displayName: "Test LLM Category",
            id: "00000000-0000-4000-8000-0000000000c9",
            origin: "llm",
            proposalReason: "fixture",
            themeCount: 1,
          },
        ],
        topicThemes: async () => [],
      } as never,
    });

    const categories = await fetch(`${base}/topics/categories`);
    expect(categories.status).toBe(200);
    const body = (await categories.json()) as {
      data: { categories: { origin: string }[] };
    };
    expect(body.data.categories[0]!.origin).toBe("llm");

    const themes = await fetch(`${base}/topics/themes?category=x`);
    expect(themes.status).toBe(200);

    await fetch(
      `${base}/storylines?theme=t-1&category=c-1`,
    );
    expect(seen[0]).toMatchObject({ category: "c-1", theme: "t-1" });
  });
```

- [ ] **Step 7: CLI parity**

In `apps/operator-console/src/cli.ts`:

Add to the `lab storylines` command options (after `--agency`):

```typescript
  .option("--category <id>", "filter by topic category id")
  .option("--theme <id>", "filter by topic theme id")
```

add `category?: string; theme?: string;` to the action's options type and `category: options.category, theme: options.theme,` to the `queries.storylines({...})` call. Add `theme` to the non-JSON `printRows` mapping: `theme: item.themeName ?? "—",`.

Add a new command after `lab storyline <id>`:

```typescript
lab
  .command("themes")
  .description("List topic themes (largest first)")
  .option("--category <id>", "filter by topic category id")
  .option("--json", "print JSON only")
  .action((options: JsonOption & { category?: string }) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const themes = await queries.topicThemes({ category: options.category });
        if (options.json) {
          printJson(themes);
          return;
        }
        printRows(
          themes.map((theme) => ({
            category: theme.categoryName ?? "(uncategorized)",
            id: theme.id,
            name: theme.displayName,
            origin: theme.categoryOrigin ?? "—",
            storylines: theme.storylineCount,
          })),
        );
      }),
    ),
  );
```

- [ ] **Step 8: Run console tests**

Run: `pnpm --filter @dot-gov-news/operator-console test` (unit) and the gated command from Step 3 (integration).
Expected: PASS, including the four new integration tests and the new route test.

- [ ] **Step 9: Commit**

```bash
git add apps/operator-console/src/lab apps/operator-console/src/cli.ts apps/operator-console/test
git commit -m "feat: expose topic themes and categories through lab queries, routes, and cli"
```

---

### Task 7: Dashboard UI — filters, chips, origin badges, detail audit

**Files:**
- Modify: `apps/operator-console/src/ui/pages/StorylinesPage.tsx`
- Modify: `apps/operator-console/src/ui/pages/StorylineDetailPage.tsx`
- Test: `apps/operator-console/test/storylines-page.test.tsx`

**Interfaces:**
- Consumes: `/topics/themes`, `/topics/categories` endpoints and the extended storyline payloads (Task 6). `TopicCategorySchema`/`TopicThemeSchema` from contracts.

- [ ] **Step 1: Write the failing page tests**

In `apps/operator-console/test/storylines-page.test.tsx`: first extend every storyline item payload constant with the three new schema-required fields —

```typescript
        categoryName: "Food & Drug Safety",
        themeId: "00000000-0000-4000-8000-0000000000d1",
        themeName: "Valsatrex recall fallout",
```

(and `categoryName: null, themeId: null, themeName: null` for the Tulsa item). Extend the fetch mock dispatch (the file's URL-matched `vi` mock) to answer `/topics/categories` and `/topics/themes` with:

```typescript
const CATEGORIES_PAYLOAD = {
  data: {
    categories: [
      {
        displayName: "Food & Drug Safety",
        id: "00000000-0000-4000-8000-0000000000c1",
        origin: "seed",
        proposalReason: null,
        themeCount: 1,
      },
      {
        displayName: "Test LLM Category",
        id: "00000000-0000-4000-8000-0000000000c9",
        origin: "llm",
        proposalReason: "proposed by classifier",
        themeCount: 0,
      },
    ],
  },
};

const THEMES_PAYLOAD = {
  data: {
    themes: [
      {
        categoryId: "00000000-0000-4000-8000-0000000000c1",
        categoryName: "Food & Drug Safety",
        categoryOrigin: "seed",
        displayName: "Valsatrex recall fallout",
        id: "00000000-0000-4000-8000-0000000000d1",
        newestStorylineAt: "2026-05-17T15:00:00.000Z",
        storylineCount: 1,
      },
    ],
  },
};
```

Then add tests (using the file's `renderPage` + mock helpers):

```typescript
  it("renders category and theme filters with llm origin badges", async () => {
    mockFetchRoutes(); // the file's URL-dispatch mock, now including topics payloads
    renderPage();
    expect(await screen.findByLabelText("Category")).toBeTruthy();
    expect(await screen.findByLabelText("Theme")).toBeTruthy();
    // llm-origin categories are visibly marked for auditability
    expect(
      await screen.findByText("Test LLM Category (LLM)"),
    ).toBeTruthy();
  });

  it("shows the theme chip on storyline rows and in the cli command", async () => {
    mockFetchRoutes();
    renderPage(
      "/storylines?theme=00000000-0000-4000-8000-0000000000d1",
    );
    expect(await screen.findByText("Valsatrex recall fallout")).toBeTruthy();
    expect(
      await screen.findByText(
        /--theme 00000000-0000-4000-8000-0000000000d1/,
      ),
    ).toBeTruthy();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @dot-gov-news/operator-console test -- storylines-page`
Expected: FAIL — schema parse errors on old payloads first; after payload fix, missing labels.

- [ ] **Step 3: Implement StorylinesPage**

In `apps/operator-console/src/ui/pages/StorylinesPage.tsx`:

Read `theme`/`category` params next to the others:

```typescript
  const theme = params.get("theme") ?? "";
  const category = params.get("category") ?? "";
```

Add option queries after the `agencies` query (import `TopicCategorySchema, TopicThemeSchema` from contracts):

```typescript
  const categories = useQuery({
    enabled: capability.data?.status === "available",
    queryFn: () =>
      fetchLab(
        "/topics/categories",
        z.object({ categories: TopicCategorySchema.array() }),
      ),
    queryKey: ["lab-topic-categories"],
  });
  const themes = useQuery({
    enabled: capability.data?.status === "available",
    queryFn: () =>
      fetchLab(
        `/topics/themes${category === "" ? "" : `?category=${category}`}`,
        z.object({ themes: TopicThemeSchema.array() }),
      ),
    queryKey: ["lab-topic-themes", category],
  });
```

Extend the storylines query: `if (theme !== "") query.set("theme", theme);`, `if (category !== "") query.set("category", category);` and add `theme, category` to its `queryKey` array.

Extend `cliFilter`:

```typescript
    category === "" ? "" : ` --category ${category}`,
    theme === "" ? "" : ` --theme ${theme}`,
```

Add `"category"` and `"theme"` to the form-submit key list. Add the two selects to the filter bar after the Agency select (categories show the origin badge; picking a category narrows themes because the themes query is keyed on it):

```tsx
          <label htmlFor="category">Category</label>
          <select
            defaultValue={category}
            id="category"
            key={categories.data === undefined ? "cat-loading" : "cat-loaded"}
            name="category"
          >
            <option value="">All categories</option>
            {(categories.data?.categories ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.origin === "llm"
                  ? `${option.displayName} (LLM)`
                  : option.displayName}
              </option>
            ))}
          </select>
          <label htmlFor="theme">Theme</label>
          <select
            defaultValue={theme}
            id="theme"
            key={themes.data === undefined ? "theme-loading" : "theme-loaded"}
            name="theme"
          >
            <option value="">All themes</option>
            {(themes.data?.themes ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.displayName} ({option.storylineCount})
              </option>
            ))}
          </select>
```

Add a Theme column to the chains table: header `<th>Theme</th>` after "Agencies", cell after the agencies cell:

```tsx
                      <td>{item.themeName ?? "—"}</td>
```

- [ ] **Step 4: Implement detail page audit block**

In `apps/operator-console/src/ui/pages/StorylineDetailPage.tsx`, in the `page-intro` section under the agencies/keys `<p>`, add:

```tsx
          {storyline.themeName === null ? null : (
            <p className="source-note">
              Theme: {storyline.themeName}
              {storyline.categoryName === null
                ? ""
                : ` · ${storyline.categoryName}`}
              {storyline.themeAttachMethod === null
                ? ""
                : ` · ${storyline.themeAttachMethod}`}
              {storyline.themeSimilarity === null
                ? ""
                : ` · sim ${storyline.themeSimilarity.toFixed(3)}`}
              {storyline.themeReason === null
                ? ""
                : ` — ${storyline.themeReason}`}
            </p>
          )}
```

Also update the "No overview card yet" empty-row copy (overview-at-birth makes the collapse message stale):

```tsx
            <p className="empty-row">No overview card yet.</p>
```

- [ ] **Step 5: Run console tests**

Run: `pnpm --filter @dot-gov-news/operator-console test`
Expected: PASS (page tests, route tests, any detail-page snapshot updates).

- [ ] **Step 6: Commit**

```bash
git add apps/operator-console/src/ui apps/operator-console/test/storylines-page.test.tsx
git commit -m "feat: add topic filters, theme chips, and origin badges to the dashboard"
```

---

### Task 8: End-to-end verification — stub topics experiment

**Files:**
- Create: `docs/eval/topics-baseline-stub/report.md` (generated, committed as the lab notebook entry)

**Interfaces:**
- Consumes everything above. Produces the first `topics-*` reference run.

- [ ] **Step 1: Rebuild the bench db and re-sync the corpus**

```bash
supabase db reset
SUPABASE_URL=... SUPABASE_SECRET_KEY=... uv run python -m pipeline.cli sync
uv run python -m pipeline.cli prepare --stub
```

(Env values come from the operator's local `.env` — never write DATABASE_URL into `.env`; the CLI default points at the local bench db already.)

- [ ] **Step 2: Run the stub topics experiment**

```bash
TOPICS_ENABLED=1 uv run python -m pipeline.cli experiment topics-baseline-stub --stub
```

Expected: JSON output with a `report` path and `run_id`.

- [ ] **Step 3: Verify the report and db state**

Check `docs/eval/topics-baseline-stub/report.md` contains the `## Topics` section with `themes >= 1` and a theme attach mix. Then sanity-query:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "select count(*) filter (where theme_id is not null) as themed,
          count(*) as total
   from storylines where merged_into is null;"
```

Expected: `themed = total` (every storyline assigned — overview-at-birth guarantees a centroid).

- [ ] **Step 4: Verify the dashboard**

Start the operator console dev server, open the Storylines page: Category + Theme dropdowns populated, picking a theme filters the table, an `(LLM)`-suffixed category appears only if the stub proposed one, storyline detail shows the theme audit line.

- [ ] **Step 5: Run a control experiment with topics off**

```bash
uv run python -m pipeline.cli experiment baseline-control --stub
```

Expected: report shows `themes: 0`; storyline/episode counts match the pre-topics `baseline` report (proving `topics_enabled=false` changed nothing except overview cards — `cards` count will be higher).

- [ ] **Step 6: Commit the notebook entry**

```bash
git add docs/eval/topics-baseline-stub
git commit -m "docs: record topics-baseline-stub reference run"
```

---

## Self-Review Notes

- Spec coverage: data model (Task 1), overview-at-birth (Task 3), engine + hysteresis + fallbacks (Task 4), runner/reset/report (Task 5), queries/routes/CLI parity (Task 6), UI filters + origin badges + detail audit (Task 7), experiment workflow (Task 8). Theme naming folded into adjudication: Task 2 prompt + Task 4 `_assign`. Category retry-on-null: Task 4 `_assign` tail.
- Type consistency: `sync(storyline_id)` (Tasks 4→5); model dict shapes (Tasks 2→4); `topicThemes/topicCategories` (Tasks 6→7); RPC signatures (Tasks 1→4).
- Deliberate scope cuts per spec: no theme `merged_into` consolidation job, no name history, no prod-worker wiring.
