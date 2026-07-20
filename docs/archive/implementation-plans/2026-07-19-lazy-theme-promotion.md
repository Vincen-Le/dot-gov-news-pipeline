# Lazy Theme Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stream-time theme spawning with a category-first architecture: storylines get a seed-category label on the stream, themes are born only in an offline promotion sweep when a within-category cluster crosses an evidence gate, and the stream path becomes attach-only against LLM-written inclusion criteria.

**Architecture:** Stage 4 (`pipeline/topics.py`) loses all spawn/merge machinery and becomes a sticky, none-biased attach step: candidates by centroid cosine across ALL themes (cross-category attach allowed), verdict by a criterion-membership adjudicator. A new stage (`pipeline/promotion.py`) runs on an event-time cadence inside the replay: mop-up attach pass, greedy within-category clustering of category-resident storylines, a three-axis gate (size, cohesion, persistence), an expensive promotion judge that names the theme and writes its inclusion criterion (or routes the cluster to an existing theme instead of minting a duplicate), and a naive cohesion-triggered demotion review. Dormancy is derived (`newest_storyline_at` older than K days) and is a consumer/surfacing concern — no pipeline code. A new `pipeline/categories.py` classifies each storyline into exactly one of the 23 seeded categories at card time.

**Tech Stack:** Python 3 (uv), numpy, psycopg via `pipeline/db.py` RPC wrapper, Postgres (Supabase migrations, security-definer RPCs), Workers AI models behind `pipeline/ai.py`, deterministic `pipeline/stub.py` + `tests/fakes.py` for unit tests, pytest.

## Global Constraints

- All storyline/theme writes go through security-definer RPCs (`supabase/migrations/`), never direct SQL from `Store`.
- Centroids are fp16-packed bytea (`pack_fp16`/`unpack_fp16` from `pipeline/vectors.py`); DB check constraint caps them at 4096 bytes.
- Replay is event-time only: no wall-clock (`now()`) decisions in pipeline code; every temporal decision uses `published_at`-derived timestamps threaded through the runner.
- Failure bias: a failed LLM verdict may leave work undone (uncategorized, unattached, unpromoted, un-demoted) but must never attach, promote, or demote on its own.
- Unit tests run with `uv run pytest` using `FakeStore`/`StubModels`; DB tests are `@pytest.mark.integration` and run against the lab_test database (see `docs/operations/clustering-lab.md`; local Postgres on port 57422, `DATABASE_URL` passed inline, never written to `.env`).
- Config knobs get an env override in `load_config()` following the existing `_f`/`_b`/`int(os.environ.get(...))` pattern; all new floors/sizes are placeholders pending golden-window calibration.
- Existing theme rows/enum values stay valid: migrations are additive; old `theme_attach_method` values remain in the check constraint.
- Match existing style: module docstrings state the failure-bias contract; comments only for constraints code can't show.

---

### Task 1: Schema migration — category label, criterion, demotion, new RPCs

**Files:**
- Create: `supabase/migrations/20260719110000_lazy_theme_promotion.sql`
- Test: `tests/test_store_integration.py` (append)

**Interfaces:**
- Consumes: existing `public.storylines`, `public.topic_categories`, `public.topic_themes`, `public.create_topic_theme(text, bytea, uuid, text)`.
- Produces: columns `storylines.category_id/category_method/category_reason`, `topic_themes.inclusion_criterion/demoted_at`; RPCs `set_storyline_category(uuid, uuid, text, text)`, `demote_topic_theme(uuid)`, and `create_topic_theme(text, bytea, uuid, text, text)` (5-arg replaces 4-arg; the 4-arg version is dropped). Task 2's Store methods call these signatures verbatim.

- [ ] **Step 1: Write the migration**

```sql
begin;

-- Storylines gain a stream-time category label. Audit pair mirrors the theme
-- trio philosophy: the row records the decision in force.
alter table public.storylines
    add column category_id uuid references public.topic_categories(id),
    add column category_method text,
    add column category_reason text,
    add constraint storylines_category_method_valid
        check (category_method is null or category_method in ('classified', 'retry')),
    add constraint storylines_category_reason_bounded
        check (category_reason is null or length(category_reason) <= 2048);

comment on column public.storylines.category_id is
    'Broad seeded category assigned on the stream; the only stream-time topic label. Themes are born offline by the promotion sweep.';

create index storylines_category_resident_idx
    on public.storylines (category_id)
    where theme_id is null and merged_into is null;

-- Themes gain the promotion judge''s membership rule and a demotion tombstone.
alter table public.topic_themes
    add column inclusion_criterion text,
    add column demoted_at timestamptz,
    add constraint topic_themes_inclusion_criterion_bounded
        check (inclusion_criterion is null or length(inclusion_criterion) <= 1024);

comment on column public.topic_themes.inclusion_criterion is
    'One-sentence membership rule written by the promotion judge at theme birth; the stream membership adjudicator tests storylines against it.';
comment on column public.topic_themes.demoted_at is
    'Set by demote_topic_theme; demoted themes are excluded from assignment and surfacing. Dormancy is derived (newest_storyline_at age), never stored.';

-- New attach methods; old values stay valid for existing rows.
alter table public.storylines
    drop constraint storylines_theme_attach_method_valid;
alter table public.storylines
    add constraint storylines_theme_attach_method_valid
        check (theme_attach_method is null or theme_attach_method in
            ('adjudicated_join', 'knn_join', 'new_theme', 'reassigned',
             'criterion_join', 'promoted', 'sweep_join'));

create or replace function public.set_storyline_category(
    p_storyline_id uuid,
    p_category_id uuid,
    p_method text,
    p_reason text
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    update public.storylines set
        category_id = p_category_id,
        category_method = p_method,
        category_reason = left(p_reason, 2048)
    where id = p_storyline_id;
end
$fn$;

create or replace function public.demote_topic_theme(
    p_theme_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    update public.storylines set
        theme_id = null,
        theme_attach_method = null,
        theme_similarity = null,
        theme_reason = left('demoted from theme ' || p_theme_id::text, 2048)
    where theme_id = p_theme_id;

    update public.topic_themes set
        demoted_at = now(),
        storyline_count = 0
    where id = p_theme_id;
end
$fn$;

comment on function public.demote_topic_theme is
    'Members fall back to category-only; the theme keeps its row (audit) but is dead for assignment. Sole detach path.';

-- create_topic_theme grows the criterion param; drop the old arity so RPC
-- name resolution stays unambiguous.
drop function public.create_topic_theme(text, bytea, uuid, text);
create function public.create_topic_theme(
    p_display_name text,
    p_centroid bytea,
    p_category_id uuid,
    p_name_model text,
    p_inclusion_criterion text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_id uuid;
begin
    insert into public.topic_themes
        (display_name, centroid, category_id, name_model, inclusion_criterion)
    values (left(p_display_name, 256), p_centroid, p_category_id,
            p_name_model, left(p_inclusion_criterion, 1024))
    returning id into v_id;
    return v_id;
end
$fn$;

do $grants$
declare
    v_sig text;
begin
    foreach v_sig in array array[
        'public.set_storyline_category(uuid, uuid, text, text)',
        'public.demote_topic_theme(uuid)',
        'public.create_topic_theme(text, bytea, uuid, text, text)'
    ] loop
        execute format('revoke execute on function %s from public, anon, authenticated', v_sig);
        execute format('grant execute on function %s to service_role', v_sig);
    end loop;
end
$grants$;

commit;
```

- [ ] **Step 2: Apply the migration to the lab database**

Run: `supabase db reset --local` (or the lab's migration-apply flow per `docs/operations/clustering-lab.md` if a reset would destroy corpus state — `supabase migration up --local` applies pending migrations only).
Expected: migration `20260719110000` applies cleanly, no errors.

- [ ] **Step 3: Write the failing integration test**

Append to `tests/test_store_integration.py` (reuse its imports and setup/teardown style; the file already builds a source → entry → episode → storyline chain and cleans up in `finally`):

```python
@pytest.mark.integration
def test_category_criterion_and_demotion_rpcs_round_trip():
    db = Db(os.environ["DATABASE_URL"])
    store = Store(db)
    theme_id = None
    category_id = None
    try:
        category_id = store.upsert_category(
            f"Test Category {uuid.uuid4().hex[:8]}", "seed", None)
        theme_id = store.create_theme(
            "Test Criterion Theme", b"\x00\x00", category_id,
            "test-model", "storylines about integration-test fixtures")

        themes = {str(t["id"]): t for t in store.all_themes()}
        assert themes[theme_id]["inclusion_criterion"] == \
            "storylines about integration-test fixtures"

        store.demote_theme(theme_id)
        assert theme_id not in {str(t["id"]) for t in store.all_themes()}
    finally:
        if theme_id is not None:
            db.execute("delete from public.topic_themes where id = %(i)s",
                       {"i": theme_id})
        if category_id is not None:
            db.execute("delete from public.topic_categories where id = %(i)s",
                       {"i": category_id})
```

(If `Db` has no `execute` helper, use the same raw-cleanup mechanism the existing tests in this file use — mirror them exactly.)

- [ ] **Step 4: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57422/lab_test uv run pytest tests/test_store_integration.py::test_category_criterion_and_demotion_rpcs_round_trip -m integration -v`
Expected: FAIL — `Store.create_theme` doesn't accept an `inclusion_criterion` argument yet (that's Task 2); the failure proves the test exercises the new surface. If it fails on the RPC not existing instead, the migration didn't apply — fix that first.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260719110000_lazy_theme_promotion.sql tests/test_store_integration.py
git commit -m "feat: schema for lazy theme promotion — category label, inclusion criterion, demotion RPC"
```

(The integration test goes green at the end of Task 2; committing a red gated test is acceptable here because the migration and the Store change are separate reviewable units.)

---

### Task 2: Store + FakeStore surface

**Files:**
- Modify: `pipeline/store.py` (topics section, lines ~467–574)
- Modify: `tests/fakes.py` (topics section, lines ~115–202)
- Test: `tests/test_store_integration.py` (Task 1's test goes green), `tests/test_fakes_topics.py` (create)

**Interfaces:**
- Consumes: Task 1's RPCs.
- Produces (exact signatures later tasks call):
  - `Store.set_storyline_category(storyline_id: str, category_id: str, method: str, reason: str | None) -> None`
  - `Store.demote_theme(theme_id: str) -> None`
  - `Store.create_theme(display_name: str, centroid: bytes, category_id: str | None, name_model: str | None, inclusion_criterion: str | None) -> str` (5th param added)
  - `Store.uncategorized_storyline_ids() -> list[str]`
  - `Store.categorized_unthemed() -> list[dict]` — dicts with `id, category_id, centroid (unpacked ndarray), first_entry_at, headline, summary`
  - `Store.all_themes()` rows additionally carry `inclusion_criterion`, `newest_storyline_at`; demoted themes excluded
  - `Store.storyline_theme_state()` rows additionally carry `category_id` (str | None), `newest_entry_at`
  - `FakeStore` mirrors all of the above.

- [ ] **Step 1: Write the failing fake-store test**

Create `tests/test_fakes_topics.py`:

```python
from datetime import datetime, timezone

import numpy as np

from pipeline.vectors import pack_fp16
from tests.fakes import FakeStore

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)


def _storyline(store, sid, headline="h"):
    store.storylines[sid] = {
        "id": sid, "entity_set": [], "event_keys": [], "episode_count": 1,
        "centroid": pack_fp16(np.ones(4, dtype=np.float32)),
        "headline": headline, "summary": "", "theme_id": None,
        "category_id": None, "newest_entry_at": T0, "first_entry_at": T0,
    }


def test_category_write_and_reads():
    store = FakeStore()
    store.categories["c1"] = {"id": "c1", "display_name": "Public Health",
                              "origin": "seed"}
    _storyline(store, "s1")
    assert store.uncategorized_storyline_ids() == ["s1"]

    store.set_storyline_category("s1", "c1", "classified", "obvious")
    assert store.uncategorized_storyline_ids() == []
    assert store.storyline_theme_state("s1")["category_id"] == "c1"

    residents = store.categorized_unthemed()
    assert [r["id"] for r in residents] == ["s1"]
    assert residents[0]["category_id"] == "c1"


def test_create_theme_carries_criterion_and_demote_hides_theme():
    store = FakeStore()
    _storyline(store, "s1")
    theme_id = store.create_theme(
        "Measles Outbreak Response", pack_fp16(np.ones(4, dtype=np.float32)),
        None, None, "storylines about the 2026 measles outbreak response")
    store.assign_theme("s1", theme_id, "promoted", None, "test", None, None)

    themes = store.all_themes()
    assert themes[0]["inclusion_criterion"].startswith("storylines about")

    store.demote_theme(theme_id)
    assert store.all_themes() == []
    assert store.storylines["s1"]["theme_id"] is None
    assert store.storylines["s1"]["theme_reason"].startswith("demoted")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_fakes_topics.py -v`
Expected: FAIL — `FakeStore` has no `set_storyline_category`.

- [ ] **Step 3: Implement Store methods**

In `pipeline/store.py`, topics section:

Update `all_themes` (replace the select):

```python
    def all_themes(self) -> list[dict]:
        rows = self.db.all(
            """
            select id, display_name, centroid, category_id, storyline_count,
                   inclusion_criterion, newest_storyline_at, created_at
            from public.topic_themes
            where merged_into is null and demoted_at is null
            order by display_name, first_storyline_at, storyline_count, centroid
            """
        )
        return [dict(r, centroid=unpack_fp16(r["centroid"]) if r["centroid"] is not None else None)
                for r in rows]
```

Update `storyline_theme_state` (replace the select and shaping):

```python
    def storyline_theme_state(self, storyline_id: str) -> dict | None:
        row = self.db.one(
            """
            select s.centroid, s.theme_id, s.category_id, s.newest_entry_at,
                   c.headline, c.summary
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
                    theme_id=str(row["theme_id"]) if row["theme_id"] else None,
                    category_id=str(row["category_id"]) if row["category_id"] else None)
```

Update `create_theme`:

```python
    def create_theme(self, display_name: str, centroid: bytes,
                     category_id: str | None, name_model: str | None,
                     inclusion_criterion: str | None) -> str:
        return str(self.db.rpc("create_topic_theme", p_display_name=display_name,
                               p_centroid=centroid, p_category_id=category_id,
                               p_name_model=name_model,
                               p_inclusion_criterion=inclusion_criterion))
```

Add new methods after `upsert_category`:

```python
    def set_storyline_category(self, storyline_id: str, category_id: str,
                               method: str, reason: str | None) -> None:
        self.db.rpc("set_storyline_category", p_storyline_id=storyline_id,
                    p_category_id=category_id, p_method=method, p_reason=reason)

    def demote_theme(self, theme_id: str) -> None:
        self.db.rpc("demote_topic_theme", p_theme_id=theme_id)

    def uncategorized_storyline_ids(self) -> list[str]:
        return [
            str(r["id"]) for r in self.db.all(
                "select id from public.storylines "
                "where merged_into is null and category_id is null "
                "and centroid is not null "
                "order by first_entry_at, id")
        ]

    def categorized_unthemed(self) -> list[dict]:
        rows = self.db.all(
            """
            select s.id, s.category_id, s.centroid, s.first_entry_at,
                   c.headline, c.summary
            from public.storylines s
            left join public.event_cards c on c.id = s.latest_card_id
            where s.merged_into is null and s.theme_id is null
              and s.category_id is not null and s.centroid is not null
            order by s.first_entry_at, s.id
            """
        )
        return [dict(r, id=str(r["id"]), category_id=str(r["category_id"]),
                     centroid=unpack_fp16(r["centroid"])) for r in rows]
```

- [ ] **Step 4: Implement FakeStore mirrors**

In `tests/fakes.py`, topics section — update `all_themes`, `storyline_theme_state`, `create_theme`; add the four new methods:

```python
    def all_themes(self):
        return [dict(t, centroid=unpack_fp16(t["centroid"]) if t["centroid"] is not None else None)
                for t in self.themes.values()
                if t.get("merged_into") is None and t.get("demoted_at") is None]
```

```python
    def storyline_theme_state(self, storyline_id):
        s = self.storylines.get(storyline_id)
        if s is None:
            return None
        return {"centroid": unpack_fp16(s["centroid"]) if s.get("centroid") is not None else None,
                "theme_id": s.get("theme_id"),
                "category_id": s.get("category_id"),
                "newest_entry_at": s.get("newest_entry_at"),
                "headline": s.get("headline", ""), "summary": s.get("summary", "")}
```

```python
    def create_theme(self, display_name, centroid, category_id, name_model,
                     inclusion_criterion):
        theme_id = str(uuid.uuid4())
        self.themes[theme_id] = {"id": theme_id, "display_name": display_name,
                                 "centroid": centroid, "category_id": category_id,
                                 "storyline_count": 0, "merged_into": None,
                                 "demoted_at": None,
                                 "inclusion_criterion": inclusion_criterion,
                                 "newest_storyline_at": None,
                                 "created_at": len(self.themes)}
        return theme_id
```

Also update the fake `assign_theme` to maintain `newest_storyline_at` (append after the count recompute loop):

```python
        theme["newest_storyline_at"] = max(
            (x.get("newest_entry_at") for x in self.storylines.values()
             if x.get("theme_id") == theme_id and x.get("newest_entry_at") is not None),
            default=theme.get("newest_storyline_at"))
```

New fake methods (after `merge_theme`):

```python
    def set_storyline_category(self, storyline_id, category_id, method, reason):
        self.storylines[storyline_id].update(
            category_id=category_id, category_method=method,
            category_reason=reason)

    def demote_theme(self, theme_id):
        for s in self.storylines.values():
            if s.get("theme_id") == theme_id:
                s.update(theme_id=None, theme_attach_method=None,
                         theme_similarity=None,
                         theme_reason=f"demoted from theme {theme_id}")
        self.themes[theme_id].update(demoted_at=True, storyline_count=0)

    def uncategorized_storyline_ids(self):
        return [s["id"] for s in self.storylines.values()
                if s.get("category_id") is None and s.get("centroid") is not None]

    def categorized_unthemed(self):
        return [{"id": s["id"], "category_id": s["category_id"],
                 "centroid": unpack_fp16(s["centroid"]),
                 "first_entry_at": s.get("first_entry_at"),
                 "headline": s.get("headline", ""),
                 "summary": s.get("summary", "")}
                for s in self.storylines.values()
                if s.get("theme_id") is None and s.get("category_id") is not None
                and s.get("centroid") is not None]
```

- [ ] **Step 5: Fix create_theme call sites**

`pipeline/topics.py:150` (`self.store.create_theme(name, pack_fp16(vec), category_id=category_id, name_model=...)`) gains `inclusion_criterion=None` for now (Task 4 deletes this call site entirely; this keeps the suite green in between). `tests/test_topics.py:80` passes positional args — append `None`.

- [ ] **Step 6: Run tests**

Run: `uv run pytest tests/test_fakes_topics.py tests/test_topics.py -v`
Expected: PASS.
Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57422/lab_test uv run pytest tests/test_store_integration.py -m integration -v`
Expected: PASS, including Task 1's test.

- [ ] **Step 7: Commit**

```bash
git add pipeline/store.py tests/fakes.py tests/test_fakes_topics.py tests/test_topics.py pipeline/topics.py
git commit -m "feat: store surface for category labels, inclusion criteria, demotion"
```

---

### Task 3: Category classifier — prompt, model call, stub, engine

**Files:**
- Modify: `pipeline/prompts.py` (after `CATEGORY_DESCRIPTIONS`/`_shape_seed_categories`)
- Modify: `pipeline/ai.py` (after `create_theme_metadata`)
- Modify: `pipeline/stub.py` (after `create_theme_metadata`)
- Create: `pipeline/categories.py`
- Test: `tests/test_categories.py` (create)

**Interfaces:**
- Consumes: `Store.storyline_theme_state`, `Store.all_categories`, `Store.set_storyline_category` (Task 2); `_shape_seed_categories`, `CATEGORY_ASSIGNMENT_GUIDANCE` (existing).
- Produces: `WorkersAI.classify_category(storyline: dict, categories: list[dict]) -> dict` returning `{"category_id": str | None, "reason": str}`; `StubModels.classify_category` same shape; `CategoryEngine(store, models, cfg).classify(storyline_id: str) -> None`. Task 6 wires `CategoryEngine` into the runner.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_categories.py`:

```python
from pipeline.categories import CategoryEngine
from pipeline.config import Config
from pipeline.stub import StubModels
from tests.test_fakes_topics import _storyline
from tests.fakes import FakeStore

CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             topics_enabled=True)


def _store_with_seeds():
    store = FakeStore()
    store.categories["c-health"] = {
        "id": "c-health", "display_name": "Public Health", "origin": "seed"}
    store.categories["c-tax"] = {
        "id": "c-tax", "display_name": "Taxes & Revenue", "origin": "seed"}
    return store


def test_classify_assigns_one_seed_category():
    store = _store_with_seeds()
    _storyline(store, "s1", headline="CDC reports measles public health emergency")
    CategoryEngine(store, StubModels(), CFG).classify("s1")
    s = store.storylines["s1"]
    assert s["category_id"] == "c-health"   # stub: token overlap with the name
    assert s["category_method"] == "classified"


def test_classify_is_idempotent():
    store = _store_with_seeds()
    _storyline(store, "s1", headline="CDC reports measles public health emergency")
    engine = CategoryEngine(store, StubModels(), CFG)
    engine.classify("s1")

    class ExplodingModels(StubModels):
        def classify_category(self, storyline, categories):
            raise AssertionError("already categorized; must not re-call the LLM")

    CategoryEngine(store, ExplodingModels(), CFG).classify("s1")


def test_classifier_failure_leaves_category_null():
    class BrokenModels(StubModels):
        def classify_category(self, storyline, categories):
            raise RuntimeError("classifier boom")

    store = _store_with_seeds()
    _storyline(store, "s1")
    CategoryEngine(store, BrokenModels(), CFG).classify("s1")
    assert store.storylines["s1"]["category_id"] is None


def test_hallucinated_category_id_is_dropped():
    class HallucinatingModels(StubModels):
        def classify_category(self, storyline, categories):
            return {"category_id": "c-invented", "reason": "made up"}

    store = _store_with_seeds()
    _storyline(store, "s1")
    CategoryEngine(store, HallucinatingModels(), CFG).classify("s1")
    assert store.storylines["s1"]["category_id"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_categories.py -v`
Expected: FAIL with `ModuleNotFoundError: pipeline.categories`.

- [ ] **Step 3: Implement prompt, model call, stub, engine**

`pipeline/prompts.py` — after `build_theme_creator_prompt`:

```python
CATEGORY_CLASSIFIER_SYSTEM = (
    "You classify one US government news storyline into exactly one broad "
    "seeded category. " + CATEGORY_ASSIGNMENT_GUIDANCE +
    "You must copy exactly one category_id from the provided seeded "
    "categories; never invent a category or return null. "
    'Respond with JSON only: {"category_id": string, "reason": "one sentence"}'
)


def build_category_classifier_prompt(storyline: dict,
                                     categories: list[dict]) -> tuple[str, str]:
    user = (
        f"Storyline headline: {storyline['headline']}\n"
        f"Storyline summary: {storyline.get('summary') or '(none)'}\n\n"
        "Seeded categories (choose exactly one category_id):\n" +
        json.dumps(_shape_seed_categories(categories), indent=2)
    )
    return CATEGORY_CLASSIFIER_SYSTEM, user
```

`pipeline/ai.py` — after `create_theme_metadata` (add `build_category_classifier_prompt` to the prompts import):

```python
    def classify_category(self, storyline: dict,
                          categories: list[dict]) -> dict:
        """Assign one seeded category; the only stream-time topic label."""
        system, user = build_category_classifier_prompt(storyline, categories)
        try:
            parsed = _extract_json(self._chat(self.cfg.judge_model, system, user))
            return {
                "category_id": (str(parsed["category_id"])
                                if parsed.get("category_id") else None),
                "reason": str(parsed.get("reason", "")),
            }
        except Exception:
            self.errors["category_classifier"] += 1
            raise
```

`pipeline/stub.py` — after `create_theme_metadata`:

```python
    def classify_category(self, storyline: dict,
                          categories: list[dict]) -> dict:
        mine = _tokens(storyline["headline"] + " " + (storyline.get("summary") or ""))
        for category in categories:
            if mine & _tokens(category["display_name"]):
                return {"category_id": category["id"],
                        "reason": "stub: token overlap with category name"}
        if categories:
            return {"category_id": categories[0]["id"],
                    "reason": "stub: first seeded category fallback"}
        return {"category_id": None, "reason": "stub: no categories"}
```

Create `pipeline/categories.py`:

```python
"""Stage 3.5 — storyline category classification.

The broad seeded category is the only topic label assigned on the stream;
themes are born offline by the promotion sweep. Failure bias: a failed or
hallucinated verdict leaves category_id null, and the runner's end-of-run
retry loop picks it up.
"""

from __future__ import annotations

from pipeline.config import Config


class CategoryEngine:
    def __init__(self, store, models, cfg: Config) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg

    def classify(self, storyline_id: str, method: str = "classified") -> None:
        state = self.store.storyline_theme_state(storyline_id)
        if state is None or state.get("category_id") is not None:
            return
        categories = [c for c in self.store.all_categories()
                      if c.get("origin") == "seed"]
        if not categories:
            return
        storyline = {"headline": state.get("headline") or "(no card)",
                     "summary": state.get("summary") or ""}
        try:
            verdict = self.models.classify_category(storyline, categories)
        except Exception:
            return  # left null; retried at end of run
        chosen = verdict.get("category_id")
        if chosen in {str(c["id"]) for c in categories}:
            self.store.set_storyline_category(
                storyline_id, chosen, method=method,
                reason=verdict.get("reason") or None)
```

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_categories.py tests/test_prompts.py tests/test_ai.py tests/test_stub.py -v`
Expected: PASS (new tests green, existing prompt/ai/stub tests untouched).

- [ ] **Step 5: Commit**

```bash
git add pipeline/prompts.py pipeline/ai.py pipeline/stub.py pipeline/categories.py tests/test_categories.py
git commit -m "feat: stream-time category classifier (CategoryEngine)"
```

---

### Task 4: Attach-only ThemeEngine — criterion membership, spawn machinery deleted

**Files:**
- Modify: `pipeline/topics.py` (rewrite — file shrinks substantially)
- Modify: `pipeline/prompts.py` (delete `THEME_CREATOR_SYSTEM`, `build_theme_creator_prompt`, `THEME_ADJUDICATOR_SYSTEM`, `build_theme_adjudicator_prompt`, `THEME_PAIR_ADJUDICATOR_SYSTEM`, `build_theme_pair_adjudicator_prompt`; add membership prompt. Keep `THEME_SCOPE_GUIDANCE`, `CATEGORY_ASSIGNMENT_GUIDANCE`, `CATEGORY_DESCRIPTIONS`, `_shape_seed_categories` — Tasks 3/5 use them)
- Modify: `pipeline/ai.py` (delete `create_theme_metadata`, `adjudicate_theme`, `adjudicate_theme_pair`; add `adjudicate_membership`)
- Modify: `pipeline/stub.py` (delete `create_theme_metadata`, `adjudicate_theme`, `adjudicate_theme_pair`; add `adjudicate_membership`)
- Modify: `pipeline/config.py` (remove `theme_stick_floor` field and its `THEME_STICK_FLOOR` wiring — nothing reads it after this task)
- Modify: `pipeline/runner.py` (delete the end-of-run `unthemed_storyline_ids` retry loop and `reconcile_all()` call, lines ~170–176 — Task 6 installs the replacement; leave `theme_engine.sync` call sites)
- Modify: `tests/fakes.py` (delete fake `merge_theme` — orphaned), `pipeline/store.py` (delete `Store.merge_theme` and `Store.themed_storylines` if `grep -rn "themed_storylines\|merge_theme" pipeline/ tests/` shows no remaining consumers; the `merge_topic_theme` RPC stays in the DB — migrations are immutable)
- Test: `tests/test_topics.py` (rewrite), delete stale cases in `tests/test_prompts.py`/`tests/test_ai.py`/`tests/test_stub.py` that exercise the removed builders/methods

**Interfaces:**
- Consumes: `Store.all_themes` (now criterion-aware, demoted excluded), `Store.storyline_theme_state` (now with `category_id`/`newest_entry_at`), `Store.theme_member_centroids`, `Store.theme_recent_headlines`, `Store.assign_theme`; `cfg.theme_sim_floor`, `cfg.theme_knn_k`.
- Produces:
  - `ThemeEngine.sync(storyline_id: str) -> None` — attach-only, sticky, none-biased
  - `ThemeEngine.attach(storyline_id: str, vec: np.ndarray, theme_id: str, method: str, reason: str) -> None` — public; the promotion sweep (Task 5) reuses it with methods `"promoted"`/`"sweep_join"`
  - `valid_theme_name(name: str) -> bool` — module-level in `pipeline/topics.py` (was the `_valid_theme_name` staticmethod); Task 5 imports it
  - `WorkersAI.adjudicate_membership(storyline: dict, candidates: list[dict]) -> dict` returning `{"theme_id": str | None, "reason": str}` (raises on failure by design)
  - `StubModels.adjudicate_membership` — joins the first candidate whose name or criterion shares a token with the storyline headline, else `{"theme_id": None, ...}`

- [ ] **Step 1: Rewrite tests/test_topics.py (failing)**

Replace the file's tests (keep the `vec`/`CFG` helpers; `add_storyline` gains the category/time fields):

```python
from datetime import datetime, timezone

import numpy as np

from pipeline.config import Config
from pipeline.stub import StubModels
from pipeline.topics import ThemeEngine, valid_theme_name
from pipeline.vectors import pack_fp16
from tests.fakes import FakeStore

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             topics_enabled=True)


def vec(*hot):
    v = np.zeros(8, dtype=np.float32)
    for i in hot:
        v[i] = 1.0
    return v


def add_storyline(store, headline, v, theme_id=None, category_id="c-any"):
    sid = f"s-{len(store.storylines)}"
    store.storylines[sid] = {
        "id": sid, "entity_set": [], "event_keys": [], "episode_count": 1,
        "centroid": pack_fp16(v), "headline": headline, "summary": "",
        "theme_id": theme_id, "category_id": category_id,
        "newest_entry_at": T0, "first_entry_at": T0,
    }
    return sid


def add_theme(store, name, v, criterion):
    return store.create_theme(name, pack_fp16(v), "c-any", None, criterion)


def test_no_theme_above_floor_leaves_storyline_category_only():
    store = FakeStore()
    sid = add_storyline(store, "FDA recalls Valsatrex lots", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] is None
    assert store.themes == {}   # the stream path never creates themes


def test_storyline_joins_theme_whose_criterion_it_satisfies():
    store = FakeStore()
    theme_id = add_theme(store, "Drug Recall Enforcement", vec(0, 1),
                         "recalls of specific drugs after FDA safety reviews")
    sid = add_storyline(store, "FDA recalls Valsatrex lots", vec(0, 1, 2))
    ThemeEngine(store, StubModels(), CFG).sync(sid)
    s = store.storylines[sid]
    assert s["theme_id"] == theme_id
    assert s["theme_attach_method"] == "criterion_join"
    assert s["theme_similarity"] is not None
    assert store.themes[theme_id]["storyline_count"] == 1


def test_attach_is_cross_category():
    store = FakeStore()
    theme_id = store.create_theme("Drug Recall Enforcement", pack_fp16(vec(0, 1)),
                                  "c-health", None,
                                  "recalls of specific drugs after FDA safety reviews")
    sid = add_storyline(store, "FDA recalls Valsatrex lots", vec(0, 1, 2),
                        category_id="c-justice")
    ThemeEngine(store, StubModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] == theme_id


def test_attached_storyline_is_sticky():
    class ExplodingModels(StubModels):
        def adjudicate_membership(self, storyline, candidates):
            raise AssertionError("attached storylines must not re-adjudicate")

    store = FakeStore()
    theme_id = add_theme(store, "Drug Recall Enforcement", vec(0, 1),
                         "recalls of specific drugs")
    sid = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1),
                        theme_id=theme_id)
    ThemeEngine(store, ExplodingModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] == theme_id


def test_adjudicator_failure_attaches_nothing():
    class BrokenModels(StubModels):
        def adjudicate_membership(self, storyline, candidates):
            raise RuntimeError("membership boom")

    store = FakeStore()
    add_theme(store, "Drug Recall Enforcement", vec(0, 1),
              "recalls of specific drugs")
    sid = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1, 2))
    ThemeEngine(store, BrokenModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] is None


def test_hallucinated_theme_id_attaches_nothing():
    class HallucinatingModels(StubModels):
        def adjudicate_membership(self, storyline, candidates):
            return {"theme_id": "t-invented", "reason": "made up"}

    store = FakeStore()
    add_theme(store, "Drug Recall Enforcement", vec(0, 1),
              "recalls of specific drugs")
    sid = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1, 2))
    ThemeEngine(store, HallucinatingModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] is None


def test_none_verdict_leaves_storyline_unattached():
    class NoneModels(StubModels):
        def adjudicate_membership(self, storyline, candidates):
            return {"theme_id": None, "reason": "does not satisfy criterion"}

    store = FakeStore()
    add_theme(store, "Drug Recall Enforcement", vec(0, 1),
              "recalls of specific drugs")
    sid = add_storyline(store, "IRS deadline moves", vec(0, 1))
    ThemeEngine(store, NoneModels(), CFG).sync(sid)
    assert store.storylines[sid]["theme_id"] is None


def test_valid_theme_name_rules():
    assert valid_theme_name("Drug Recall Enforcement")
    assert not valid_theme_name("One")
    assert not valid_theme_name("way too many words in this label")
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_topics.py -v`
Expected: FAIL — `valid_theme_name` not importable, stub lacks `adjudicate_membership`.

- [ ] **Step 3: Add the membership prompt**

`pipeline/prompts.py` — replace `THEME_ADJUDICATOR_SYSTEM`/`build_theme_adjudicator_prompt` with:

```python
THEME_MEMBERSHIP_SYSTEM = (
    "You decide whether one US government news storyline belongs to one of "
    "the candidate topic themes. Each candidate carries an inclusion "
    "criterion: a one-sentence membership rule written when the theme was "
    "created. Join a candidate only when the storyline clearly satisfies its "
    "inclusion criterion; a shared agency, entity, or press-release "
    "boilerplate is not enough. Creating themes is not your job, and joining "
    "nothing is a normal, correct outcome — when unsure, answer null. "
    'Respond with JSON only: {"theme_id": string or null (copy one candidate '
    "theme_id verbatim, only when the storyline clearly satisfies that "
    'candidate\'s criterion), "reason": "one sentence"}'
)


def build_theme_membership_prompt(storyline: dict,
                                  candidates: list[dict]) -> tuple[str, str]:
    shaped = [
        {"theme_id": c["theme_id"], "name": c["name"],
         "inclusion_criterion": c["inclusion_criterion"],
         "storyline_count": c["storyline_count"],
         "recent_headlines": c["recent_headlines"],
         "days_since_active": c["days_since_active"]}
        for c in candidates
    ]
    user = (
        f"Storyline headline: {storyline['headline']}\n"
        f"Storyline summary: {storyline.get('summary') or '(none)'}\n\n"
        "Candidate themes:\n" + json.dumps(shaped, indent=2)
    )
    return THEME_MEMBERSHIP_SYSTEM, user
```

Delete `THEME_CREATOR_SYSTEM`, `build_theme_creator_prompt`, `THEME_PAIR_ADJUDICATOR_SYSTEM`, `build_theme_pair_adjudicator_prompt`.

- [ ] **Step 4: Swap the model calls**

`pipeline/ai.py` — delete `create_theme_metadata`, `adjudicate_theme`, `adjudicate_theme_pair`; add (and fix the prompts import list):

```python
    def adjudicate_membership(self, storyline: dict,
                              candidates: list[dict]) -> dict:
        # raises on failure by design: the stream path is none-biased and skips
        system, user = build_theme_membership_prompt(storyline, candidates)
        parsed = _extract_json(self._chat(self.cfg.judge_model, system, user))
        return {
            "theme_id": str(parsed["theme_id"]) if parsed.get("theme_id") else None,
            "reason": str(parsed.get("reason", "")),
        }
```

`pipeline/stub.py` — delete the three theme methods; add:

```python
    def adjudicate_membership(self, storyline: dict,
                              candidates: list[dict]) -> dict:
        mine = _tokens(storyline["headline"] + " " +
                       (storyline.get("summary") or ""))
        for candidate in candidates:
            theirs = _tokens(candidate["name"] + " " +
                             (candidate.get("inclusion_criterion") or ""))
            if mine & theirs:
                return {"theme_id": candidate["theme_id"],
                        "reason": "stub: token overlap with criterion"}
        return {"theme_id": None, "reason": "stub: no criterion satisfied"}
```

- [ ] **Step 5: Rewrite pipeline/topics.py**

Replace the file body:

```python
"""Stage 4 — topic themes, attach-only stream path.

Themes are born offline by the promotion sweep (pipeline/promotion.py); the
stream path may only attach a storyline to an existing theme whose inclusion
criterion it satisfies. Attachment is cross-category and sticky: attached
storylines never re-adjudicate; only demotion detaches. Failure bias: a
failed or hallucinated verdict never attaches.
"""

from __future__ import annotations

import numpy as np

from pipeline.config import Config
from pipeline.vectors import cosine, pack_fp16


def valid_theme_name(name: str) -> bool:
    words = name.split()
    if not 2 <= len(words) <= 5:
        return False
    return all(
        word[0].isalnum() and word.replace("&", "").replace("-", "").isalnum()
        for word in words
    )


class ThemeEngine:
    def __init__(self, store, models, cfg: Config) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg

    def sync(self, storyline_id: str) -> None:
        state = self.store.storyline_theme_state(storyline_id)
        if state is None or state["centroid"] is None \
                or state["theme_id"] is not None:
            return  # sticky: attached storylines never move on the stream path
        vec = state["centroid"]
        themes = [t for t in self.store.all_themes()
                  if t["centroid"] is not None]
        scored = sorted(((cosine(vec, t["centroid"]), t) for t in themes),
                        key=lambda pair: -pair[0])
        top = [(sim, t) for sim, t in scored
               if sim >= self.cfg.theme_sim_floor][:self.cfg.theme_knn_k]
        if not top:
            return  # category-only; the promotion sweep owns theme creation

        storyline = {"headline": state.get("headline") or "(no card)",
                     "summary": state.get("summary") or ""}
        candidates = [self._shape_candidate(t, state.get("newest_entry_at"))
                      for _, t in top]
        try:
            verdict = self.models.adjudicate_membership(storyline, candidates)
        except Exception:
            return  # none-biased: a failed verdict never attaches
        target = verdict.get("theme_id")
        if target in {c["theme_id"] for c in candidates}:
            self.attach(storyline_id, vec, target, "criterion_join",
                        verdict.get("reason") or "criterion satisfied")

    def attach(self, storyline_id: str, vec: np.ndarray, theme_id: str,
               method: str, reason: str) -> None:
        theme = next((t for t in self.store.all_themes()
                      if str(t["id"]) == theme_id), None)
        sim = (cosine(vec, theme["centroid"])
               if theme is not None and theme["centroid"] is not None else None)
        members = self.store.theme_member_centroids(theme_id)
        new_centroid = np.mean(members + [vec], axis=0) if members else vec
        self.store.assign_theme(
            storyline_id, theme_id, method=method, similarity=sim,
            reason=reason, theme_centroid=pack_fp16(new_centroid),
            theme_display_name=None)

    def _shape_candidate(self, theme: dict, event_time) -> dict:
        days = None
        newest = theme.get("newest_storyline_at")
        if event_time is not None and newest is not None:
            days = max(0, int((event_time - newest).total_seconds() // 86400))
        return {"theme_id": str(theme["id"]), "name": theme["display_name"],
                "inclusion_criterion": theme.get("inclusion_criterion") or "",
                "storyline_count": theme["storyline_count"],
                "recent_headlines": self.store.theme_recent_headlines(
                    str(theme["id"])),
                "days_since_active": days}
```

- [ ] **Step 6: Remove the orphans**

- `pipeline/config.py`: delete `theme_stick_floor: float = 0.50` and the `theme_stick_floor=_f("THEME_STICK_FLOOR", ...)` line.
- `pipeline/runner.py`: delete lines ~170–176 (the `unthemed_storyline_ids` retry loop and `theme_engine.reconcile_all()` with their comment). Task 6 installs the replacement.
- Run `grep -rn "reconcile_all\|adjudicate_theme\|create_theme_metadata\|theme_stick_floor\|merge_theme\|themed_storylines\|build_theme_creator\|build_theme_adjudicator\|build_theme_pair" pipeline/ tests/` — for each hit in tests, delete the stale test case (they test deleted behavior); for `Store.merge_theme`/`FakeStore.merge_theme`/`Store.themed_storylines`, delete the methods if the grep shows no remaining consumers.

- [ ] **Step 7: Run the suite**

Run: `uv run pytest -v`
Expected: PASS everywhere except `tests/test_cluster_phase.py::test_cluster_with_topics_enabled_assigns_every_storyline_a_theme` (asserts the old spawn behavior) — replace that test now with its Task 6 counterpart's weaker form:

```python
def test_cluster_with_topics_enabled_never_spawns_themes_on_stream():
    store = TopicClusterFakeStore()
    add(store, 1, 0, 0)
    add(store, 2, 30, 3, entities=("oxprenol",))
    cluster(store, StubModels(), Config(
        database_url="x", cf_account_id="a", cf_api_token="t",
        topics_enabled=True))
    assert store.themes == {}
```

(If this test errors because `cluster()` still expects theme retry plumbing, adjust only what Step 6's runner deletion touched.)

- [ ] **Step 8: Commit**

```bash
git add pipeline/topics.py pipeline/prompts.py pipeline/ai.py pipeline/stub.py pipeline/config.py pipeline/runner.py pipeline/store.py tests/
git commit -m "feat!: attach-only theme stream path — spawn/merge/reconcile machinery removed"
```

---

### Task 5: Promotion sweep — gate, judge, demotion review

**Files:**
- Create: `pipeline/promotion.py`
- Modify: `pipeline/config.py` (six knobs), `pipeline/prompts.py` (promotion + review prompts), `pipeline/ai.py` (`judge_promotion`, `review_theme`), `pipeline/stub.py` (same)
- Test: `tests/test_promotion.py` (create), `tests/test_config.py` (extend if it enumerates knobs — mirror its existing pattern)

**Interfaces:**
- Consumes: `Store.categorized_unthemed`, `Store.all_themes`, `Store.theme_member_centroids`, `Store.theme_recent_headlines`, `Store.create_theme`, `Store.demote_theme` (Task 2); `ThemeEngine.attach`, `ThemeEngine.sync`, `valid_theme_name` (Task 4).
- Produces:
  - Config fields (defaults are uncalibrated placeholders): `theme_promotion_min_storylines: int = 4`, `theme_promotion_min_active_days: int = 3`, `theme_promotion_cohesion_floor: float = 0.55`, `theme_promotion_cluster_floor: float = 0.60`, `theme_demotion_cohesion_floor: float = 0.40`, `theme_sweep_interval_hours: float = 24.0`; env overrides `THEME_PROMOTION_MIN_STORYLINES`, `THEME_PROMOTION_MIN_ACTIVE_DAYS`, `THEME_PROMOTION_COHESION_FLOOR`, `THEME_PROMOTION_CLUSTER_FLOOR`, `THEME_DEMOTION_COHESION_FLOOR`, `THEME_SWEEP_INTERVAL_HOURS`.
  - `PromotionSweep(store, models, cfg, theme_engine).run(as_of: datetime) -> dict` returning counts `{"mopped_up", "promoted", "attached_existing", "rejected", "demoted"}`. Task 6 calls this from the runner.
  - `WorkersAI.judge_promotion(dossier: dict) -> dict` returning `{"verdict": "promote"|"attach_existing"|"reject", "theme_name": str|None, "inclusion_criterion": str|None, "theme_id": str|None, "reason": str}` (raises on failure).
  - `WorkersAI.review_theme(dossier: dict) -> dict` returning `{"verdict": "keep"|"demote", "reason": str}` (raises on failure; caller keeps on failure).
  - Stub equivalents (deterministic): `judge_promotion` answers `attach_existing` when an existing theme's name shares a token with the first member headline, else `promote` with name = first 4 headline words and criterion `"stub: storylines about <name>"`; `review_theme` answers `demote` when `dossier["cohesion"] < 0.2` else `keep`.

- [ ] **Step 1: Add config knobs**

`pipeline/config.py` — after `theme_knn_k: int = 5`:

```python
    theme_promotion_min_storylines: int = 4
    theme_promotion_min_active_days: int = 3
    theme_promotion_cohesion_floor: float = 0.55   # placeholder, calibrate on golden window
    theme_promotion_cluster_floor: float = 0.60    # ditto
    theme_demotion_cohesion_floor: float = 0.40    # ditto
    theme_sweep_interval_hours: float = 24.0
```

and in `load_config()` after `theme_knn_k=...`:

```python
        theme_promotion_min_storylines=int(os.environ.get(
            "THEME_PROMOTION_MIN_STORYLINES", Config.theme_promotion_min_storylines)),
        theme_promotion_min_active_days=int(os.environ.get(
            "THEME_PROMOTION_MIN_ACTIVE_DAYS", Config.theme_promotion_min_active_days)),
        theme_promotion_cohesion_floor=_f(
            "THEME_PROMOTION_COHESION_FLOOR", Config.theme_promotion_cohesion_floor),
        theme_promotion_cluster_floor=_f(
            "THEME_PROMOTION_CLUSTER_FLOOR", Config.theme_promotion_cluster_floor),
        theme_demotion_cohesion_floor=_f(
            "THEME_DEMOTION_COHESION_FLOOR", Config.theme_demotion_cohesion_floor),
        theme_sweep_interval_hours=_f(
            "THEME_SWEEP_INTERVAL_HOURS", Config.theme_sweep_interval_hours),
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_promotion.py`:

```python
from datetime import datetime, timedelta, timezone

import numpy as np

from pipeline.config import Config
from pipeline.promotion import PromotionSweep
from pipeline.stub import StubModels
from pipeline.topics import ThemeEngine
from pipeline.vectors import pack_fp16
from tests.fakes import FakeStore

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             topics_enabled=True, theme_promotion_min_storylines=3,
             theme_promotion_min_active_days=2,
             theme_promotion_cohesion_floor=0.5,
             theme_promotion_cluster_floor=0.5,
             # two-member theme below: cohesion = (1.0 + 0.0)/2 = 0.5, so the
             # review trigger needs a floor above that
             theme_demotion_cohesion_floor=0.6)


def vec(*hot):
    v = np.zeros(8, dtype=np.float32)
    for i in hot:
        v[i] = 1.0
    return v


def add_storyline(store, headline, v, day=0, category_id="c-health"):
    sid = f"s-{len(store.storylines)}"
    t = T0 + timedelta(days=day)
    store.storylines[sid] = {
        "id": sid, "entity_set": [], "event_keys": [], "episode_count": 1,
        "centroid": pack_fp16(v), "headline": headline, "summary": "",
        "theme_id": None, "category_id": category_id,
        "newest_entry_at": t, "first_entry_at": t,
    }
    return sid


def sweep(store, models=None, cfg=CFG):
    models = models or StubModels()
    return PromotionSweep(store, models, cfg,
                          ThemeEngine(store, models, cfg)).run(
        as_of=T0 + timedelta(days=10))


def test_cluster_crossing_gate_is_promoted_with_criterion():
    store = FakeStore()
    ids = [add_storyline(store, f"measles outbreak update {i}", vec(0, 1), day=i)
           for i in range(3)]
    report = sweep(store)
    assert report["promoted"] == 1
    theme = next(iter(store.themes.values()))
    assert theme["inclusion_criterion"].startswith("stub:")
    assert all(store.storylines[s]["theme_id"] == theme["id"] for s in ids)
    assert store.storylines[ids[0]]["theme_attach_method"] == "promoted"


def test_small_cluster_stays_category_resident():
    store = FakeStore()
    add_storyline(store, "measles outbreak update", vec(0, 1), day=0)
    add_storyline(store, "measles outbreak follow-up", vec(0, 1), day=1)
    report = sweep(store)
    assert report["promoted"] == 0
    assert store.themes == {}


def test_single_day_burst_fails_persistence_gate():
    store = FakeStore()
    for i in range(4):
        add_storyline(store, f"measles outbreak update {i}", vec(0, 1), day=0)
    assert sweep(store)["promoted"] == 0


def test_cluster_matching_existing_theme_attaches_instead_of_duplicating():
    store = FakeStore()
    theme_id = store.create_theme("Measles Outbreak Response",
                                  pack_fp16(vec(0, 1)), "c-health", None,
                                  "storylines about the measles outbreak")
    ids = [add_storyline(store, f"measles outbreak update {i}", vec(0, 1), day=i)
           for i in range(3)]
    report = sweep(store)
    assert report["attached_existing"] == 1
    assert len(store.themes) == 1
    assert all(store.storylines[s]["theme_id"] == theme_id for s in ids)
    assert store.storylines[ids[0]]["theme_attach_method"] == "sweep_join"


def test_judge_failure_promotes_nothing():
    class BrokenJudge(StubModels):
        def judge_promotion(self, dossier):
            raise RuntimeError("judge boom")

    store = FakeStore()
    for i in range(3):
        add_storyline(store, f"measles outbreak update {i}", vec(0, 1), day=i)
    report = sweep(store, models=BrokenJudge())
    assert report["promoted"] == 0
    assert store.themes == {}


def test_low_cohesion_theme_is_demotion_reviewed_and_demoted():
    class AlwaysDemote(StubModels):
        def review_theme(self, dossier):
            return {"verdict": "demote", "reason": "test"}

    store = FakeStore()
    theme_id = store.create_theme("Scattered Grab Bag", pack_fp16(vec(0)),
                                  "c-health", None, "unrelated things")
    a = add_storyline(store, "alpha", vec(0))
    b = add_storyline(store, "omega", vec(7))
    store.assign_theme(a, theme_id, "promoted", None, "seed", None, None)
    store.assign_theme(b, theme_id, "promoted", None, "seed", None, None)
    report = sweep(store, models=AlwaysDemote())
    assert report["demoted"] == 1
    assert store.all_themes() == []
    assert store.storylines[a]["theme_id"] is None


def test_review_failure_never_demotes():
    class BrokenReview(StubModels):
        def review_theme(self, dossier):
            raise RuntimeError("review boom")

    store = FakeStore()
    theme_id = store.create_theme("Scattered Grab Bag", pack_fp16(vec(0)),
                                  "c-health", None, "unrelated things")
    a = add_storyline(store, "alpha", vec(0))
    b = add_storyline(store, "omega", vec(7))
    store.assign_theme(a, theme_id, "promoted", None, "seed", None, None)
    store.assign_theme(b, theme_id, "promoted", None, "seed", None, None)
    assert sweep(store, models=BrokenReview())["demoted"] == 0
    assert len(store.all_themes()) == 1
```

- [ ] **Step 3: Run to verify failure**

Run: `uv run pytest tests/test_promotion.py -v`
Expected: FAIL with `ModuleNotFoundError: pipeline.promotion`.

- [ ] **Step 4: Add prompts**

`pipeline/prompts.py` — after `build_theme_membership_prompt`:

```python
THEME_PROMOTION_SYSTEM = (
    "You review a cluster of US government news storylines that grew inside "
    "one broad category and decide whether the relationships between them "
    "justify a durable topic theme. Promote only when the storylines share a "
    "recurring subject that will plausibly keep producing distinct events; a "
    "shared category, agency, or press-release boilerplate is not enough. If "
    "an existing theme listed under existing_themes already covers this "
    "subject, answer attach_existing with its theme_id instead of creating a "
    "duplicate. When promoting, name the theme with this rubric: " +
    THEME_SCOPE_GUIDANCE +
    "Also write inclusion_criterion: one sentence stating the rule a future "
    "storyline must satisfy to join this theme; describe the recurring "
    "subject, not the current members. "
    'Respond with JSON only: {"verdict": "promote" or "attach_existing" or '
    '"reject", "theme_name": string or null (only when promote), '
    '"inclusion_criterion": string or null (only when promote), '
    '"theme_id": string or null (copy an existing_themes theme_id verbatim, '
    'only when attach_existing), "reason": "one sentence"}'
)


def build_theme_promotion_prompt(dossier: dict) -> tuple[str, str]:
    return THEME_PROMOTION_SYSTEM, json.dumps(dossier, indent=2, default=str)


THEME_REVIEW_SYSTEM = (
    "You review one existing US government news topic theme whose members "
    "have drifted apart geometrically. Decide whether the theme still names "
    "one recurring subject its members satisfy (keep), or whether it should "
    "be demoted so its storylines fall back to their broad categories "
    "(demote). Demotion is safe and reversible; keeping a polluted theme is "
    "not. "
    'Respond with JSON only: {"verdict": "keep" or "demote", '
    '"reason": "one sentence"}'
)


def build_theme_review_prompt(dossier: dict) -> tuple[str, str]:
    return THEME_REVIEW_SYSTEM, json.dumps(dossier, indent=2, default=str)
```

- [ ] **Step 5: Add model calls and stubs**

`pipeline/ai.py`:

```python
    def judge_promotion(self, dossier: dict) -> dict:
        # raises on failure by design: a failed verdict never births a theme
        system, user = build_theme_promotion_prompt(dossier)
        try:
            parsed = _extract_json(self._chat(self.cfg.judge_model, system, user))
            return {
                "verdict": str(parsed.get("verdict") or ""),
                "theme_name": (str(parsed["theme_name"])
                               if parsed.get("theme_name") else None),
                "inclusion_criterion": (str(parsed["inclusion_criterion"])
                                        if parsed.get("inclusion_criterion") else None),
                "theme_id": str(parsed["theme_id"]) if parsed.get("theme_id") else None,
                "reason": str(parsed.get("reason", "")),
            }
        except Exception:
            self.errors["theme_promotion"] += 1
            raise

    def review_theme(self, dossier: dict) -> dict:
        # raises on failure by design: a failed verdict never demotes
        system, user = build_theme_review_prompt(dossier)
        try:
            parsed = _extract_json(self._chat(self.cfg.judge_model, system, user))
            return {"verdict": str(parsed.get("verdict") or ""),
                    "reason": str(parsed.get("reason", ""))}
        except Exception:
            self.errors["theme_review"] += 1
            raise
```

`pipeline/stub.py`:

```python
    def judge_promotion(self, dossier: dict) -> dict:
        first = dossier["members"][0]["headline"]
        mine = _tokens(first)
        for theme in dossier.get("existing_themes") or []:
            if mine & _tokens(theme["name"]):
                return {"verdict": "attach_existing", "theme_name": None,
                        "inclusion_criterion": None,
                        "theme_id": theme["theme_id"],
                        "reason": "stub: existing theme name overlap"}
        name = " ".join(first.split()[:4])
        return {"verdict": "promote", "theme_name": name,
                "inclusion_criterion": f"stub: storylines about {name}",
                "theme_id": None, "reason": "stub: promote cluster"}

    def review_theme(self, dossier: dict) -> dict:
        if dossier["cohesion"] < 0.2:
            return {"verdict": "demote", "reason": "stub: cohesion collapsed"}
        return {"verdict": "keep", "reason": "stub: cohesion acceptable"}
```

- [ ] **Step 6: Implement pipeline/promotion.py**

```python
"""Stage 5 — theme promotion sweep.

Themes are born here, never on the stream. Cadence: the runner calls run()
every theme_sweep_interval_hours of event time and once at end of run.
Order per sweep: (1) mop-up — category-resident storylines get one more
criterion-membership pass against existing themes; (2) greedy within-category
clustering of what remains; (3) three-axis gate (size, persistence, cohesion)
filters clusters; (4) the promotion judge names the theme and writes its
inclusion criterion, or routes the cluster onto an existing theme instead of
minting a duplicate; (5) naive demotion review — themes whose member cohesion
collapsed get an LLM keep/demote verdict. Failure bias: judge or review
failure changes nothing.
"""

from __future__ import annotations

from datetime import datetime

import numpy as np

from pipeline.config import Config
from pipeline.topics import ThemeEngine, valid_theme_name
from pipeline.vectors import cosine, pack_fp16

_MAX_NAME = 256
_MAX_CRITERION = 1024
_EXISTING_THEME_CANDIDATES = 3
_DOSSIER_MEMBER_CAP = 12


class PromotionSweep:
    def __init__(self, store, models, cfg: Config,
                 theme_engine: ThemeEngine) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg
        self.theme_engine = theme_engine

    def run(self, as_of: datetime) -> dict:
        counts = {"mopped_up": 0, "promoted": 0, "attached_existing": 0,
                  "rejected": 0, "demoted": 0}
        self._mop_up(counts)
        residents = self.store.categorized_unthemed()
        by_category: dict[str, list[dict]] = {}
        for row in residents:
            by_category.setdefault(row["category_id"], []).append(row)
        for category_id, rows in by_category.items():
            others = [r for r in residents if r["category_id"] != category_id]
            for cluster in self._clusters(rows):
                cohesion = self._gate(cluster)
                if cohesion is None:
                    continue
                self._judge(cluster, cohesion, category_id, others, as_of,
                            counts)
        self._review_themes(counts)
        return counts

    # -- mop-up ----------------------------------------------------------

    def _mop_up(self, counts: dict) -> None:
        for row in self.store.categorized_unthemed():
            self.theme_engine.sync(row["id"])
            state = self.store.storyline_theme_state(row["id"])
            if state is not None and state["theme_id"] is not None:
                counts["mopped_up"] += 1

    # -- clustering + gate -------------------------------------------------

    def _clusters(self, rows: list[dict]) -> list[dict]:
        clusters: list[dict] = []
        for row in rows:  # rows arrive ordered by first_entry_at
            best, best_sim = None, -1.0
            for cluster in clusters:
                sim = cosine(row["centroid"], cluster["centroid"])
                if sim > best_sim:
                    best, best_sim = cluster, sim
            if best is not None \
                    and best_sim >= self.cfg.theme_promotion_cluster_floor:
                best["members"].append(row)
                best["centroid"] = np.mean(
                    [m["centroid"] for m in best["members"]], axis=0)
            else:
                clusters.append({"members": [row],
                                 "centroid": row["centroid"]})
        return clusters

    def _gate(self, cluster: dict) -> float | None:
        members = cluster["members"]
        if len(members) < self.cfg.theme_promotion_min_storylines:
            return None
        days = {m["first_entry_at"].date() for m in members
                if m["first_entry_at"] is not None}
        if len(days) < self.cfg.theme_promotion_min_active_days:
            return None
        cohesion = float(np.mean(
            [cosine(m["centroid"], cluster["centroid"]) for m in members]))
        if cohesion < self.cfg.theme_promotion_cohesion_floor:
            return None
        return cohesion

    # -- judgment ----------------------------------------------------------

    def _judge(self, cluster: dict, cohesion: float, category_id: str,
               others: list[dict], as_of: datetime, counts: dict) -> None:
        existing = self._existing_themes(cluster["centroid"], as_of)
        near_misses = [
            o for o in others
            if cosine(o["centroid"], cluster["centroid"])
            >= self.cfg.theme_promotion_cluster_floor
        ]
        dossier = {
            "members": [
                {"headline": m["headline"], "summary": (m["summary"] or "")[:400],
                 "first_entry_at": m["first_entry_at"]}
                for m in cluster["members"][:_DOSSIER_MEMBER_CAP]
            ],
            "member_count": len(cluster["members"]),
            "active_days": len({m["first_entry_at"].date()
                                for m in cluster["members"]
                                if m["first_entry_at"] is not None}),
            "cohesion": round(cohesion, 3),
            "cross_category_candidates": [
                {"headline": o["headline"]} for o in near_misses[:5]
            ],
            "existing_themes": existing,
        }
        try:
            verdict = self.models.judge_promotion(dossier)
        except Exception:
            counts["rejected"] += 1  # failure bias: no birth this sweep
            return
        if verdict.get("verdict") == "attach_existing" \
                and verdict.get("theme_id") in {t["theme_id"] for t in existing}:
            for m in cluster["members"]:
                self.theme_engine.attach(
                    m["id"], m["centroid"], verdict["theme_id"], "sweep_join",
                    verdict.get("reason") or "sweep: matched existing theme")
            counts["attached_existing"] += 1
            return
        if verdict.get("verdict") != "promote":
            counts["rejected"] += 1
            return
        name = (verdict.get("theme_name") or "").strip()[:_MAX_NAME]
        criterion = (verdict.get("inclusion_criterion") or "").strip()[:_MAX_CRITERION]
        if not valid_theme_name(name) or not criterion:
            counts["rejected"] += 1  # invalid judge output never births
            return
        theme_id = self.store.create_theme(
            name, pack_fp16(cluster["centroid"]), category_id=category_id,
            name_model=getattr(self.cfg, "judge_model", None),
            inclusion_criterion=criterion)
        for m in cluster["members"]:
            self.theme_engine.attach(
                m["id"], m["centroid"], theme_id, "promoted",
                verdict.get("reason") or "promotion sweep: cluster crossed gate")
        for o in near_misses:
            self.theme_engine.sync(o["id"])  # criterion check vs the newborn
        counts["promoted"] += 1

    def _existing_themes(self, centroid: np.ndarray,
                         as_of: datetime) -> list[dict]:
        themes = [t for t in self.store.all_themes()
                  if t["centroid"] is not None]
        scored = sorted(((cosine(centroid, t["centroid"]), t) for t in themes),
                        key=lambda pair: -pair[0])
        shaped = []
        for sim, theme in scored[:_EXISTING_THEME_CANDIDATES]:
            if sim < self.cfg.theme_sim_floor:
                break
            newest = theme.get("newest_storyline_at")
            days = (max(0, int((as_of - newest).total_seconds() // 86400))
                    if newest is not None else None)
            shaped.append({"theme_id": str(theme["id"]),
                           "name": theme["display_name"],
                           "inclusion_criterion":
                               theme.get("inclusion_criterion") or "",
                           "storyline_count": theme["storyline_count"],
                           "days_since_active": days})
        return shaped

    # -- demotion review -----------------------------------------------------

    def _review_themes(self, counts: dict) -> None:
        for theme in self.store.all_themes():
            if theme["centroid"] is None or theme["storyline_count"] < 2:
                continue
            members = self.store.theme_member_centroids(str(theme["id"]))
            if not members:
                continue
            cohesion = float(np.mean(
                [cosine(v, theme["centroid"]) for v in members]))
            if cohesion >= self.cfg.theme_demotion_cohesion_floor:
                continue
            dossier = {"name": theme["display_name"],
                       "inclusion_criterion":
                           theme.get("inclusion_criterion") or "",
                       "cohesion": round(cohesion, 3),
                       "storyline_count": theme["storyline_count"],
                       "recent_headlines": self.store.theme_recent_headlines(
                           str(theme["id"]), limit=5)}
            try:
                verdict = self.models.review_theme(dossier)
            except Exception:
                continue  # failure bias: never demote on error
            if verdict.get("verdict") == "demote":
                self.store.demote_theme(str(theme["id"]))
                counts["demoted"] += 1
```

- [ ] **Step 7: Run tests**

Run: `uv run pytest tests/test_promotion.py tests/test_config.py -v`
Expected: PASS. (One stub-behavior check while here: `test_cluster_crossing_gate_is_promoted_with_criterion` requires the stub judge's `promote` name to pass `valid_theme_name` — "measles outbreak update 0" → 4 words, valid.)

- [ ] **Step 8: Commit**

```bash
git add pipeline/promotion.py pipeline/config.py pipeline/prompts.py pipeline/ai.py pipeline/stub.py tests/test_promotion.py tests/test_config.py
git commit -m "feat: promotion sweep — gated theme birth, criterion authorship, naive demotion review"
```

---

### Task 6: Runner integration — category hook, event-time sweep cadence, report

**Files:**
- Modify: `pipeline/runner.py` (`cluster()`, lines ~126–180)
- Test: `tests/test_cluster_phase.py` (extend)

**Interfaces:**
- Consumes: `CategoryEngine.classify` (Task 3), `ThemeEngine.sync` (Task 4), `PromotionSweep.run` (Task 5), `Store.uncategorized_storyline_ids` (Task 2), `cfg.theme_sweep_interval_hours`.
- Produces: `cluster()` report gains `"theme_sweeps": int` and `"theme_sweep_totals": dict` (summed counts across sweeps). Stream order per storyline event: classify category, then theme sync. End of run: retry uncategorized (method `"retry"`), final sweep.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_cluster_phase.py` (reuse `TopicClusterFakeStore`, `add`, `T0`; `StubModels` import already needed by the Task 4 replacement test). Two determinism guards baked in: the fake needs storyline timestamps for the persistence gate (real `assign_storyline_theme`/episode RPCs maintain `first_entry_at`/`newest_entry_at`; `FakeStore.create_episode` doesn't), and the promotion judge is overridden so the test never depends on stub-generated headline text passing `valid_theme_name`:

```python
class SweepClusterFakeStore(TopicClusterFakeStore):
    """+ storyline first/newest_entry_at, which the real RPCs maintain and
    the promotion persistence gate reads."""

    def attach_entry(self, entry_id, episode_id, *args, **kw):
        result = super().attach_entry(entry_id, episode_id, *args, **kw)
        story_id = self.episodes[episode_id]["storyline_id"]
        t = self.entries[entry_id]["published_at"]
        story = self.storylines[story_id]
        story["first_entry_at"] = min(story.get("first_entry_at") or t, t)
        story["newest_entry_at"] = max(story.get("newest_entry_at") or t, t)
        return result


class PromoteJudgeModels(StubModels):
    """Deterministic promotion verdict; everything else stays stub."""

    def judge_promotion(self, dossier):
        return {"verdict": "promote", "theme_name": "Recurring Item Updates",
                "inclusion_criterion": "storylines about recurring item updates",
                "theme_id": None, "reason": "test: always promote"}


def test_cluster_categorizes_storylines_and_final_sweep_promotes():
    store = SweepClusterFakeStore()
    store.categories["c-health"] = {
        "id": "c-health", "display_name": "Public Health", "origin": "seed"}
    # four entries spread over 4 days; distinct entities keep them as
    # separate episodes/storylines so the size gate has members to count
    for i, hours in enumerate((0, 26, 52, 78)):
        add(store, i, hours, 0, entities=(f"uniq{i}",))
    cfg = Config(
        database_url="x", cf_account_id="a", cf_api_token="t",
        topics_enabled=True, theme_promotion_min_storylines=2,
        theme_promotion_min_active_days=2,
        theme_promotion_cohesion_floor=0.0,
        # stub overview embeddings are token-hash based, so near-duplicate
        # titles cluster loosely; floor low enough to group them
        theme_promotion_cluster_floor=0.05,
        theme_sweep_interval_hours=24.0)
    report = cluster(store, PromoteJudgeModels(), cfg)

    assert all(s.get("category_id") == "c-health"
               for s in store.storylines.values())
    assert report["theme_sweeps"] >= 2          # interval sweeps + final sweep
    assert report["theme_sweep_totals"]["promoted"] >= 1
    themed = [s for s in store.storylines.values() if s.get("theme_id")]
    assert themed                               # promotion attached members
    theme = next(iter(store.all_themes()))
    assert theme["inclusion_criterion"] == \
        "storylines about recurring item updates"
```

(If `FakeStore.create_episode`'s episodes dict keys its storyline differently than `["storyline_id"]`, mirror whatever key it actually uses — check `tests/fakes.py:33`.)

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_cluster_phase.py -v`
Expected: new test FAILS (`KeyError: 'theme_sweeps'`); pre-existing tests PASS.

- [ ] **Step 3: Wire the runner**

`pipeline/runner.py`:

Imports — add:

```python
from datetime import timedelta

from pipeline.categories import CategoryEngine
from pipeline.promotion import PromotionSweep
```

Engine construction (line ~127) — replace the single `theme_engine` line:

```python
    theme_engine = ThemeEngine(replay, models, cfg) if cfg.topics_enabled else None
    category_engine = CategoryEngine(replay, models, cfg) if cfg.topics_enabled else None
    promotion = (PromotionSweep(replay, models, cfg, theme_engine)
                 if cfg.topics_enabled else None)
    sweep_totals = {"mopped_up": 0, "promoted": 0, "attached_existing": 0,
                    "rejected": 0, "demoted": 0}
    sweep_runs = 0
    last_sweep_at = rows[0]["published_at"] if rows else None
```

Both storyline-close sites (the mid-run `close_due` loop and the finalize loop) — replace `theme_engine.sync(...)` with classify-then-sync:

```python
            if theme_engine is not None:
                category_engine.classify(str(closed["storyline_id"]))
                theme_engine.sync(str(closed["storyline_id"]))
```

(and the finalize twin with `episode["storyline_id"]`.)

Sweep cadence — at the end of the per-row loop body (after `processed += 1`):

```python
        if promotion is not None and last_sweep_at is not None \
                and t - last_sweep_at >= timedelta(
                    hours=cfg.theme_sweep_interval_hours):
            for key, value in promotion.run(t).items():
                sweep_totals[key] += value
            sweep_runs += 1
            last_sweep_at = t
```

End of run — where Task 4 deleted the retry/reconcile block, insert:

```python
    if theme_engine is not None:
        # Retry categories deferred by transient model failures, then run the
        # final promotion sweep so the run ends theme-complete/comparable.
        for storyline_id in replay.uncategorized_storyline_ids():
            category_engine.classify(storyline_id, method="retry")
        if rows:
            for key, value in promotion.run(rows[-1]["published_at"]).items():
                sweep_totals[key] += value
            sweep_runs += 1
```

Report — extend:

```python
    report = {"processed": processed, "episodes_closed": closed_count}
    if cfg.topics_enabled:
        report["theme_sweeps"] = sweep_runs
        report["theme_sweep_totals"] = sweep_totals
```

- [ ] **Step 4: Run the full suite**

Run: `uv run pytest -v`
Expected: PASS. `ClusterFakeStore` may need `uncategorized_storyline_ids`/`categorized_unthemed` passthroughs only if a topics-disabled test trips them — it shouldn't, since all new calls are gated on `cfg.topics_enabled`.

- [ ] **Step 5: Commit**

```bash
git add pipeline/runner.py tests/test_cluster_phase.py
git commit -m "feat: wire category classify + event-time promotion sweeps into the replay runner"
```

---

### Task 7: Design record + calibration procedure

**Files:**
- Create: `docs/operations/lazy-theme-promotion-2026-07-19.md`
- Modify: `docs/operations/topic-clustering-research-validation-2026-07-18.md` (one pointer line at top), `docs/operations/clustering-experimentation-spec-2026-07-18.md` (one pointer line at top)

**Interfaces:**
- Consumes: everything above.
- Produces: the durable record of why stage 4 changed, superseding the healing-sweep framing; the calibration/eval procedure the next session runs.

- [ ] **Step 1: Write the design record**

Create `docs/operations/lazy-theme-promotion-2026-07-19.md`:

```markdown
# Lazy Theme Promotion

2026-07-19. Supersedes the stream-time theme spawn design (and the
"healing sweep" framing that patched it). Implemented by
`docs/archive/implementation-plans/2026-07-19-lazy-theme-promotion.md`.

## Why

Stream-time theme creation is an irreversible online decision made at the
moment of least evidence; the first events of a pattern define themes too
granular to survive (documented cold-start failure — see the megacluster and
singleton findings in `topic-clustering-research-validation-2026-07-18.md`).
The fix is architectural, not parametric: the stream assigns only a broad
seeded category (a stable, high-accuracy classification against the 23
CAP-aligned seeds), and themes are born offline by a promotion sweep once a
within-category cluster carries enough evidence. Retrospective detection
(TDT), TnT-LLM's taxonomy-then-classify phases, and CluStream's
online/offline split are the precedents.

## Decisions in force

| Layer | Decision |
|---|---|
| Category | LLM classify against seed taxonomy at card time; sole stream-time topic label; audit pair `category_method`/`category_reason` |
| Theme birth | promotion sweep only: greedy within-category clustering, gate = size >= `theme_promotion_min_storylines` AND distinct active days >= `theme_promotion_min_active_days` AND cohesion >= `theme_promotion_cohesion_floor`, then the promotion judge promotes / attaches-to-existing / rejects |
| Inclusion criterion | written by the promotion judge at birth; the membership rule every future attach is tested against |
| Stream attach | attach-only, sticky, none-biased; candidates = top-k themes by centroid cosine >= `theme_sim_floor`, cross-category by design |
| Cross-category | themes born category-local, live globally; sweep dossier lists cross-category near-misses; newborns immediately criterion-check them |
| Dormancy | derived, not stored: `newest_storyline_at` older than ~45 days; dormant themes stay attach targets (attach = revival); no poaching |
| Demotion | naive v1: member cohesion < `theme_demotion_cohesion_floor` triggers an LLM keep/demote review; demote reverts members to category-only; every review logged |
| Failure bias | failed verdicts leave work undone (uncategorized / unattached / unpromoted / kept), never act |

## Calibration procedure (golden bootstrap -> replay)

All floors are placeholders. Procedure, in order, on the golden window
(first 3 months of corpus; `golden_batch` selection already exists):

1. Hand-label which themes SHOULD exist in the bootstrap window (extend
   `docs/eval/labels.csv` via the lab borderline queue).
2. Sweep `theme_promotion_cluster_floor` and the gate triple; score
   precision/recall of theme births against the labels.
3. Set `theme_sim_floor` (attach recall floor) from labeled attach pairs:
   plot same-theme vs different-theme cosine distributions, floor at the
   crossover. Re-run when the embedding model changes.
4. Replay months 4+ (never tuned on) and read: birth precision, birth lag
   (days from first member storyline to promotion), attach precision/recall,
   none-rate, sweep mop-up lag, cross-category attach rate, largest-theme
   share, B-Cubed F1 once E0 lands.
5. Leakage rule: tune on bootstrap + months 4-5 only; hold out month 6+ and
   touch it once per major iteration.

## Known deferred items

- No rejection memory: a rejected cluster is re-judged every sweep it keeps
  crossing the gate. Add a rejected-signature skip if judge cost shows up.
- Demotion review is cohesion-triggered only; drift-into-megacluster (size up,
  cohesion slowly down) may want its own trigger.
- B-Cubed harness (E0 in the experimentation spec) is still the missing
  change-detection metric; operational metrics alone cannot say a change helped.
```

- [ ] **Step 2: Add pointer lines**

Top of `topic-clustering-research-validation-2026-07-18.md`, after the intro paragraph:

```markdown
> **2026-07-19:** The theme stage this document validates was redesigned —
> stream-time spawn replaced by category-first lazy promotion. See
> `lazy-theme-promotion-2026-07-19.md`. Verdicts below stay as the research
> record; follow-ups 2, 3, 5, 6 carry over.
```

Top of `clustering-experimentation-spec-2026-07-18.md`, after its companions list:

```markdown
- `docs/operations/lazy-theme-promotion-2026-07-19.md` — theme-stage redesign
  (2026-07-19): category-first stream, promotion-sweep theme birth. Theme-knob
  experiments below apply to the new knob set.
```

- [ ] **Step 3: Verify + commit**

Run: `uv run pytest -q` (whole suite green one last time).

```bash
git add docs/operations/lazy-theme-promotion-2026-07-19.md docs/operations/topic-clustering-research-validation-2026-07-18.md docs/operations/clustering-experimentation-spec-2026-07-18.md
git commit -m "docs: lazy theme promotion design record + calibration procedure"
```
