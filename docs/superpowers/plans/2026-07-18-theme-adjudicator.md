# Theme Adjudicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the KNN-majority theme join in stage 4 with one fast-LLM adjudication call per assignment (join existing theme / spawn new / merge candidate themes inline), and fix the four defects the 2026-07-18 run analysis surfaced: the Workers AI dict-response bug (every theme uncategorized, every overview a fallback, adjudicator dead), the empty `entity_stats` table during replay (EMA down-weighting never runs in the lab), junk event-key extraction patterns (CFR citations and bare `No. XX-XX` boilerplate deterministically glue unrelated episodes — see storyline `aeded190`), and zero failure visibility in experiment reports (a 100% LLM failure rate looked healthy).

**Architecture:** `ThemeEngine._assign` shortlists top-K themes by centroid cosine, sends the storyline plus candidate summaries to `models.adjudicate_theme`, and applies the verdict (merge first, then join or spawn) with guards: hallucinated ids → spawn, LLM failure → old KNN majority vote. Merging is a new `merge_topic_theme` Postgres RPC. Categories work once `_extract_json` accepts already-parsed dicts.

**Tech Stack:** Python 3 (`pipeline/`), psycopg via `Db.rpc`, Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` = `cfg.judge_model`), pytest, Supabase migrations.

**Spec:** `docs/superpowers/specs/2026-07-18-theme-adjudicator-design.md`

## Global Constraints

- No new config keys. Reuse `judge_model`, `theme_sim_floor` (0.55), `theme_stick_floor` (0.50), `theme_knn_k` (5).
- Assignment must never block on the LLM: adjudicator exception → KNN majority fallback.
- `theme_attach_method` values: `adjudicated_join` (LLM join), `new_theme` (spawn), `knn_join` (fallback join), `reassigned` (hysteresis-break re-assign, either path). All four already in the storylines check constraint — no schema change to that constraint.
- Theme names capped at 256 chars (`_MAX_NAME`), reasons at 2048 (DB constraint truncates via `left()`).
- Unit tests run with `uv run pytest tests/ -q` (integration tests excluded by default via `addopts = "-m 'not integration'"`). Integration tests need `DATABASE_URL` set explicitly (it is intentionally NOT in `.env`): `DATABASE_URL=postgresql://postgres:postgres@localhost:57422/postgres uv run pytest tests/test_store_integration.py -m integration -q`, with local Supabase up and migrations applied.
- Apply new migrations locally with `npx supabase db push --local` (or `npx supabase migration up`) before running integration tests.
- House commit style: `feat:`/`fix:`/`docs:` prefixes, lowercase summary.

---

### Task 1: `_extract_json` dict passthrough

Workers AI returns `result["response"]` as an already-parsed dict when the model emits pure JSON. `_extract_json` regexes it → TypeError → `classify_category` swallows → 0/146 themes categorized.

**Files:**
- Modify: `pipeline/ai.py:20-24` (`_extract_json`)
- Test: `tests/test_ai.py`

**Interfaces:**
- Produces: `_extract_json(text: str | dict) -> dict` — dict input returned unchanged; string input regex + `json.loads` as today.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_ai.py`:

```python
def test_extract_json_passes_through_parsed_dict():
    from pipeline.ai import _extract_json

    parsed = {"category_id": "c-1", "reason": "already parsed by workers ai"}
    assert _extract_json(parsed) == parsed
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_ai.py::test_extract_json_passes_through_parsed_dict -q`
Expected: FAIL with `TypeError: expected string or bytes-like object, got 'dict'`

- [ ] **Step 3: Implement the fix**

In `pipeline/ai.py`, replace `_extract_json`:

```python
def _extract_json(text: str | dict) -> dict:
    if isinstance(text, dict):  # workers ai may return pre-parsed json
        return text
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"no json object in model output: {text[:200]}")
    return json.loads(match.group(0))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_ai.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/ai.py tests/test_ai.py
git commit -m "fix: accept pre-parsed dict responses from workers ai json outputs"
```

---

### Task 2: Adjudicator prompt builder

**Files:**
- Modify: `pipeline/prompts.py` (append after `build_category_prompt`)
- Test: `tests/test_prompts.py`

**Interfaces:**
- Produces: `THEME_ADJUDICATOR_SYSTEM: str` and `build_theme_adjudicator_prompt(storyline: dict, candidates: list[dict]) -> tuple[str, str]`.
  - `storyline`: `{"headline": str, "summary": str}`
  - each candidate: `{"theme_id": str, "name": str, "storyline_count": int, "recent_headlines": list[str]}`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_prompts.py` (add `build_theme_adjudicator_prompt` to the existing `from pipeline.prompts import (...)` block):

```python
def test_theme_adjudicator_prompt_lists_candidates_and_json_contract():
    system, user = build_theme_adjudicator_prompt(
        {"headline": "State opens Harvard exchange-program investigation",
         "summary": "Investigation into sponsor eligibility."},
        [{"theme_id": "t-1", "name": "US Visa Sanctions Brazil",
          "storyline_count": 16,
          "recent_headlines": ["Visa restrictions on Brazilian officials"]}],
    )
    assert "JSON" in system
    assert "merge_theme_ids" in system
    assert "spawn" in system
    assert "t-1" in user
    assert "US Visa Sanctions Brazil" in user
    assert "Harvard exchange-program" in user
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_prompts.py::test_theme_adjudicator_prompt_lists_candidates_and_json_contract -q`
Expected: FAIL with `ImportError: cannot import name 'build_theme_adjudicator_prompt'`

- [ ] **Step 3: Implement the prompt**

Append to `pipeline/prompts.py`:

```python
THEME_ADJUDICATOR_SYSTEM = (
    "You assign a US government news storyline to a topic theme. Themes are "
    "specific recurring subjects (e.g. 'FDA drug recalls', 'Houthi sanctions'), "
    "not broad departments or document styles. Join a candidate only when the "
    "storyline covers the same specific subject; a shared agency or press-release "
    "boilerplate is not enough. Otherwise spawn a new theme with a 2-5 word label. "
    "Separately, if two or more candidates clearly name the same subject, list "
    "them in merge_theme_ids. "
    'Respond with JSON only: {"decision": "join" or "spawn", '
    '"theme_id": string or null (copy one candidate theme_id verbatim, only when join), '
    '"new_theme_name": string or null (only when spawn), '
    '"merge_theme_ids": [candidate theme_ids naming the same subject] or [], '
    '"reason": "one sentence"}'
)


def build_theme_adjudicator_prompt(storyline: dict,
                                   candidates: list[dict]) -> tuple[str, str]:
    shaped = [
        {"theme_id": c["theme_id"], "name": c["name"],
         "storyline_count": c["storyline_count"],
         "recent_headlines": c["recent_headlines"]}
        for c in candidates
    ]
    user = (
        f"Storyline headline: {storyline['headline']}\n"
        f"Storyline summary: {storyline.get('summary') or '(none)'}\n\n"
        "Candidate themes:\n" + json.dumps(shaped, indent=2)
    )
    return THEME_ADJUDICATOR_SYSTEM, user
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_prompts.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/prompts.py tests/test_prompts.py
git commit -m "feat: theme adjudicator prompt with join/spawn/merge json contract"
```

---

### Task 3: `WorkersAI.adjudicate_theme`

**Files:**
- Modify: `pipeline/ai.py` (append method to `WorkersAI`, import `build_theme_adjudicator_prompt`)
- Test: `tests/test_ai.py`

**Interfaces:**
- Consumes: `build_theme_adjudicator_prompt` (Task 2), `_extract_json` (Task 1).
- Produces: `WorkersAI.adjudicate_theme(storyline: dict, candidates: list[dict]) -> dict` returning
  `{"decision": str, "theme_id": str | None, "new_theme_name": str | None, "merge_theme_ids": list[str], "reason": str}`.
  Raises on transport/parse errors — the engine handles fallback, this method does not catch.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_ai.py`:

```python
def test_adjudicate_theme_parses_and_normalizes_dict_response():
    def handler(request):
        return httpx.Response(200, json={
            "result": {"response": {  # dict, not string: workers ai json mode
                "decision": "join", "theme_id": "t-1",
                "new_theme_name": None,
                "merge_theme_ids": ["t-1", "t-2"],
                "reason": "same subject"}},
            "success": True,
        })

    ai = WorkersAI(_cfg(), transport=_transport(handler))
    out = ai.adjudicate_theme(
        {"headline": "h", "summary": ""},
        [{"theme_id": "t-1", "name": "A", "storyline_count": 2,
          "recent_headlines": []},
         {"theme_id": "t-2", "name": "B", "storyline_count": 1,
          "recent_headlines": []}],
    )
    assert out == {"decision": "join", "theme_id": "t-1",
                   "new_theme_name": None,
                   "merge_theme_ids": ["t-1", "t-2"],
                   "reason": "same subject"}


def test_adjudicate_theme_raises_on_transport_error():
    def boom(request):
        return httpx.Response(500, json={"success": False})

    ai = WorkersAI(_cfg(), transport=_transport(boom))
    with pytest.raises(Exception):
        ai.adjudicate_theme({"headline": "h", "summary": ""},
                            [{"theme_id": "t-1", "name": "A",
                              "storyline_count": 1, "recent_headlines": []}])
```

Add `import pytest` to the imports of `tests/test_ai.py` if not present.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_ai.py -q -k adjudicate_theme`
Expected: FAIL with `AttributeError: 'WorkersAI' object has no attribute 'adjudicate_theme'`

- [ ] **Step 3: Implement the method**

In `pipeline/ai.py`: add `build_theme_adjudicator_prompt` to the `from pipeline.prompts import (...)` block, then append to `WorkersAI` (after `classify_category`):

```python
    def adjudicate_theme(self, storyline: dict, candidates: list[dict]) -> dict:
        # raises on failure by design: ThemeEngine falls back to knn majority
        system, user = build_theme_adjudicator_prompt(storyline, candidates)
        parsed = _extract_json(self._chat(self.cfg.judge_model, system, user))
        return {
            "decision": str(parsed.get("decision") or ""),
            "theme_id": str(parsed["theme_id"]) if parsed.get("theme_id") else None,
            "new_theme_name": (str(parsed["new_theme_name"])
                               if parsed.get("new_theme_name") else None),
            "merge_theme_ids": [str(i) for i in parsed.get("merge_theme_ids") or []
                                if i],
            "reason": str(parsed.get("reason", "")),
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_ai.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/ai.py tests/test_ai.py
git commit -m "feat: workers ai theme adjudicator call"
```

---

### Task 4: `StubModels.adjudicate_theme`

Stub joins the first (nearest) candidate — deterministic, keeps offline `topics_enabled` runs clustering instead of spawning a theme per storyline.

**Files:**
- Modify: `pipeline/stub.py` (append method to `StubModels`)
- Test: `tests/test_stub.py`

**Interfaces:**
- Produces: `StubModels.adjudicate_theme(storyline, candidates) -> dict`, same shape as Task 3. Joins `candidates[0]` when candidates exist; spawns otherwise. Never merges.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_stub.py`:

```python
def test_stub_adjudicate_theme_joins_nearest_candidate():
    stub = StubModels()
    out = stub.adjudicate_theme(
        {"headline": "h", "summary": ""},
        [{"theme_id": "t-1", "name": "A", "storyline_count": 1,
          "recent_headlines": []},
         {"theme_id": "t-2", "name": "B", "storyline_count": 5,
          "recent_headlines": []}],
    )
    assert out["decision"] == "join"
    assert out["theme_id"] == "t-1"
    assert out["merge_theme_ids"] == []


def test_stub_adjudicate_theme_spawns_without_candidates():
    out = StubModels().adjudicate_theme({"headline": "h", "summary": ""}, [])
    assert out["decision"] == "spawn"
    assert out["theme_id"] is None
```

(`StubModels` is already imported in `tests/test_stub.py`; if not, add `from pipeline.stub import StubModels`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_stub.py -q -k adjudicate_theme`
Expected: FAIL with `AttributeError`

- [ ] **Step 3: Implement**

Append to `StubModels` in `pipeline/stub.py` (after `classify_category`):

```python
    def adjudicate_theme(self, storyline: dict, candidates: list[dict]) -> dict:
        if candidates:
            return {"decision": "join", "theme_id": candidates[0]["theme_id"],
                    "new_theme_name": None, "merge_theme_ids": [],
                    "reason": "stub: nearest candidate theme"}
        return {"decision": "spawn", "theme_id": None, "new_theme_name": None,
                "merge_theme_ids": [], "reason": "stub: no candidates"}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_stub.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/stub.py tests/test_stub.py
git commit -m "feat: stub theme adjudicator joins nearest candidate"
```

---

### Task 5: Store surface — `theme_recent_headlines`, `merge_theme`, `created_at` in `all_themes`

**Files:**
- Create: `supabase/migrations/20260718100900_create_merge_topic_theme.sql`
- Modify: `pipeline/store.py` (`all_themes`, two new methods)
- Modify: `tests/fakes.py` (`FakeStore`: `all_themes` merged filter + `created_at`, two new methods)
- Test: `tests/test_store_integration.py` (gated merge RPC test)

**Interfaces:**
- Produces:
  - `Store.all_themes() -> list[dict]` rows gain `created_at` (needed for merge tie-break).
  - `Store.theme_recent_headlines(theme_id: str, limit: int = 3) -> list[str]` — newest-first member headlines from `event_cards` via `latest_card_id`.
  - `Store.merge_theme(loser_id: str, winner_id: str) -> None` — wraps RPC `merge_topic_theme(p_loser_id uuid, p_winner_id uuid)`: repoints `storylines.theme_id`, sets loser `merged_into` + `storyline_count = 0`, recomputes winner aggregates.
  - `FakeStore` mirrors all three.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260718100900_create_merge_topic_theme.sql`:

```sql
-- Inline theme merge: the stage-4 adjudicator may decide two candidate themes
-- name the same subject. Loser's storylines repoint to the winner; loser is
-- tombstoned via merged_into. Aggregates recompute from storylines rows, same
-- convention as assign_storyline_theme.

create or replace function public.merge_topic_theme(
    p_loser_id uuid,
    p_winner_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    if p_loser_id = p_winner_id then
        raise exception 'merge_topic_theme: loser and winner are the same theme';
    end if;

    update public.storylines set theme_id = p_winner_id
    where theme_id = p_loser_id;

    update public.topic_themes set
        merged_into = p_winner_id,
        storyline_count = 0
    where id = p_loser_id;

    update public.topic_themes t set
        storyline_count = (select count(*) from public.storylines s where s.theme_id = t.id),
        first_storyline_at = (select min(s.first_entry_at) from public.storylines s where s.theme_id = t.id),
        newest_storyline_at = (select max(s.newest_entry_at) from public.storylines s where s.theme_id = t.id)
    where t.id = p_winner_id;
end
$fn$;

comment on function public.merge_topic_theme is
    'Adjudicator-directed theme merge: repoint storylines, tombstone loser via merged_into, recompute winner aggregates from storylines rows.';

revoke execute on function public.merge_topic_theme(uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.merge_topic_theme(uuid, uuid) to service_role;
```

- [ ] **Step 2: Apply migration locally**

Run: `npx supabase migration up`
Expected: `20260718100900` applied without error.

- [ ] **Step 3: Write the failing integration test**

Append to `tests/test_store_integration.py`:

```python
@pytest.mark.integration
def test_merge_topic_theme_repoints_storylines_and_tombstones_loser():
    db = Db(os.environ["DATABASE_URL"])
    store = Store(db)

    ts = datetime.now(timezone.utc)
    winner_id = loser_id = None
    episode_a = episode_b = storyline_a = storyline_b = None
    try:
        winner_id = store.create_theme("winner theme", b"\x00\x00", None, None)
        loser_id = store.create_theme("loser theme", b"\x00\x00", None, None)

        episode_a, storyline_a = store.create_episode(
            None, "new_storyline", None, "merge test a", None, ts)
        episode_b, storyline_b = store.create_episode(
            None, "new_storyline", None, "merge test b", None, ts)
        store.assign_theme(storyline_a, winner_id, "new_theme", None,
                           "seed", None, None)
        store.assign_theme(storyline_b, loser_id, "new_theme", None,
                           "seed", None, None)

        store.merge_theme(loser_id, winner_id)

        row = db.one("select theme_id from public.storylines where id = %(s)s",
                     {"s": storyline_b})
        assert str(row["theme_id"]) == str(winner_id)
        loser = db.one(
            "select merged_into, storyline_count from public.topic_themes "
            "where id = %(t)s", {"t": loser_id})
        assert str(loser["merged_into"]) == str(winner_id)
        assert loser["storyline_count"] == 0
        winner = db.one(
            "select storyline_count from public.topic_themes where id = %(t)s",
            {"t": winner_id})
        assert winner["storyline_count"] == 2
        assert all(str(t["id"]) != str(loser_id) for t in store.all_themes())
    finally:
        for sid in (storyline_a, storyline_b):
            if sid is not None:
                db.conn.execute(
                    "update public.storylines set theme_id = null, "
                    "latest_card_id = null where id = %(s)s", {"s": sid})
        for eid in (episode_a, episode_b):
            if eid is not None:
                db.conn.execute(
                    "delete from public.episodes where id = %(e)s", {"e": eid})
        for sid in (storyline_a, storyline_b):
            if sid is not None:
                db.conn.execute(
                    "delete from public.storylines where id = %(s)s", {"s": sid})
        for tid in (winner_id, loser_id):
            if tid is not None:
                db.conn.execute(
                    "delete from public.topic_themes where id = %(t)s", {"t": tid})
```

- [ ] **Step 4: Run integration test to verify it fails**

Run: `DATABASE_URL=postgresql://postgres:postgres@localhost:57422/postgres uv run pytest tests/test_store_integration.py::test_merge_topic_theme_repoints_storylines_and_tombstones_loser -m integration -q`
Expected: FAIL with `AttributeError: 'Store' object has no attribute 'merge_theme'`

- [ ] **Step 5: Implement Store methods**

In `pipeline/store.py`, change `all_themes` select list to include `created_at`:

```python
    def all_themes(self) -> list[dict]:
        rows = self.db.all(
            """
            select id, display_name, centroid, category_id, storyline_count,
                   created_at
            from public.topic_themes where merged_into is null
            order by display_name, first_storyline_at, storyline_count, centroid
            """
        )
        return [dict(r, centroid=unpack_fp16(r["centroid"]) if r["centroid"] is not None else None)
                for r in rows]
```

Append after `storyline_theme_state`:

```python
    def theme_recent_headlines(self, theme_id: str, limit: int = 3) -> list[str]:
        rows = self.db.all(
            """
            select c.headline from public.storylines s
            join public.event_cards c on c.id = s.latest_card_id
            where s.theme_id = %(t)s and s.merged_into is null
            order by s.newest_entry_at desc nulls last
            limit %(n)s
            """,
            {"t": theme_id, "n": limit},
        )
        return [r["headline"] for r in rows]

    def merge_theme(self, loser_id: str, winner_id: str) -> None:
        self.db.rpc("merge_topic_theme", p_loser_id=loser_id,
                    p_winner_id=winner_id)
```

- [ ] **Step 6: Mirror in FakeStore**

In `tests/fakes.py`:

Replace `all_themes`:

```python
    def all_themes(self):
        return [dict(t, centroid=unpack_fp16(t["centroid"]) if t["centroid"] is not None else None)
                for t in self.themes.values() if t.get("merged_into") is None]
```

In `create_theme`, add `created_at` (monotonic counter is enough for ordering) and `merged_into` to the theme dict:

```python
    def create_theme(self, display_name, centroid, category_id, name_model):
        theme_id = str(uuid.uuid4())
        self.themes[theme_id] = {"id": theme_id, "display_name": display_name,
                                 "centroid": centroid, "category_id": category_id,
                                 "storyline_count": 0, "merged_into": None,
                                 "created_at": len(self.themes)}
        return theme_id
```

Append after `upsert_category`:

```python
    def theme_recent_headlines(self, theme_id, limit=3):
        heads = [s.get("headline", "") for s in self.storylines.values()
                 if s.get("theme_id") == theme_id]
        return list(reversed(heads))[:limit]

    def merge_theme(self, loser_id, winner_id):
        for s in self.storylines.values():
            if s.get("theme_id") == loser_id:
                s["theme_id"] = winner_id
        loser = self.themes[loser_id]
        loser["merged_into"] = winner_id
        loser["storyline_count"] = 0
        self.themes[winner_id]["storyline_count"] = sum(
            1 for s in self.storylines.values()
            if s.get("theme_id") == winner_id)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `DATABASE_URL=postgresql://postgres:postgres@localhost:57422/postgres uv run pytest tests/test_store_integration.py -m integration -q && uv run pytest tests/ -q`
Expected: all PASS (unit suite proves the FakeStore changes broke nothing).

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260718100900_create_merge_topic_theme.sql pipeline/store.py tests/fakes.py tests/test_store_integration.py
git commit -m "feat: merge_topic_theme rpc and theme headline/merge store surface"
```

---

### Task 6: ThemeEngine adjudication flow (join / spawn / guards / fallback)

Rewrites `_assign` to shortlist by theme centroids and defer the decision to `models.adjudicate_theme`. Old majority-vote body becomes `_knn_fallback`. Merge application is Task 7 — in this task the merge branch is absent (verdict `merge_theme_ids` ignored).

**Files:**
- Modify: `pipeline/topics.py`
- Test: `tests/test_topics.py`

**Interfaces:**
- Consumes: `models.adjudicate_theme` (Tasks 3/4), `store.theme_recent_headlines` (Task 5), `store.all_themes()` with `created_at` (Task 5).
- Produces: `ThemeEngine._assign` behavior relied on by Task 7:
  - candidates built as `{"theme_id", "name", "storyline_count", "recent_headlines"}`, top `cfg.theme_knn_k` themes with centroid cosine ≥ `cfg.theme_sim_floor`, sorted nearest-first;
  - `_join(storyline_id, state, vec, theme_id, method, reason, storyline)` applies a join with method `adjudicated_join` (when `method is None`), similarity = cosine to the joined theme centroid;
  - `_spawn(..., name: str | None = None)` uses the adjudicator-provided name when present, otherwise the namer/headline path;
  - `_knn_fallback(storyline_id, state, vec, method, note)` = previous majority-vote logic, reason suffixed with `note`.

- [ ] **Step 1: Update existing tests whose behavior changes**

In `tests/test_topics.py`:

Replace `test_similar_storyline_joins_nearest_neighbor_theme_without_llm` with:

```python
def test_similar_storyline_joins_via_adjudicator():
    class NoNamerModels(StubModels):
        def name_theme(self, storyline):
            raise AssertionError("join must not call the namer")

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "FDA recalls expand to Xarnib", vec(0, 1, 2))
    ThemeEngine(store, NoNamerModels(), CFG).sync(second)
    assert len(store.themes) == 1
    assert store.storylines[second]["theme_id"] == store.storylines[first]["theme_id"]
    assert store.storylines[second]["theme_attach_method"] == "adjudicated_join"
    assert store.storylines[second]["theme_similarity"] is not None
    assert store.storylines[second]["theme_reason"] == "stub: nearest candidate theme"
    theme = next(iter(store.themes.values()))
    assert theme["storyline_count"] == 2
```

Replace `test_knn_majority_vote_beats_single_nearest` with:

```python
def test_adjudicator_failure_falls_back_to_knn_majority_vote():
    class BrokenAdjudicator(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            raise RuntimeError("adjudicator boom")

    store = FakeStore()
    seed_engine = ThemeEngine(store, StubModels(), CFG)
    a1 = add_storyline(store, "IRS delays filing deadline", vec(0, 1))
    seed_engine.sync(a1)
    a2 = add_storyline(store, "IRS extends deadline again", vec(0, 1))
    seed_engine.sync(a2)
    theme_a = store.storylines[a1]["theme_id"]
    b1 = add_storyline(store, "Treasury sanctions update", vec(0, 1, 2))
    b_theme = store.create_theme("Treasury sanctions", pack_fp16(vec(0, 1, 2)), None, None)
    store.assign_theme(b1, b_theme, "new_theme", None, "seed", None, None)

    new = add_storyline(store, "IRS deadline moves once more", vec(0, 1, 2))
    ThemeEngine(store, BrokenAdjudicator(), CFG).sync(new)
    # 2 A-votes beat 1 B-vote in the storyline-knn fallback
    assert store.storylines[new]["theme_id"] == theme_a
    assert store.storylines[new]["theme_attach_method"] == "knn_join"
    assert "adjudicator_error" in store.storylines[new]["theme_reason"]
```

Update `test_drift_below_stick_floor_reassigns_via_knn`: rename to `test_drift_below_stick_floor_reassigns_via_adjudicator` (body unchanged — the stub joins the nearest theme, method stays `reassigned`; keep both existing asserts).

- [ ] **Step 2: Write new failing tests**

Append to `tests/test_topics.py`:

```python
def test_hallucinated_theme_id_treated_as_spawn():
    class HallucinatingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            return {"decision": "join", "theme_id": "not-a-real-theme",
                    "new_theme_name": None, "merge_theme_ids": [],
                    "reason": "made it up"}

    store = FakeStore()
    first = add_storyline(store, "FDA recalls Valsatrex", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "FDA recalls expand", vec(0, 1, 2))
    ThemeEngine(store, HallucinatingModels(), CFG).sync(second)
    assert len(store.themes) == 2
    assert store.storylines[second]["theme_attach_method"] == "new_theme"


def test_adjudicator_spawn_uses_provided_name_without_namer_call():
    class SpawningModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            return {"decision": "spawn", "theme_id": None,
                    "new_theme_name": "Harvard exchange program",
                    "merge_theme_ids": [],
                    "reason": "different subject than candidates"}

        def name_theme(self, storyline):
            raise AssertionError("adjudicator provided the name")

    store = FakeStore()
    first = add_storyline(store, "Visa restrictions on Brazilian officials", vec(0, 1))
    ThemeEngine(store, StubModels(), CFG).sync(first)
    second = add_storyline(store, "Harvard exchange investigation", vec(0, 1, 2))
    ThemeEngine(store, SpawningModels(), CFG).sync(second)
    assert len(store.themes) == 2
    names = {t["display_name"] for t in store.themes.values()}
    assert "Harvard exchange program" in names
    assert store.storylines[second]["theme_attach_method"] == "new_theme"
    assert store.storylines[second]["theme_reason"] == "different subject than candidates"
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `uv run pytest tests/test_topics.py -q`
Expected: new/updated adjudicator tests FAIL (current code never calls `adjudicate_theme`); spawn-path tests like `test_first_storyline_spawns_theme_with_short_llm_name` still PASS.

- [ ] **Step 4: Rewrite the engine**

Replace `pipeline/topics.py` content from the docstring through `_spawn` (keep `_refresh_centroid` and `_classify` unchanged):

```python
"""Stage 4 — topic themes: shortlist candidate themes by centroid cosine, then
one fast-LLM adjudication decides join / spawn (and, Task 7, inline merges).
LLM failure falls back to the old KNN majority vote — assignment never blocks.
Assignment at first overview, hysteresis re-check on refresh."""

from __future__ import annotations

from collections import Counter

import numpy as np

from pipeline.config import Config
from pipeline.vectors import cosine, pack_fp16

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
                return  # hysteresis: still fits, no work
            self._assign(storyline_id, state, vec, method="reassigned")
            return
        self._assign(storyline_id, state, vec, method=None)

    # -- assignment -----------------------------------------------------

    def _assign(self, storyline_id: str, state: dict, vec: np.ndarray,
                method: str | None) -> None:
        storyline = {"headline": state.get("headline") or "(no card)",
                     "summary": state.get("summary") or ""}
        themes = [t for t in self.store.all_themes()
                  if t["centroid"] is not None]
        scored = sorted(((cosine(vec, t["centroid"]), t) for t in themes),
                        key=lambda pair: -pair[0])
        top = [(sim, t) for sim, t in scored
               if sim >= self.cfg.theme_sim_floor][:self.cfg.theme_knn_k]

        if not top:
            self._spawn(storyline_id, storyline, vec,
                        method=method or "new_theme",
                        reason="no theme above sim floor")
            return

        candidates = [
            {"theme_id": str(t["id"]), "name": t["display_name"],
             "storyline_count": t["storyline_count"],
             "recent_headlines": self.store.theme_recent_headlines(str(t["id"]))}
            for _, t in top
        ]
        try:
            verdict = self.models.adjudicate_theme(storyline, candidates)
        except Exception as exc:  # assignment never blocks on the LLM
            self._knn_fallback(storyline_id, state, vec, method,
                               f"adjudicator_error: {exc}")
            return

        valid = [c["theme_id"] for c in candidates]
        target = verdict.get("theme_id")
        if verdict.get("decision") == "join" and target in valid:
            self._join(storyline_id, state, vec, target, method,
                       verdict.get("reason") or "adjudicated join", storyline)
            return
        # spawn verdict, or hallucinated/missing theme_id on a join verdict
        self._spawn(storyline_id, storyline, vec,
                    method=method or "new_theme",
                    reason=verdict.get("reason") or "adjudicator spawn",
                    name=verdict.get("new_theme_name"))

    def _join(self, storyline_id: str, state: dict, vec: np.ndarray,
              theme_id: str, method: str | None, reason: str,
              storyline: dict) -> None:
        old_theme_id = state.get("theme_id")
        theme = next((t for t in self.store.all_themes()
                      if str(t["id"]) == theme_id), None)
        sim = (cosine(vec, theme["centroid"])
               if theme is not None and theme["centroid"] is not None else None)
        members = self.store.theme_member_centroids(theme_id)
        new_centroid = np.mean(members + [vec], axis=0) if members else vec
        self.store.assign_theme(
            storyline_id, theme_id,
            method="adjudicated_join" if method is None else method,
            similarity=sim, reason=reason,
            theme_centroid=pack_fp16(new_centroid),
            theme_display_name=None)
        if old_theme_id is not None and str(old_theme_id) != theme_id:
            self._refresh_centroid(str(old_theme_id))
        if theme is not None and theme.get("category_id") is None:
            self._classify(theme_id, theme["display_name"], storyline)

    def _knn_fallback(self, storyline_id: str, state: dict, vec: np.ndarray,
                      method: str | None, note: str) -> None:
        neighbors = sorted(
            ((cosine(vec, s["centroid"]), s)
             for s in self.store.themed_storylines()
             if str(s["id"]) != str(storyline_id)),
            key=lambda pair: -pair[0])
        top = [(sim, s) for sim, s in neighbors
               if sim >= self.cfg.theme_sim_floor][:self.cfg.theme_knn_k]
        storyline = {"headline": state.get("headline") or "(no card)",
                     "summary": state.get("summary") or ""}
        if not top:
            self._spawn(storyline_id, storyline, vec,
                        method=method or "new_theme",
                        reason=f"no themed storyline above sim floor; {note}")
            return
        votes = Counter(str(s["theme_id"]) for _, s in top)
        # modal theme; ties resolve to the nearest neighbor's theme
        best_count = max(votes.values())
        winner = next(str(s["theme_id"]) for sim, s in top
                      if votes[str(s["theme_id"])] == best_count)
        sim = max(s for s, n in top if str(n["theme_id"]) == winner)
        old_theme_id = state.get("theme_id")
        members = self.store.theme_member_centroids(winner)
        new_centroid = np.mean(members + [vec], axis=0) if members else vec
        self.store.assign_theme(
            storyline_id, winner,
            method="knn_join" if method is None else method,
            similarity=sim,
            reason=f"knn: {votes[winner]}/{len(top)} nearest storylines; {note}",
            theme_centroid=pack_fp16(new_centroid),
            theme_display_name=None)
        if old_theme_id is not None and str(old_theme_id) != winner:
            self._refresh_centroid(str(old_theme_id))
        theme = next((t for t in self.store.all_themes()
                      if str(t["id"]) == winner), None)
        if theme is not None and theme.get("category_id") is None:
            self._classify(winner, theme["display_name"], storyline)

    def _spawn(self, storyline_id: str, storyline: dict, vec: np.ndarray,
               method: str, reason: str, name: str | None = None) -> None:
        if name:
            name = name[:_MAX_NAME]
        else:
            try:
                name = self.models.name_theme(storyline)[:_MAX_NAME]
            except Exception as exc:  # naming never blocks: fall back to the headline
                name = storyline["headline"][:_MAX_NAME]
                reason = f"{reason}; namer_error: {exc}"
        theme_id = self.store.create_theme(
            name or storyline["headline"][:_MAX_NAME], pack_fp16(vec),
            category_id=None,
            name_model=getattr(self.cfg, "judge_model", None))
        self.store.assign_theme(storyline_id, theme_id, method=method,
                                similarity=None, reason=reason,
                                theme_centroid=None, theme_display_name=None)
        self._classify(theme_id, name, storyline)
```

Note: `test_first_storyline_spawns_theme_with_short_llm_name` asserts nothing about the reason string, but `test_dissimilar_storyline_below_floor_spawns` relies only on `theme_attach_method`; the no-candidates reason changed from "no themed storyline above sim floor" to "no theme above sim floor" — grep tests for the old string and update if any assert it (none do today).

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_topics.py tests/test_cluster_phase.py -q`
Expected: all PASS

- [ ] **Step 6: Run the whole unit suite**

Run: `uv run pytest tests/ -q`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add pipeline/topics.py tests/test_topics.py
git commit -m "feat: llm adjudicator decides theme join/spawn with knn fallback"
```

---

### Task 7: Inline merge application

**Files:**
- Modify: `pipeline/topics.py` (`_assign` merge branch + `_merge` helper)
- Test: `tests/test_topics.py`

**Interfaces:**
- Consumes: `store.merge_theme` / FakeStore mirror (Task 5), verdict `merge_theme_ids` (Task 3/4 shape), `_join`/`_spawn` (Task 6).
- Produces: `_merge(merge_ids: list[str], top) -> str` returning the surviving theme id. Winner = highest `storyline_count`, ties → smallest `created_at`. Applied before join/spawn so a join into a merged loser lands on the survivor.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_topics.py`:

```python
def make_merging_models(merge_ids, join_id):
    class MergingModels(StubModels):
        def adjudicate_theme(self, storyline, candidates):
            return {"decision": "join", "theme_id": join_id,
                    "new_theme_name": None, "merge_theme_ids": merge_ids,
                    "reason": "same subject; candidates duplicate"}
    return MergingModels()


def seed_two_close_themes(store):
    """Two themes on nearby vectors, theme A with 2 members, theme B with 1."""
    engine = ThemeEngine(store, StubModels(), CFG)
    a1 = add_storyline(store, "Houthi petroleum sanctions", vec(0, 1))
    engine.sync(a1)
    a2 = add_storyline(store, "Houthi network sanctions expand", vec(0, 1))
    engine.sync(a2)
    theme_a = store.storylines[a1]["theme_id"]
    b1 = add_storyline(store, "Treasury sanctions Houthi smugglers", vec(0, 1, 2))
    theme_b = store.create_theme("Houthi smuggling", pack_fp16(vec(0, 1, 2)), None, None)
    store.assign_theme(b1, theme_b, "new_theme", None, "seed", None, None)
    return theme_a, theme_b


def test_merge_directive_tombstones_loser_and_join_lands_on_survivor():
    store = FakeStore()
    theme_a, theme_b = seed_two_close_themes(store)
    new = add_storyline(store, "New Houthi sanctions action", vec(0, 1, 2))
    models = make_merging_models([theme_a, theme_b], join_id=theme_b)
    ThemeEngine(store, models, CFG).sync(new)
    # winner by storyline_count is theme_a; join into loser theme_b redirects
    assert store.themes[theme_b]["merged_into"] == theme_a
    assert store.themes[theme_b]["storyline_count"] == 0
    assert store.storylines[new]["theme_id"] == theme_a
    assert all(s.get("theme_id") != theme_b for s in store.storylines.values())
    assert store.themes[theme_a]["centroid"] is not None
    # merged theme is gone from the candidate surface
    assert all(t["id"] != theme_b for t in store.all_themes())


def test_merge_with_fewer_than_two_valid_ids_is_ignored():
    store = FakeStore()
    theme_a, theme_b = seed_two_close_themes(store)
    new = add_storyline(store, "New Houthi sanctions action", vec(0, 1, 2))
    models = make_merging_models([theme_a, "hallucinated-id"], join_id=theme_a)
    ThemeEngine(store, models, CFG).sync(new)
    assert store.themes[theme_b].get("merged_into") is None
    assert store.storylines[new]["theme_id"] == theme_a
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_topics.py -q -k merge`
Expected: `test_merge_directive_...` FAILS (`merged_into` never set); `test_merge_with_fewer...` may pass already — fine.

- [ ] **Step 3: Implement the merge branch**

In `pipeline/topics.py` `_assign`, replace the block after the `except` clause (from `valid = ...` to the end of the method) with:

```python
        valid = [c["theme_id"] for c in candidates]
        merge_ids = list(dict.fromkeys(
            i for i in verdict.get("merge_theme_ids") or [] if i in valid))
        survivor = self._merge(merge_ids, top) if len(merge_ids) >= 2 else None

        target = verdict.get("theme_id")
        if verdict.get("decision") == "join" and target in valid:
            if survivor is not None and target in merge_ids:
                target = survivor
            self._join(storyline_id, state, vec, target, method,
                       verdict.get("reason") or "adjudicated join", storyline)
            return
        # spawn verdict, or hallucinated/missing theme_id on a join verdict
        self._spawn(storyline_id, storyline, vec,
                    method=method or "new_theme",
                    reason=verdict.get("reason") or "adjudicator spawn",
                    name=verdict.get("new_theme_name"))
```

Add the helper after `_join`:

```python
    def _merge(self, merge_ids: list[str], top) -> str:
        themes = {str(t["id"]): t for _, t in top}
        ordered = sorted(merge_ids,
                         key=lambda i: (-themes[i]["storyline_count"],
                                        themes[i]["created_at"]))
        winner = ordered[0]
        for loser in ordered[1:]:
            self.store.merge_theme(loser, winner)
        self._refresh_centroid(winner)
        return winner
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_topics.py -q`
Expected: all PASS

- [ ] **Step 5: Run the whole unit suite**

Run: `uv run pytest tests/ -q`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add pipeline/topics.py tests/test_topics.py
git commit -m "feat: adjudicator-directed inline theme merges"
```

---

### Task 8: Repopulate entity EMAs during replay

`reset_clusters` deletes `entity_stats` and nothing during the cluster replay refills it (`touch_entity_stats` only fires on ingest/prepare). `entity_emas()` therefore returns `{}` in every experiment: all tokens look "rare", so junk entities (`'great'`, `'washington'`) count as tier-2 discriminators. Fix: the replay loop touches anchors per entry in event time — mirroring what ingest does in prod, with no look-ahead bias.

**Files:**
- Create: `supabase/migrations/20260718101000_grant_replay_entity_touch.sql`
- Modify: `pipeline/store.py` (new `touch_entities`)
- Modify: `pipeline/runner.py` (`cluster` loop)
- Modify: `tests/fakes.py` (`FakeStore.touch_entities`)
- Test: `tests/test_cluster_phase.py`

**Interfaces:**
- Produces: `Store.touch_entities(tokens: list[str], t: datetime) -> None` wrapping the (now service_role-executable) `touch_entity_stats` RPC. `FakeStore` mirror bumps `self.emas[token] += 1.0` per touch (no decay — enough for unit tests) and appends to `self.touches`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260718101000_grant_replay_entity_touch.sql`:

```sql
-- The lab replay (pipeline/runner.py cluster) emulates ingest-time entity
-- touching in event time: bench corpora arrive via direct-SQL sync, so the
-- ingest-path touch never happened and reset_clusters wipes the prepare-time
-- partials. The helper therefore needs service_role execute after all.
grant execute on function public.touch_entity_stats(text[], timestamptz)
    to service_role;
```

- [ ] **Step 2: Apply migration locally**

Run: `npx supabase migration up`
Expected: `20260718101000` applied.

- [ ] **Step 3: Write the failing test**

Append to `tests/test_cluster_phase.py` (reuse its harness helpers):

```python
def test_cluster_touches_entity_stats_per_entry_in_event_time():
    store, models, cfg = make_harness(topics_enabled=False)
    run_cluster(store, models, cfg)
    processed = [e for e in store.entries.values() if e.get("episode_id")]
    assert len(store.touches) == len(processed)
    for tokens, t in store.touches:
        assert isinstance(tokens, list)
    # EMA table is no longer empty during replay
    assert store.emas
```

(Adapt `make_harness`/`run_cluster` to the file's actual helper names; entries in the harness carry `entity_set`/`event_keys`.)

- [ ] **Step 4: Run test to verify it fails**

Run: `uv run pytest tests/test_cluster_phase.py -q -k touches`
Expected: FAIL with `AttributeError: 'FakeStore' object has no attribute 'touches'` (or empty `touches`).

- [ ] **Step 5: Implement**

`pipeline/store.py`, after `update_entry_features`:

```python
    def touch_entities(self, tokens: list[str], t: datetime) -> None:
        if tokens:
            self.db.rpc("touch_entity_stats", p_tokens=tokens, p_event_time=t)
```

`tests/fakes.py`, in `FakeStore.__init__` add `self.touches: list = []`; then after `entity_emas`:

```python
    def touch_entities(self, tokens, t):
        self.touches.append((tokens, t))
        for token in tokens:
            self.emas[token] = self.emas.get(token, 0.0) + 1.0
```

`pipeline/runner.py`, in the `cluster` loop directly after `window.advance(t)`:

```python
        replay.touch_entities(
            list(row["entity_set"]) + list(row["event_keys"]), t)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_cluster_phase.py tests/test_topics.py -q`
Expected: all PASS (topics tests confirm the fake change broke nothing).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260718101000_grant_replay_entity_touch.sql pipeline/store.py pipeline/runner.py tests/fakes.py tests/test_cluster_phase.py
git commit -m "fix: repopulate entity emas during cluster replay in event time"
```

---

### Task 9: LLM failure visibility in experiment reports

The analyzed run had a 100% LLM failure rate (dict-response bug) and produced a healthy-looking report. Errors must stay non-blocking, but they must be counted.

**Files:**
- Modify: `pipeline/ai.py` (`WorkersAI.errors` counter)
- Modify: `pipeline/experiment.py` (`summarize` llm_health, `render_report` section, `run_experiment` wiring)
- Test: `tests/test_ai.py`, `tests/test_experiment.py`

**Interfaces:**
- Produces: `WorkersAI.errors: collections.Counter` — keys `adjudicator`, `classifier`, `rank_audit`, incremented in the existing except branches. `CachedModels` exposes it via `__getattr__` delegation (no change there).
- `summarize(db)` gains `"llm_health": {"overview_fallback_rate": float | None, "uncategorized_themes": int, "namer_errors": int}` (SQL-side truth, independent of in-process counters).
- `run_experiment` merges `dict(getattr(models, "errors", {}))` into the summary as `summary["llm_health"]["model_errors"]` before rendering/recording.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_ai.py`:

```python
def test_workers_ai_counts_swallowed_errors():
    def boom(request):
        return httpx.Response(200, json={"result": {"response": "not json"},
                                         "success": True})

    ai = WorkersAI(_cfg(), transport=_transport(boom))
    ai.adjudicate_same_event({"title": "a"}, {"title": "b"}, "")
    ai.classify_category("t", {"headline": "h"}, [])
    assert ai.errors["adjudicator"] == 1
    assert ai.errors["classifier"] == 1
```

Append to `tests/test_experiment.py` (extend its fake-db helper so the two new queries return rows):

```python
def test_summary_reports_llm_health():
    summary = summarize(make_summary_db())
    health = summary["llm_health"]
    for key in ("overview_fallback_rate", "uncategorized_themes", "namer_errors"):
        assert key in health
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_ai.py tests/test_experiment.py -q -k "errors or llm_health"`
Expected: FAIL (`AttributeError: errors` / `KeyError: llm_health`).

- [ ] **Step 3: Implement**

`pipeline/ai.py`: `from collections import Counter`; in `WorkersAI.__init__` add `self.errors: Counter = Counter()`; in the except branches add `self.errors["adjudicator"] += 1` (adjudicate_same_event), `self.errors["classifier"] += 1` (classify_category), `self.errors["rank_audit"] += 1` (compare_rank).

`pipeline/experiment.py` `summarize()`, before the return:

```python
    fallback = db.one("""
        select round(avg((interest_reason like 'compressor_error%%')::int)::numeric, 3) as rate
        from public.event_cards where kind = 'overview'
    """)
    namer_errors = db.one("""
        select count(*) as n from public.storylines
        where theme_reason like '%%namer_error%%'
    """)
    uncategorized = db.one("""
        select count(*) as n from public.topic_themes
        where merged_into is null and category_id is null
    """)
    llm_health = {
        "overview_fallback_rate": (
            float(fallback["rate"]) if fallback["rate"] is not None else None),
        "uncategorized_themes": uncategorized["n"],
        "namer_errors": namer_errors["n"],
    }
```

and add `"llm_health": llm_health,` to the returned dict. In `run_experiment`, after `summary = summarize(db)`:

```python
    summary["llm_health"]["model_errors"] = dict(getattr(models, "errors", {}))
```

`render_report`, after the Topics section:

```python
        "", "## LLM health", "",
        f"- overview fallback rate: {summary['llm_health']['overview_fallback_rate']}"
        + ("  ⚠ compressor mostly failing"
           if (summary['llm_health']['overview_fallback_rate'] or 0) > 0.5 else ""),
        f"- uncategorized themes: {summary['llm_health']['uncategorized_themes']}",
        f"- namer errors: {summary['llm_health']['namer_errors']}",
        f"- model errors: {summary['llm_health'].get('model_errors', {})}",
```

(`render_report` runs after `run_experiment` injects `model_errors`; the `.get` keeps `summarize()`-only tests passing.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_ai.py tests/test_experiment.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/ai.py pipeline/experiment.py tests/test_ai.py tests/test_experiment.py
git commit -m "feat: count swallowed llm failures and surface llm health in reports"
```

---

### Task 10: Extraction v2 — drop junk event-key patterns, add reextract command

`36 cfr 261.50` (×6) and `no. 23-01` (×5) are shared boilerplate minted as "hard event identifiers"; tier-1 attach is deterministic, so one colliding key chains unrelated episodes (storyline `aeded190`: Employment Cost Index glued to State Employment at 0.578 cosine). CFR citations are legal-authority references, not events — dropped. Bare `No. XX-XX` now requires case/docket context. IRS `ir-2025-xxx` release keys are working as intended — untouched.

**Files:**
- Modify: `pipeline/extraction.py` (`_EVENT_KEY_PATTERNS`, `EXTRACTOR_VERSION`)
- Modify: `pipeline/store.py` (`entries_needing_reextraction`)
- Modify: `pipeline/cli.py` (`reextract` subcommand)
- Test: `tests/test_extraction.py`

**Interfaces:**
- Produces: `EXTRACTOR_VERSION = 2`; `Store.entries_needing_reextraction(version: int, limit: int | None = None) -> list[dict]` (id/title/summary/body_text of rows with `extractor_version` null or `< version`); CLI `pipeline reextract [--limit N]` — pure-python re-extraction via `update_entry_features` (anchors + version only; embeddings and enrichment untouched, zero LLM cost).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_extraction.py`:

```python
def test_cfr_citations_are_not_event_keys():
    _, keys = extract("Fire restrictions increase in Southeast Utah parks",
                      "Under 36 CFR 261.50, superintendents prohibit campfires.")
    assert keys == []


def test_bare_release_numbering_is_not_an_event_key():
    _, keys = extract("Employment Cost Index News Release",
                      "USDL No. 23-01 covers the June quarter.")
    assert not any("23-01" in k for k in keys)


def test_docket_case_numbers_still_extracted():
    _, keys = extract("Court ruling in visa case",
                      "The order in Case No. 23-104 was affirmed.")
    assert any("23-104" in k for k in keys)


def test_extractor_version_bumped_for_pattern_change():
    from pipeline.extraction import EXTRACTOR_VERSION
    assert EXTRACTOR_VERSION == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_extraction.py -q`
Expected: the four new tests FAIL.

- [ ] **Step 3: Implement extraction changes**

In `pipeline/extraction.py`: set `EXTRACTOR_VERSION = 2`; in `_EVENT_KEY_PATTERNS` delete the CFR pattern line and replace the case-number pattern:

```python
    re.compile(r"\b(?:case|docket)\s+no\.\s?\d{2}-\d{2,5}\b", re.IGNORECASE),  # court case numbers (context-anchored)
```

(The CFR line `re.compile(r"\b\d{1,3}\s?CFR\s?...")` is removed entirely.)

- [ ] **Step 4: Implement the reextract path**

`pipeline/store.py`, after `entries_needing_features`:

```python
    def entries_needing_reextraction(self, version: int,
                                     limit: int | None = None) -> list[dict]:
        return self.db.all(
            """
            select id, title, summary, body_text
            from public.news_entries
            where extractor_version is null or extractor_version < %(v)s
            order by published_at, id
            limit %(limit)s
            """,
            {"v": version, "limit": limit},
        )
```

`pipeline/cli.py`: register the subcommand next to `prepare`:

```python
    p = sub.add_parser("reextract", help="re-run anchor extraction (no llm, no embeddings)")
    p.add_argument("--limit", type=int)
```

and the dispatch branch:

```python
    elif args.command == "reextract":
        from pipeline.extraction import EXTRACTOR_VERSION, extract
        rows = store.entries_needing_reextraction(EXTRACTOR_VERSION, limit=args.limit)
        for row in rows:
            entities, keys = extract(row["title"],
                                     row.get("body_text") or row.get("summary"))
            store.update_entry_features(
                row["id"], None, None, None, None,
                entity_set=entities, event_keys=keys,
                extractor_version=EXTRACTOR_VERSION)
        out = {"reextracted": len(rows)}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_extraction.py tests/ -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add pipeline/extraction.py pipeline/store.py pipeline/cli.py tests/test_extraction.py
git commit -m "fix: stop minting cfr citations and bare release numbers as event keys"
```

---

### Task 11: Tier-1 event-key sanity floor

Defense in depth: even with v2 patterns, one colliding key deterministically wrecks a chain because tier 1 has no second signal (and EMA cannot catch monthly boilerplate — it decays below the ambient ceiling). An event-key join now also requires centroid sanity when a centroid exists; below the floor it falls through to the entity/adjudicator tiers. Similarity is recorded on event-key joins either way (was always `None` — audit gain).

**Files:**
- Modify: `pipeline/storylines.py` (tier 1 of `resolve`)
- Test: `tests/test_storylines.py`

**Interfaces:**
- Consumes: `cfg.storyline_sim_floor` (0.60), existing `cosine`.
- Produces: event-key joins return `(id, "event_key", sim | None, None, None)` — `sim` set when the candidate has a centroid; candidates below the floor are skipped (loop continues, then tiers 2/3 run unchanged).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_storylines.py` (reuse the file's engine/store fixtures; shapes below match `FakeStore`-style dicts):

```python
def test_event_key_join_requires_centroid_sanity_when_centroid_exists():
    """Regression: storyline aeded190 — colliding boilerplate key 'no. 23-01'
    glued Employment Cost Index (cosine 0.578) onto State Employment."""
    engine, store = make_engine()
    chain = seed_storyline(store, event_keys=["no. 23-01"], centroid=vec(0, 1))
    entry = make_entry(event_keys=["no. 23-01"], entity_set=["cost", "index"])
    sid, method, sim, _, _ = engine.resolve(entry, vec(6, 7))  # orthogonal content
    assert method != "event_key" or sid != str(chain["id"])


def test_event_key_join_passes_with_similar_content_and_records_sim():
    engine, store = make_engine()
    chain = seed_storyline(store, event_keys=["ir-2025-106"], centroid=vec(0, 1))
    entry = make_entry(event_keys=["ir-2025-106"], entity_set=[])
    sid, method, sim, _, _ = engine.resolve(entry, vec(0, 1))
    assert (sid, method) == (str(chain["id"]), "event_key")
    assert sim is not None and sim > 0.9


def test_event_key_join_allowed_without_centroid():
    engine, store = make_engine()
    chain = seed_storyline(store, event_keys=["ir-2025-106"], centroid=None)
    entry = make_entry(event_keys=["ir-2025-106"], entity_set=[])
    sid, method, sim, _, _ = engine.resolve(entry, vec(0, 1))
    assert (sid, method, sim) == (str(chain["id"]), "event_key", None)
```

(Adapt helper names to the file's existing fixtures — it already builds engines and seeded storylines for the tier-2/3 tests.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_storylines.py -q`
Expected: the sanity-floor test FAILS (current tier 1 joins unconditionally).

- [ ] **Step 3: Implement**

In `pipeline/storylines.py` `resolve`, replace tier 1:

```python
        # tier 1: hard event keys — deterministic chain identity, but a
        # colliding boilerplate key must not glue unrelated content: when the
        # chain has a centroid, demand minimal semantic sanity or fall through
        # to the entity/adjudicator tiers (storyline aeded190 regression).
        for cand in self.store.storylines_by_event_keys(entry["event_keys"]):
            if cand.get("centroid") is None:
                return str(cand["id"]), "event_key", None, None, None
            sim = cosine(vec, cand["centroid"])
            if sim >= self.cfg.storyline_sim_floor:
                return str(cand["id"]), "event_key", sim, None, None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_storylines.py tests/ -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/storylines.py tests/test_storylines.py
git commit -m "fix: event-key joins demand centroid sanity so colliding keys cannot glue chains"
```

---

### Task 12: Full verification

**Files:** none new.

- [ ] **Step 1: Full unit suite**

Run: `uv run pytest tests/ -q`
Expected: all PASS

- [ ] **Step 2: Integration suite**

Run: `DATABASE_URL=postgresql://postgres:postgres@localhost:57422/postgres uv run pytest tests/ -m integration -q`
Expected: all PASS

- [ ] **Step 3: Live smoke of the category fix (optional but cheap)**

With `.env` loaded (`set -a && source .env && set +a`):

```bash
uv run python - <<'EOF'
from pipeline.config import load_config
from pipeline.ai import WorkersAI
from pipeline.db import Db
from pipeline.store import Store

cfg = load_config()
store = Store(Db("postgresql://postgres:postgres@localhost:57422/postgres"))
ai = WorkersAI(cfg)
out = ai.classify_category(
    "Houthi petroleum sanctions",
    {"headline": "Treasury sanctions Houthi petroleum network", "summary": ""},
    store.all_categories())
print(out)
assert out["category_id"] is not None or out["new_category_name"] is not None, out
EOF
```

Expected: prints a verdict with a non-null `category_id` (no `classifier_error`).

- [ ] **Step 4: Commit any stragglers, confirm clean tree**

Run: `git status --short` — only pre-existing unrelated modifications (news-backfill, operator-console) remain.
