# Experiment CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-command local clustering experiments over the seeded hosted corpus: sync once, prepare features once, then iterate `experiment <name>` runs in seconds-to-minutes with cached LLM decisions and diffable reports.

**Architecture:** Split the pipeline at the cache line. Per-entry features (enrich/embed/extract) are computed once by a concurrent `prepare` phase and stored on `news_entries`. Each experiment is a `cluster` replay: event-time drain reading cached vectors from an in-RAM rolling window (no per-entry DB scans), with adjudicator calls memoized in a content-keyed sqlite cache so repeat experiments only pay for decisions the config change actually altered. `reset --clusters` wipes decisions but never features; `experiment` = reset → cluster → report with full config snapshot.

**Tech Stack:** Existing `pipeline/` package (Python 3.12, uv, psycopg, httpx, numpy), sqlite3 (stdlib) for the decision cache, local Supabase Postgres as the lab bench, Workers AI REST (or `StubModels`) for inference.

**Builds on:** `docs/superpowers/plans/2026-07-18-clustering-processing-pipeline.md` Tasks 1–7 (executed on this branch): `Config`, `Db`, `Store`, `EpisodeEngine`, `StorylineEngine`, `CardEngine`, `WorkersAI`, `StubModels`, extraction/normalize, write RPCs (`20260718100000`/`20260718100100` — applied to local AND hosted). No `runner.py`/`cli.py` exists yet; this plan creates them.

## Design decisions (locked)

1. **Two-phase runner.** `prepare` = enrich (ThreadPool, 8 concurrent) + embed (batches of 96) + extraction backfill (seeded rows have empty `entity_set`/`event_keys`), all persisted via `update_entry_features`. `cluster` = pure replay; touches no feature computation. Resumable by predicate: `embedding is null` = needs prepare; `embedding is not null and episode_id is null` = needs cluster.
2. **Adjudicator-only decision cache.** Keyed on content `(a, b, context)` + model tag — never on row ids (ids regenerate every reset). Compression is NOT cached: its output cites `episode_id`s that change per run, and volume is low (hundreds max). Enrichment/embeddings are already cached in the DB.
3. **In-RAM replay window.** `ReplayStore` overrides `content_hash_dup`/`recent_embedded` with a deque advanced by the event clock. Everything else delegates to the real `Store`. Kills ~6.5k per-entry window queries.
4. **Local-only destructive tools.** `reset` and `sync` refuse any DSN whose host is not `127.0.0.1`/`localhost` — structurally impossible to wipe hosted. They write with direct SQL (lab tooling; the RPC-only rule guards the production write path, not the bench).
5. **`sync` preserves hosted ids** (`news_sources.id`, `news_entries.id`) so results cross-reference the pristine hosted corpus.
6. **Experiments always finalize** (close remaining open episodes + generate cards) so every run produces a complete, comparable state.
7. **Config overrides via environment** (already supported by `load_config()`): `NEAR_DUP_THRESHOLD=0.87 uv run python -m pipeline.cli experiment tighter-dedupe`. The report embeds the resolved `Config` so no run is ambiguous.

## Global Constraints

- Python house rules from the parent plan: package `pipeline/` at repo root, tests in `tests/`, `uv run pytest` (unit; `-m integration` needs local Supabase with all migrations), type hints, plain modules, no new frameworks.
- No new third-party dependencies — sqlite3 and concurrent.futures are stdlib.
- All *pipeline* writes go through the existing RPCs; only `reset.py`/`sync.py` (bench tools, local-guarded) use direct SQL.
- Attach-method vocabularies unchanged; engines are not modified by this plan except where explicitly shown.
- `DATABASE_URL` defaults to `postgresql://postgres:postgres@127.0.0.1:54322/postgres` when unset (local bench ergonomics; hosted use always requires an explicit value).
- Decision cache lives at `.cache/decisions.sqlite` (gitignored).
- Reports land in `docs/eval/<experiment-name>/report.md` (committed — they're the lab notebook).
- Commit after every green task; messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Decision cache

Content-keyed sqlite memo for adjudicator calls, wrapped around any `ModelClient`.

**Files:**
- Create: `pipeline/cache.py`
- Modify: `.gitignore` (add `.cache/`)
- Modify: `pipeline/config.py` (DATABASE_URL default)
- Test: `tests/test_cache.py`

**Interfaces:**
- Consumes: any object with `adjudicate_same_event(a, b, context) -> tuple[bool, str]` (plus optional `embed`/`enrich`/`compress_overview`, delegated untouched).
- Produces:
  - `DecisionCache(path: str)` — `get(key: str) -> tuple[bool, str] | None`, `put(key: str, same: bool, reason: str) -> None`. Creates parent dirs and schema on open.
  - `CachedModels(inner, cache: DecisionCache, model_tag: str)` — same `ModelClient` surface as `inner`; `adjudicate_same_event` is memoized on `sha256(json([model_tag, a, b, context]))`; exposes `hits: int`, `misses: int`.
  - `Config.database_url` now defaults to the local DSN when `DATABASE_URL` unset.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_cache.py
from pipeline.cache import CachedModels, DecisionCache


class CountingModels:
    def __init__(self):
        self.calls = 0

    def adjudicate_same_event(self, a, b, context):
        self.calls += 1
        return True, f"call-{self.calls}"

    def enrich(self, title, summary):
        return "enriched"


def test_cache_roundtrip(tmp_path):
    cache = DecisionCache(str(tmp_path / "sub" / "d.sqlite"))
    assert cache.get("k") is None
    cache.put("k", False, "why")
    assert cache.get("k") == (False, "why")


def test_cached_models_memoizes_by_content(tmp_path):
    inner = CountingModels()
    models = CachedModels(inner, DecisionCache(str(tmp_path / "d.sqlite")), "test-model")
    a = {"title": "A", "summary": "s", "entities": ["x"]}
    b = {"title": "B", "summary": "t", "entities": ["y"]}

    first = models.adjudicate_same_event(a, b, "ctx")
    second = models.adjudicate_same_event(a, b, "ctx")
    assert first == second == (True, "call-1")
    assert inner.calls == 1
    assert (models.hits, models.misses) == (1, 1)

    models.adjudicate_same_event(a, b, "other ctx")   # different content -> miss
    assert inner.calls == 2


def test_cache_survives_reopen_and_ignores_ids(tmp_path):
    path = str(tmp_path / "d.sqlite")
    inner = CountingModels()
    CachedModels(inner, DecisionCache(path), "m").adjudicate_same_event(
        {"title": "A", "entities": []}, {"title": "B", "entities": []}, "c")
    # new process, new wrapper, same content -> hit
    models2 = CachedModels(CountingModels(), DecisionCache(path), "m")
    same, reason = models2.adjudicate_same_event(
        {"title": "A", "entities": []}, {"title": "B", "entities": []}, "c")
    assert reason == "call-1" and models2.hits == 1


def test_delegates_other_methods(tmp_path):
    models = CachedModels(CountingModels(), DecisionCache(str(tmp_path / "d.sqlite")), "m")
    assert models.enrich("t", None) == "enriched"


def test_database_url_defaults_local(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "a")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "t")
    from pipeline.config import load_config
    assert load_config().database_url == "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_cache.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.cache'`.

- [ ] **Step 3: Implement**

```python
# pipeline/cache.py
"""Content-keyed memo for adjudicator decisions.

Keys are sha256 over (model_tag, a, b, context) — pure content, never row ids
(ids regenerate on every experiment reset). Temperature-0 adjudication is
deterministic, so a cached verdict is exactly what the model would return;
repeat experiments only pay for decisions the config change actually altered.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from typing import Any


class DecisionCache:
    def __init__(self, path: str) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.execute(
            "create table if not exists adjudications ("
            "key text primary key, same integer not null, reason text not null)")
        self.conn.commit()

    def get(self, key: str) -> tuple[bool, str] | None:
        row = self.conn.execute(
            "select same, reason from adjudications where key = ?", (key,)).fetchone()
        return (bool(row[0]), row[1]) if row else None

    def put(self, key: str, same: bool, reason: str) -> None:
        self.conn.execute(
            "insert or replace into adjudications (key, same, reason) values (?, ?, ?)",
            (key, int(same), reason))
        self.conn.commit()


class CachedModels:
    """ModelClient wrapper: memoizes adjudicate_same_event, delegates the rest."""

    def __init__(self, inner: Any, cache: DecisionCache, model_tag: str) -> None:
        self.inner = inner
        self.cache = cache
        self.model_tag = model_tag
        self.hits = 0
        self.misses = 0

    def adjudicate_same_event(self, a: dict, b: dict, context: str) -> tuple[bool, str]:
        key = hashlib.sha256(
            json.dumps([self.model_tag, a, b, context], sort_keys=True, default=str)
            .encode()).hexdigest()
        cached = self.cache.get(key)
        if cached is not None:
            self.hits += 1
            return cached
        self.misses += 1
        same, reason = self.inner.adjudicate_same_event(a, b, context)
        if not reason.startswith("adjudicator_error"):  # never cache transient failures
            self.cache.put(key, same, reason)
        return same, reason

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)
```

Config change — in `pipeline/config.py`, `load_config()`, replace the `database_url` line:

```python
        database_url=os.environ.get(
            "DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"),
```

Append to `.gitignore`:

```
.cache/
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_cache.py tests/test_config.py -q`
Expected: PASS (7 tests — the two existing config tests still green).

- [ ] **Step 5: Commit**

```bash
git add pipeline/cache.py pipeline/config.py tests/test_cache.py .gitignore
git commit -m "feat: add content-keyed adjudicator decision cache

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: In-RAM replay window + store read additions

`ReplayStore` serves the two hot-path dedupe reads from a rolling deque; `Store` gains the two phase queries.

**Files:**
- Create: `pipeline/window.py`
- Modify: `pipeline/store.py` (two new read methods at the end of the class)
- Test: `tests/test_window.py`

**Interfaces:**
- Consumes: `Store` (Task 6 of parent plan), `pipeline.vectors.cosine` semantics (fp32 arrays).
- Produces:
  - `ReplayWindow(window_hours: float)` — `add(entry_id: str, episode_id: str, content_hash: str, published_at: datetime, vec: np.ndarray | None)`, `advance(t: datetime)` (evicts `published_at <= t - window_hours`), `content_hash_dup(hash_, t, window_hours) -> dict | None` (`{id, episode_id}`, newest match), `recent_embedded(t, window_hours) -> list[dict]` (`{id, episode_id, embedding}`).
  - `ReplayStore(db, window: ReplayWindow)` — subclass of `Store`; overrides exactly `content_hash_dup` and `recent_embedded` to hit the window.
  - `Store.entries_needing_features(limit: int | None) -> list[dict]` — `embedding is null and published_at is not null`, ordered by `published_at, id`; columns `id, title, summary, published_at, enriched_text, enricher_version, entity_set, event_keys`.
  - `Store.prepared_unclustered(limit: int | None, until: datetime | None) -> list[dict]` — `embedding is not null and episode_id is null and published_at is not null`, same ordering; columns everything the engine needs: `id, news_source_id, title, summary, published_at, content_hash, entity_set, event_keys, embedding` plus `split_part(ns.canonical_url, '/', 3) as agency`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_window.py
from datetime import datetime, timedelta, timezone

import numpy as np

from pipeline.window import ReplayWindow

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)


def vec(x):
    v = np.zeros(4, dtype=np.float32)
    v[x] = 1.0
    return v


def test_dup_and_embedded_within_window():
    w = ReplayWindow(window_hours=72.0)
    w.add("e1", "ep1", "hash-a", T0, vec(0))
    w.add("e2", "ep1", "hash-b", T0 + timedelta(hours=1), None)  # no embedding yet

    t = T0 + timedelta(hours=2)
    assert w.content_hash_dup("hash-a", t, 72.0) == {"id": "e1", "episode_id": "ep1"}
    assert w.content_hash_dup("hash-zz", t, 72.0) is None

    embedded = w.recent_embedded(t, 72.0)
    assert [r["id"] for r in embedded] == ["e1"]           # unembedded rows excluded
    assert np.allclose(embedded[0]["embedding"], vec(0))


def test_newest_match_wins():
    w = ReplayWindow(72.0)
    w.add("old", "ep1", "same", T0, None)
    w.add("new", "ep2", "same", T0 + timedelta(hours=5), None)
    dup = w.content_hash_dup("same", T0 + timedelta(hours=6), 72.0)
    assert dup == {"id": "new", "episode_id": "ep2"}


def test_advance_evicts_old_entries():
    w = ReplayWindow(72.0)
    w.add("e1", "ep1", "hash-a", T0, vec(0))
    w.advance(T0 + timedelta(hours=73))
    assert w.content_hash_dup("hash-a", T0 + timedelta(hours=73), 72.0) is None
    assert w.recent_embedded(T0 + timedelta(hours=73), 72.0) == []


def test_narrower_query_window_respected():
    # engine may query with a narrower window than the deque retains
    w = ReplayWindow(72.0)
    w.add("e1", "ep1", "hash-a", T0, vec(0))
    t = T0 + timedelta(hours=10)
    assert w.content_hash_dup("hash-a", t, 4.0) is None
    assert w.recent_embedded(t, 4.0) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_window.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.window'`.

- [ ] **Step 3: Implement**

```python
# pipeline/window.py
"""In-RAM rolling event-time window for replay runs.

Serves the two per-entry dedupe reads (content_hash_dup, recent_embedded)
from a deque instead of ~6.5k window queries against Postgres. The runner
feeds it after every attach and advances it with the event clock.
"""

from __future__ import annotations

from collections import deque
from datetime import datetime, timedelta

import numpy as np

from pipeline.store import Store


class ReplayWindow:
    def __init__(self, window_hours: float) -> None:
        self.window_hours = window_hours
        self._entries: deque[dict] = deque()  # ordered by published_at ascending

    def add(self, entry_id: str, episode_id: str, content_hash: str,
            published_at: datetime, vec: np.ndarray | None) -> None:
        self._entries.append({
            "id": entry_id, "episode_id": episode_id, "content_hash": content_hash,
            "published_at": published_at, "embedding": vec,
        })

    def advance(self, t: datetime) -> None:
        cutoff = t - timedelta(hours=self.window_hours)
        while self._entries and self._entries[0]["published_at"] <= cutoff:
            self._entries.popleft()

    def content_hash_dup(self, hash_: str, t: datetime, window_hours: float) -> dict | None:
        cutoff = t - timedelta(hours=window_hours)
        for row in reversed(self._entries):  # newest first
            if row["content_hash"] == hash_ and row["published_at"] > cutoff:
                return {"id": row["id"], "episode_id": row["episode_id"]}
        return None

    def recent_embedded(self, t: datetime, window_hours: float) -> list[dict]:
        cutoff = t - timedelta(hours=window_hours)
        return [
            {"id": r["id"], "episode_id": r["episode_id"], "embedding": r["embedding"]}
            for r in self._entries
            if r["embedding"] is not None and r["published_at"] > cutoff
        ]


class ReplayStore(Store):
    """Store with the two window reads served from RAM; everything else hits Postgres."""

    def __init__(self, db, window: ReplayWindow) -> None:
        super().__init__(db)
        self.window = window

    def content_hash_dup(self, hash_: str, t: datetime, window_hours: float) -> dict | None:
        return self.window.content_hash_dup(hash_, t, window_hours)

    def recent_embedded(self, t: datetime, window_hours: float) -> list[dict]:
        return self.window.recent_embedded(t, window_hours)
```

Append to `pipeline/store.py` inside `class Store` (after `storyline_episode_count`):

```python
    def entries_needing_features(self, limit: int | None = None) -> list[dict]:
        return self.db.all(
            """
            select id, title, summary, published_at, enriched_text, enricher_version,
                   entity_set, event_keys
            from public.news_entries
            where embedding is null and published_at is not null
            order by published_at, id
            limit %(limit)s
            """,
            {"limit": limit},
        )

    def prepared_unclustered(self, limit: int | None = None,
                             until: "datetime | None" = None) -> list[dict]:
        return self.db.all(
            """
            select ne.id, ne.news_source_id, ne.title, ne.summary, ne.published_at,
                   ne.content_hash, ne.entity_set, ne.event_keys, ne.embedding,
                   split_part(ns.canonical_url, '/', 3) as agency
            from public.news_entries ne
            join public.news_sources ns on ns.id = ne.news_source_id
            where ne.embedding is not null and ne.episode_id is null
              and ne.published_at is not null
              and (%(until)s::timestamptz is null or ne.published_at <= %(until)s)
            order by ne.published_at, ne.id
            limit %(limit)s
            """,
            {"limit": limit, "until": until},
        )
```

(Postgres treats `limit NULL` as no limit — both methods rely on that.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_window.py -q`
Expected: PASS (4 tests). Full suite still green: `uv run pytest -q`.

- [ ] **Step 5: Commit**

```bash
git add pipeline/window.py pipeline/store.py tests/test_window.py
git commit -m "feat: add in-ram replay window and phase read queries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `prepare` phase

Concurrent enrichment, batched embedding, extraction backfill — writes everything through `update_entry_features`, resumable via `embedding is null`.

**Files:**
- Create: `pipeline/runner.py` (this task adds `prepare`; Task 4 adds `cluster` to the same file)
- Test: `tests/test_prepare.py`

**Interfaces:**
- Consumes: `Store.entries_needing_features`, `Store.update_entry_features` (extended signature with `entity_set`/`event_keys`/`extractor_version`), `ModelClient.enrich`/`embed`, `pipeline.extraction.extract`/`EXTRACTOR_VERSION`, `pipeline.vectors.pack_fp16`, `Config`.
- Produces: `prepare(store, models, cfg: Config, limit: int | None = None, concurrency: int = 8, embed_batch: int = 96) -> dict` returning `{"prepared": int, "failed": int}`. Rules: enrichment only when `cfg.enrichment_enabled` and `enriched_text` is null (DB is the enrichment cache); embedding text = `enriched_text` else `"{title}. {summary}"`; extraction backfilled only when the entry's `entity_set` AND `event_keys` are both empty; a single entry's enrich failure falls back to raw text (never blocks the batch), an embed-batch failure marks those entries failed and continues.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_prepare.py
from datetime import datetime, timezone

import numpy as np

from pipeline.config import Config
from pipeline.runner import prepare

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


class PrepFakeStore:
    def __init__(self, rows):
        self.rows = rows
        self.features: dict[str, dict] = {}

    def entries_needing_features(self, limit=None):
        return self.rows[:limit] if limit else self.rows

    def update_entry_features(self, entry_id, enriched_text, enricher_version,
                              embedding, embedding_model,
                              entity_set=None, event_keys=None, extractor_version=None):
        self.features[entry_id] = {
            "enriched_text": enriched_text, "embedding": embedding,
            "embedding_model": embedding_model, "entity_set": entity_set,
            "event_keys": event_keys, "extractor_version": extractor_version,
        }


class PrepModels:
    def __init__(self, fail_enrich_for=()):
        self.embed_batches = []
        self.fail_enrich_for = fail_enrich_for

    def enrich(self, title, summary):
        if title in self.fail_enrich_for:
            raise RuntimeError("enrich boom")
        return f"ENRICHED {title}"

    def embed(self, texts):
        self.embed_batches.append(len(texts))
        return [np.ones(4, dtype=np.float32) for _ in texts]


def row(i, **kw):
    return {"id": f"n{i}", "title": f"FDA Recalls Valsatrex Lot {i}",
            "summary": "Sundexo Pharmaceuticals recall.", "published_at": T0,
            "enriched_text": None, "enricher_version": None,
            "entity_set": [], "event_keys": [], **kw}


def test_prepare_enriches_embeds_and_backfills_extraction():
    store = PrepFakeStore([row(1), row(2)])
    models = PrepModels()
    report = prepare(store, models, CFG, concurrency=2, embed_batch=96)
    assert report == {"prepared": 2, "failed": 0}
    feat = store.features["n1"]
    assert feat["enriched_text"].startswith("ENRICHED")
    assert feat["embedding"] is not None
    assert feat["embedding_model"] == CFG.embedding_model
    assert "valsatrex" in feat["entity_set"]          # extraction backfilled from RAW text
    assert feat["extractor_version"] == 1


def test_prepare_respects_existing_enrichment_and_anchors():
    store = PrepFakeStore([row(1, enriched_text="already enriched",
                               entity_set=["kept"], event_keys=["z-2026-1"])])
    models = PrepModels()
    prepare(store, models, CFG)
    feat = store.features["n1"]
    assert feat["enriched_text"] is None              # not re-enriched, not re-written
    assert feat["entity_set"] is None                 # anchors untouched when present
    assert feat["embedding"] is not None


def test_prepare_enrichment_disabled_embeds_raw():
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t",
                 enrichment_enabled=False)
    store = PrepFakeStore([row(1)])
    models = PrepModels()
    prepare(store, models, cfg)
    assert store.features["n1"]["enriched_text"] is None


def test_prepare_enrich_failure_falls_back_to_raw_text():
    store = PrepFakeStore([row(1, title="BOOM"), row(2)])
    models = PrepModels(fail_enrich_for=("BOOM",))
    report = prepare(store, models, CFG)
    assert report == {"prepared": 2, "failed": 0}     # fallback, not failure
    assert store.features["BOOM" and "n1"]["embedding"] is not None


def test_prepare_batches_embeddings():
    store = PrepFakeStore([row(i) for i in range(10)])
    models = PrepModels()
    prepare(store, models, CFG, embed_batch=4)
    assert models.embed_batches == [4, 4, 2]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_prepare.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.runner'`.

- [ ] **Step 3: Implement**

```python
# pipeline/runner.py
"""Two-phase runner.

prepare: per-entry features (enrich concurrent, embed batched, extraction
backfill) persisted once — the expensive, experiment-invariant half.
cluster (Task 4): event-time replay over cached features — the cheap half
experiments iterate on.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from pipeline.config import Config
from pipeline.extraction import EXTRACTOR_VERSION, extract
from pipeline.vectors import pack_fp16


def _fallback_text(row: dict) -> str:
    return f"{row['title']}. {row.get('summary') or ''}".strip()


def prepare(store, models, cfg: Config, limit: int | None = None,
            concurrency: int = 8, embed_batch: int = 96) -> dict:
    rows = store.entries_needing_features(limit)
    if not rows:
        return {"prepared": 0, "failed": 0}

    # enrichment (concurrent; DB column is the cache — skip rows that have it)
    def enrich_one(row: dict) -> str | None:
        if not cfg.enrichment_enabled or row.get("enriched_text"):
            return None
        try:
            return models.enrich(row["title"], row.get("summary"))
        except Exception:
            return None  # fall back to raw text; never block the batch

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        new_enrichments = list(pool.map(enrich_one, rows))

    embed_texts = [
        new or row.get("enriched_text") or _fallback_text(row)
        for row, new in zip(rows, new_enrichments)
    ]

    prepared = failed = 0
    for start in range(0, len(rows), embed_batch):
        chunk = list(zip(rows[start:start + embed_batch],
                         new_enrichments[start:start + embed_batch],
                         embed_texts[start:start + embed_batch]))
        try:
            vectors = models.embed([text for _, _, text in chunk])
        except Exception:
            failed += len(chunk)
            continue
        for (row, new_enrichment, _), vec in zip(chunk, vectors):
            needs_anchors = not row["entity_set"] and not row["event_keys"]
            entities, keys = extract(row["title"], row.get("summary")) if needs_anchors else (None, None)
            store.update_entry_features(
                row["id"],
                new_enrichment,
                cfg.enricher_version if new_enrichment else None,
                pack_fp16(vec), cfg.embedding_model,
                entity_set=entities, event_keys=keys,
                extractor_version=EXTRACTOR_VERSION if needs_anchors else None)
            prepared += 1
    return {"prepared": prepared, "failed": failed}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_prepare.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline/runner.py tests/test_prepare.py
git commit -m "feat: add prepare phase (concurrent enrich, batched embed, anchor backfill)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `cluster` phase

Event-time replay wiring engines + replay window + card generation, with end-of-run finalize.

**Files:**
- Modify: `pipeline/runner.py` (append `cluster`)
- Test: `tests/test_cluster_phase.py`

**Interfaces:**
- Consumes: `EpisodeEngine`, `StorylineEngine`, `CardEngine` (parent plan Tasks 6–7), `ReplayWindow`/`ReplayStore` (Task 2), `Store.prepared_unclustered`, `pipeline.vectors.unpack_fp16`.
- Produces: `cluster(store, models, cfg: Config, limit: int | None = None, until: "datetime | None" = None) -> dict` returning `{"processed": int, "episodes_closed": int}`. Behavior: loads the prepared stream once (already event-time ordered); per entry — `window.advance(t)` → `close_due(t)` → episode card generation for each close → `process_entry` → `window.add` with the attach result; after the stream, closes every remaining open episode and generates its cards (finalize). `store` may be a plain `Store`; `cluster` wraps it into a `ReplayStore` itself (callers never manage the window).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_cluster_phase.py
from datetime import datetime, timedelta, timezone

import numpy as np

from pipeline.config import Config
from pipeline.runner import cluster
from pipeline.vectors import pack_fp16
from tests.fakes import FakeStore

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


class ClusterFakeStore(FakeStore):
    """FakeStore + the reads cluster() needs beyond the engine surface."""

    def prepared_unclustered(self, limit=None, until=None):
        rows = sorted(
            (e for e in self.entries.values() if e["embedding"] is not None),
            key=lambda e: e["published_at"])
        if until:
            rows = [r for r in rows if r["published_at"] <= until]
        return rows[:limit] if limit else rows

    # CardEngine surface
    def episode_members(self, episode_id):
        return [
            {"id": e["id"], "title": e["title"], "summary": e.get("summary"),
             "published_at": e["published_at"], "is_syndicated": False}
            for e in self.entries.values() if e.get("episode_id") == episode_id
        ]

    def episode_cards_for(self, storyline_id):
        return [
            {"episode_id": c["episode_id"], "headline": c["headline"],
             "summary": c["summary"], "date": "2026-05-14"}
            for c in self.cards if c["kind"] == "episode"
            and c["storyline_id"] == storyline_id
        ]

    def storyline_episode_count(self, storyline_id):
        return self.storylines[storyline_id]["episode_count"]

    def insert_card(self, **kw):
        self.cards.append(kw)
        return f"card-{len(self.cards)}"

    # StorylineEngine surface (no prior storylines in these tests)
    def storylines_by_event_keys(self, keys):
        return []

    def storylines_by_entities(self, entities):
        return []

    def latest_overview(self, storyline_id):
        return None


class NoModels:
    def adjudicate_same_event(self, a, b, context):
        return False, "no"

    def compress_overview(self, storyline_summary, episode_cards):
        return {"headline": "h", "summary": "s",
                "timeline": [{"episode_id": str(c["episode_id"]), "date": c["date"],
                              "text": c["headline"]} for c in episode_cards],
                "rubric": {}, "reason": "r"}

    def embed(self, texts):
        return [np.ones(4, dtype=np.float32) for _ in texts]


def vec(axis):
    v = np.zeros(8, dtype=np.float32)
    v[axis] = 1.0
    return v


def add(store, i, hours, axis, hash_=None, entities=("valsatrex",)):
    return store.add_entry(
        title=f"item {i}", content_hash=hash_ or f"h{i}",
        published_at=T0 + timedelta(hours=hours),
        entity_set=list(entities), event_keys=[], embedding=pack_fp16(vec(axis)))


def test_cluster_replays_stream_and_finalizes():
    store = ClusterFakeStore()
    add(store, 1, 0, 0)                       # opens episode A
    add(store, 2, 1, 0, hash_="h1")           # content dup -> folds into A
    add(store, 3, 30, 3, entities=("oxprenol",))  # 30h later, unrelated -> episode B; A closes first

    report = cluster(store, NoModels(), CFG)
    assert report["processed"] == 3
    assert report["episodes_closed"] == 2     # A closed by dormancy mid-run, B by finalize
    assert all(e["status"] == "dormant" for e in store.episodes.values())
    episode_cards = [c for c in store.cards if c["kind"] == "episode"]
    assert len(episode_cards) == 2            # every closed episode got its card

    methods = [a["method"] for a in store.attaches]
    assert "content_hash" in methods          # window served the dup lookup


def test_cluster_until_and_limit():
    store = ClusterFakeStore()
    add(store, 1, 0, 0)
    add(store, 2, 100, 1, entities=("other",))
    report = cluster(store, NoModels(), CFG, until=T0 + timedelta(hours=1))
    assert report["processed"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_cluster_phase.py -q`
Expected: FAIL — `ImportError: cannot import name 'cluster'`.

- [ ] **Step 3: Implement — append to `pipeline/runner.py`**

```python
from datetime import datetime  # add to imports at top

from pipeline.cards import CardEngine
from pipeline.episodes import EpisodeEngine
from pipeline.storylines import StorylineEngine
from pipeline.vectors import unpack_fp16
from pipeline.window import ReplayStore, ReplayWindow


def cluster(store, models, cfg: Config, limit: int | None = None,
            until: "datetime | None" = None) -> dict:
    window = ReplayWindow(cfg.dedupe_window_hours)
    replay = store
    if hasattr(store, "db"):  # real Store -> wrap window reads; fakes serve their own
        replay = ReplayStore(store.db, window)
    else:
        replay = _WindowedFake(store, window)

    storyline_engine = StorylineEngine(replay, models, cfg)
    card_engine = CardEngine(replay, models, cfg)
    episode_engine = EpisodeEngine(replay, models, cfg, storyline_engine.resolve)

    rows = store.prepared_unclustered(limit=limit, until=until)
    processed = closed_count = 0
    for row in rows:
        t = row["published_at"]
        window.advance(t)
        for closed in episode_engine.close_due(t):
            card_engine.on_episode_closed(closed)
            closed_count += 1
        vec = unpack_fp16(row["embedding"])
        decision = episode_engine.process_entry(row, vec)
        window.add(row["id"], decision["episode_id"], row["content_hash"], t, vec)
        processed += 1

    # finalize: close every remaining open episode so the run is complete/comparable
    for episode in list(episode_engine._open_episodes()):
        if replay.close_episode(str(episode["id"])):
            card_engine.on_episode_closed(episode)
            closed_count += 1
    episode_engine._open = []

    return {"processed": processed, "episodes_closed": closed_count}


class _WindowedFake:
    """Test shim: route the two window reads through ReplayWindow, delegate the rest."""

    def __init__(self, inner, window: ReplayWindow) -> None:
        self._inner = inner
        self._window = window

    def content_hash_dup(self, hash_, t, window_hours):
        return self._window.content_hash_dup(hash_, t, window_hours)

    def recent_embedded(self, t, window_hours):
        return self._window.recent_embedded(t, window_hours)

    def __getattr__(self, name):
        return getattr(self._inner, name)
```

Note: `_WindowedFake` exists so unit tests exercise the same window path production uses; a real `Store` (has `.db`) gets the `ReplayStore` subclass.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_cluster_phase.py -q`
Expected: PASS (2 tests). Full suite green: `uv run pytest -q`.

- [ ] **Step 5: Commit**

```bash
git add pipeline/runner.py tests/test_cluster_phase.py
git commit -m "feat: add cluster replay phase with in-ram window and finalize

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `reset` + `sync` bench tools (local-DSN guarded)

Direct-SQL lab tools: wipe decisions (never features) between experiments; copy the hosted corpus down once, preserving ids.

**Files:**
- Create: `pipeline/bench.py`
- Test: `tests/test_bench.py`

**Interfaces:**
- Consumes: `Db` (raw `conn`), PostgREST over httpx (transport injectable), `.env` keys `SUPABASE_URL`/`SUPABASE_SECRET_KEY`.
- Produces:
  - `assert_local_dsn(dsn: str) -> None` — raises `RuntimeError` unless host is `127.0.0.1`/`localhost`/empty.
  - `reset_clusters(db: Db) -> None` — truncates `event_cards`, `episode_entries`, `episodes`, `storylines`, `entity_stats` (FK-safe order, CASCADE) and nulls `news_entries.episode_id`. Features survive.
  - `reset_features(db: Db) -> None` — additionally nulls `embedding`, `embedding_model`, `enriched_text`, `enricher_version` and empties `entity_set`/`event_keys`/`extractor_version`.
  - `sync_corpus(db: Db, supabase_url: str, secret_key: str, page: int = 1000, transport=None) -> dict` returning `{"sources": int, "entries": int, "skipped": int}` — pages hosted `news_entries` + referenced `news_sources` via PostgREST, inserts locally **preserving ids**, `on conflict do nothing` (rerun-safe).
  - Both `reset_*` and `sync_corpus` call `assert_local_dsn(db.conn.info.dsn)` first.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_bench.py
import json

import httpx
import pytest

from pipeline.bench import assert_local_dsn, reset_clusters, sync_corpus


class FakeConnInfo:
    def __init__(self, dsn):
        self.dsn = dsn


class FakeConn:
    def __init__(self, dsn="postgresql://postgres:postgres@127.0.0.1:54322/postgres"):
        self.info = FakeConnInfo(dsn)
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((" ".join(sql.split()), params))


class FakeDb:
    def __init__(self, dsn="postgresql://postgres:postgres@127.0.0.1:54322/postgres"):
        self.conn = FakeConn(dsn)


def test_local_dsn_guard():
    assert_local_dsn("postgresql://postgres:pw@127.0.0.1:54322/postgres")
    assert_local_dsn("postgresql://postgres:pw@localhost/postgres")
    with pytest.raises(RuntimeError):
        assert_local_dsn("postgresql://postgres.ref@aws-1-us-east-2.pooler.supabase.com:5432/postgres")


def test_reset_clusters_wipes_decisions_not_features():
    db = FakeDb()
    reset_clusters(db)
    sql = " ; ".join(s for s, _ in db.conn.executed)
    assert "truncate" in sql and "episode_entries" in sql and "entity_stats" in sql
    assert "set episode_id = null" in sql
    assert "embedding" not in sql          # features untouched


def test_reset_refuses_remote_dsn():
    with pytest.raises(RuntimeError):
        reset_clusters(FakeDb("postgresql://u:p@db.example.supabase.co/postgres"))


def test_sync_copies_pages_and_preserves_ids():
    sources = [{"id": "s-1", "canonical_url": "https://fda.gov/f.xml",
                "source_type": "rss", "title": None}]
    page1 = [{"id": f"e-{i}", "news_source_id": "s-1", "url": f"https://fda.gov/{i}",
              "url_canonical": f"https://fda.gov/{i}", "title": f"t{i}", "summary": "s",
              "published_at": "2026-05-14T14:00:00+00:00",
              "fetched_at": "2026-05-14T14:00:00+00:00",
              "content_hash": "ab" * 32, "extractor_version": 1} for i in range(2)]

    def handler(request):
        if "news_sources" in str(request.url):
            return httpx.Response(200, json=sources)
        offset = int(dict(request.url.params)["offset"])
        return httpx.Response(200, json=page1 if offset == 0 else [])

    db = FakeDb()
    report = sync_corpus(db, "https://x.supabase.co", "key",
                         page=1000, transport=httpx.MockTransport(handler))
    assert report["sources"] == 1 and report["entries"] == 2
    inserts = [s for s, _ in db.conn.executed if s.startswith("insert")]
    assert any("news_sources" in s for s in inserts)
    entry_insert = next(p for s, p in db.conn.executed
                        if s.startswith("insert into public.news_entries"))
    assert entry_insert["id"] == "e-0"     # hosted id preserved
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_bench.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.bench'`.

- [ ] **Step 3: Implement**

```python
# pipeline/bench.py
"""Lab-bench tools: experiment resets and hosted->local corpus sync.

Direct SQL by design (the RPC-only rule protects the production write path;
these are local tooling) — therefore hard-guarded to localhost DSNs.
"""

from __future__ import annotations

from urllib.parse import urlsplit

import httpx

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "", None}


def assert_local_dsn(dsn: str) -> None:
    host = urlsplit(dsn if "//" in dsn else f"//{dsn}").hostname
    if host not in _LOCAL_HOSTS:
        raise RuntimeError(
            f"refusing to run bench tool against non-local database host: {host!r}")


def reset_clusters(db) -> None:
    """Wipe clustering decisions between experiments. Features survive."""
    assert_local_dsn(db.conn.info.dsn)
    db.conn.execute(
        "truncate public.event_cards, public.episode_entries, public.episodes, "
        "public.storylines, public.entity_stats cascade")
    db.conn.execute("update public.news_entries set episode_id = null "
                    "where episode_id is not null")


def reset_features(db) -> None:
    """Full wipe: decisions + per-entry features. Use when swapping models."""
    reset_clusters(db)
    db.conn.execute(
        "update public.news_entries set embedding = null, embedding_model = null, "
        "enriched_text = null, enricher_version = null, "
        "entity_set = '{}', event_keys = '{}', extractor_version = null")


_SOURCE_COLS = ("id", "canonical_url", "source_type", "title")
_ENTRY_COLS = ("id", "news_source_id", "url", "url_canonical", "title", "summary",
               "published_at", "fetched_at", "content_hash", "extractor_version")


def sync_corpus(db, supabase_url: str, secret_key: str, page: int = 1000,
                transport=None) -> dict:
    """Copy hosted corpus to local, preserving ids. Rerun-safe (conflict-skips)."""
    assert_local_dsn(db.conn.info.dsn)
    base = supabase_url.rstrip("/") + "/rest/v1"
    http = httpx.Client(
        headers={"apikey": secret_key, "Authorization": f"Bearer {secret_key}"},
        timeout=60, transport=transport)

    entries: list[dict] = []
    offset = 0
    while True:
        response = http.get(
            f"{base}/news_entries", params={
                "select": ",".join(_ENTRY_COLS),
                "order": "published_at.asc,id.asc",
                "offset": offset, "limit": page})
        response.raise_for_status()
        batch = response.json()
        entries.extend(batch)
        if len(batch) < page:
            break
        offset += page

    source_ids = sorted({e["news_source_id"] for e in entries})
    response = http.get(
        f"{base}/news_sources", params={
            "select": ",".join(_SOURCE_COLS),
            "id": f"in.({','.join(source_ids)})"})
    response.raise_for_status()
    sources = response.json()

    def insert(table: str, cols: tuple[str, ...], row: dict) -> None:
        placeholders = ", ".join(f"%({c})s" for c in cols)
        db.conn.execute(
            f"insert into public.{table} ({', '.join(cols)}) "
            f"values ({placeholders}) on conflict do nothing",
            {c: row.get(c) for c in cols})

    for source in sources:
        insert("news_sources", _SOURCE_COLS, source)
    skipped = 0
    for entry in entries:
        insert("news_entries", _ENTRY_COLS, entry)
    return {"sources": len(sources), "entries": len(entries), "skipped": skipped}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_bench.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Integration check against local stack** (requires `pnpm supabase start`)

```bash
uv run python -c "
from pipeline.bench import sync_corpus
from pipeline.db import Db
from pipeline.config import load_config
import os
cfg = load_config()
db = Db(cfg.database_url)
print(sync_corpus(db, os.environ['SUPABASE_URL'], os.environ['SUPABASE_SECRET_KEY']))"
```

Expected: `{'sources': ~25-30, 'entries': 6553, 'skipped': 0}`; rerun prints the same and inserts nothing new. (`SUPABASE_URL`/`SUPABASE_SECRET_KEY` come from the repo root `.env`.)

- [ ] **Step 6: Commit**

```bash
git add pipeline/bench.py tests/test_bench.py
git commit -m "feat: add local-guarded reset and hosted corpus sync bench tools

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `experiment` wrapper, report, and CLI

One command per experiment: reset → cluster (cached models) → summary report with config snapshot. Plus the argparse CLI tying every phase together.

**Files:**
- Create: `pipeline/experiment.py`, `pipeline/cli.py`
- Test: `tests/test_experiment.py`

**Interfaces:**
- Consumes: everything above; `dataclasses.asdict(cfg)`.
- Produces:
  - `summarize(db) -> dict` — plain-SQL stats: totals (`entries_clustered`, `episodes`, `storylines`, `cards`), `entry_attach_mix` (method → count), `episode_attach_mix`, `singleton_episode_rate`, `multi_episode_storylines`, `top_chains` (10 × `{episodes, headline}`).
  - `render_report(name: str, cfg: Config, cluster_report: dict, summary: dict, cache_stats: dict, duration_s: float) -> str` — markdown.
  - `run_experiment(db, store, models, cfg, name: str, limit=None, until=None, out_dir="docs/eval") -> str` — reset_clusters → cluster → summarize → writes `<out_dir>/<name>/report.md`, returns path. `models` should already be cache-wrapped by the caller; `cache_stats` read from `getattr(models, "hits"/"misses", 0)`.
  - CLI (`python -m pipeline.cli`):
    - `sync` — hosted → local corpus copy.
    - `prepare [--limit N] [--concurrency 8] [--stub]`
    - `cluster [--limit N] [--until ISO] [--stub] [--no-cache]`
    - `reset --clusters | --features`
    - `experiment NAME [--limit N] [--until ISO] [--stub] [--no-cache] [--out docs/eval]`
    - `--stub` swaps `WorkersAI` for `StubModels`; cache wraps either (tag `stub` vs `cfg.adjudicator_model`); every command prints a JSON report line to stdout.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_experiment.py
from pipeline.config import Config
from pipeline.experiment import render_report

CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


def test_render_report_contains_config_stats_and_chains():
    summary = {
        "entries_clustered": 1000, "episodes": 420, "storylines": 380, "cards": 460,
        "entry_attach_mix": {"new_cluster": 380, "content_hash": 40},
        "episode_attach_mix": {"new_storyline": 380, "event_key": 25},
        "singleton_episode_rate": 0.62,
        "multi_episode_storylines": 31,
        "top_chains": [{"episodes": 4, "headline": "Valsatrex recall widens"}],
    }
    report = render_report(
        "baseline", CFG, {"processed": 1000, "episodes_closed": 420},
        summary, {"hits": 12, "misses": 3}, duration_s=42.5)
    assert "# Experiment: baseline" in report
    assert '"near_dup_threshold": 0.9' in report        # full config snapshot embedded
    assert "content_hash: 40" in report
    assert "Valsatrex recall widens" in report
    assert "cache 12 hits / 3 misses" in report
    assert "42.5s" in report


def test_render_report_empty_run():
    report = render_report("empty", CFG, {"processed": 0, "episodes_closed": 0},
                           {"entries_clustered": 0, "episodes": 0, "storylines": 0,
                            "cards": 0, "entry_attach_mix": {}, "episode_attach_mix": {},
                            "singleton_episode_rate": None,
                            "multi_episode_storylines": 0, "top_chains": []},
                           {"hits": 0, "misses": 0}, duration_s=0.1)
    assert "# Experiment: empty" in report
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_experiment.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.experiment'`.

- [ ] **Step 3: Implement**

```python
# pipeline/experiment.py
"""One-command experiment: reset -> cluster -> summarize -> report.

Reports are the lab notebook: every run embeds its full resolved Config,
so two reports diff cleanly and no result is ambiguous about its settings.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict

from pipeline.bench import reset_clusters
from pipeline.config import Config
from pipeline.runner import cluster


def summarize(db) -> dict:
    def mix(sql: str) -> dict:
        return {r["attach_method"]: r["n"] for r in db.all(sql)}

    totals = db.one("""
        select
          (select count(*) from public.news_entries where episode_id is not null) as entries_clustered,
          (select count(*) from public.episodes) as episodes,
          (select count(*) from public.storylines) as storylines,
          (select count(*) from public.event_cards) as cards
    """)
    singleton = db.one(
        "select round(avg((entry_count = 1)::int)::numeric, 3) as rate from public.episodes")
    multi = db.one("""
        select count(*) as n from public.storylines
        where episode_count >= 2 and merged_into is null
    """)
    chains = db.all("""
        select s.episode_count as episodes, coalesce(c.headline, '(no card)') as headline
        from public.storylines s
        left join public.event_cards c on c.id = s.latest_card_id
        where s.merged_into is null
        order by s.episode_count desc, s.entry_count desc limit 10
    """)
    return {
        **totals,
        "entry_attach_mix": mix(
            "select attach_method, count(*) as n from public.episode_entries "
            "group by 1 order by n desc"),
        "episode_attach_mix": mix(
            "select attach_method, count(*) as n from public.episodes "
            "group by 1 order by n desc"),
        "singleton_episode_rate": float(singleton["rate"]) if singleton["rate"] is not None else None,
        "multi_episode_storylines": multi["n"],
        "top_chains": chains,
    }


def render_report(name: str, cfg: Config, cluster_report: dict, summary: dict,
                  cache_stats: dict, duration_s: float) -> str:
    redacted = {k: v for k, v in asdict(cfg).items()
                if k not in ("database_url", "cf_account_id", "cf_api_token")}
    lines = [
        f"# Experiment: {name}", "",
        f"Duration: {duration_s}s — processed {cluster_report['processed']}, "
        f"closed {cluster_report['episodes_closed']} episodes, "
        f"cache {cache_stats.get('hits', 0)} hits / {cache_stats.get('misses', 0)} misses.", "",
        "## Totals", "",
        f"- entries clustered: {summary['entries_clustered']}",
        f"- episodes: {summary['episodes']}  storylines: {summary['storylines']}  cards: {summary['cards']}",
        f"- singleton-episode rate: {summary['singleton_episode_rate']}",
        f"- multi-episode storylines: {summary['multi_episode_storylines']}", "",
        "## Attach mix (entry -> episode)", "",
        *[f"- {m}: {n}" for m, n in summary["entry_attach_mix"].items()],
        "", "## Attach mix (episode -> storyline)", "",
        *[f"- {m}: {n}" for m, n in summary["episode_attach_mix"].items()],
        "", "## Top chains", "",
        *[f"- [{c['episodes']} episodes] {c['headline']}" for c in summary["top_chains"]],
        "", "## Config", "",
        "```json", json.dumps(redacted, indent=2, sort_keys=True), "```", "",
    ]
    return "\n".join(lines)


def run_experiment(db, store, models, cfg: Config, name: str,
                   limit: int | None = None, until=None,
                   out_dir: str = "docs/eval") -> str:
    started = time.monotonic()
    reset_clusters(db)
    cluster_report = cluster(store, models, cfg, limit=limit, until=until)
    duration = round(time.monotonic() - started, 1)
    report = render_report(
        name, cfg, cluster_report, summarize(db),
        {"hits": getattr(models, "hits", 0), "misses": getattr(models, "misses", 0)},
        duration)
    path = os.path.join(out_dir, name, "report.md")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(report)
    return path
```

```python
# pipeline/cli.py
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime

from pipeline.cache import CachedModels, DecisionCache
from pipeline.config import load_config
from pipeline.db import Db
from pipeline.store import Store

CACHE_PATH = ".cache/decisions.sqlite"


def _models(cfg, stub: bool, no_cache: bool):
    if stub:
        from pipeline.stub import StubModels
        inner, tag = StubModels(), "stub"
    else:
        from pipeline.ai import WorkersAI
        inner, tag = WorkersAI(cfg), cfg.adjudicator_model
    if no_cache:
        return inner
    return CachedModels(inner, DecisionCache(CACHE_PATH), tag)


def _until(value: str | None):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def main() -> None:
    parser = argparse.ArgumentParser(prog="pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("sync", help="copy hosted corpus into local db (id-preserving)")

    p = sub.add_parser("prepare", help="enrich+embed+extract unfeatured entries")
    p.add_argument("--limit", type=int)
    p.add_argument("--concurrency", type=int, default=8)
    p.add_argument("--stub", action="store_true")

    p = sub.add_parser("cluster", help="event-time clustering replay")
    p.add_argument("--limit", type=int)
    p.add_argument("--until")
    p.add_argument("--stub", action="store_true")
    p.add_argument("--no-cache", action="store_true")

    p = sub.add_parser("reset", help="wipe experiment state (local db only)")
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--clusters", action="store_true")
    group.add_argument("--features", action="store_true")

    p = sub.add_parser("experiment", help="reset + cluster + report, one command")
    p.add_argument("name")
    p.add_argument("--limit", type=int)
    p.add_argument("--until")
    p.add_argument("--stub", action="store_true")
    p.add_argument("--no-cache", action="store_true")
    p.add_argument("--out", default="docs/eval")

    args = parser.parse_args()
    cfg = load_config()
    db = Db(cfg.database_url)
    store = Store(db)

    if args.command == "sync":
        from pipeline.bench import sync_corpus
        out = sync_corpus(db, os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    elif args.command == "prepare":
        from pipeline.runner import prepare
        out = prepare(store, _models(cfg, args.stub, no_cache=True), cfg,
                      limit=args.limit, concurrency=args.concurrency)
    elif args.command == "cluster":
        from pipeline.runner import cluster
        out = cluster(store, _models(cfg, args.stub, args.no_cache), cfg,
                      limit=args.limit, until=_until(args.until))
    elif args.command == "reset":
        from pipeline.bench import reset_clusters, reset_features
        (reset_features if args.features else reset_clusters)(db)
        out = {"reset": "features" if args.features else "clusters"}
    elif args.command == "experiment":
        from pipeline.experiment import run_experiment
        path = run_experiment(db, store, _models(cfg, args.stub, args.no_cache), cfg,
                              args.name, limit=args.limit, until=_until(args.until),
                              out_dir=args.out)
        out = {"report": path}
    print(json.dumps(out, default=str))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest -q`
Expected: PASS (full suite; new tests included).

- [ ] **Step 5: End-to-end smoke on the local stack** (requires `pnpm supabase start` + corpus synced via Task 5 Step 5)

```bash
uv run python -m pipeline.cli prepare --stub --limit 200
uv run python -m pipeline.cli experiment smoke-stub --stub --limit 200
cat docs/eval/smoke-stub/report.md
uv run python -m pipeline.cli experiment smoke-stub-2 --stub --limit 200
```

Expected: first command reports `{"prepared": 200, "failed": 0}`; report renders totals + attach mix + config; second experiment completes in seconds with an attach mix identical to `smoke-stub` (stub + cache determinism). Cache hits are > 0 only if the subset produced adjudicator calls — either way both reports must match.

- [ ] **Step 6: Commit**

```bash
git add pipeline/experiment.py pipeline/cli.py tests/test_experiment.py docs/eval/
git commit -m "feat: add experiment wrapper, summary report, and pipeline cli

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

---

### Task 7: Persist experiment runs to the database

Experiments are DB records, not files. The clustering output itself already lives in the clustering tables (storylines/episodes/episode_entries/event_cards + audit columns — the dashboard can render chains and drill to raw entries from those alone). This task adds the missing piece: an `experiment_runs` row per run carrying the config snapshot and summary stats, so the dashboard can list runs and label what it is looking at. `report.md` stays as a convenience artifact derived from the same record.

**Files:**
- Create: `supabase/migrations/20260718100200_create_experiment_runs.sql`
- Test: `supabase/tests/database/experiment_runs.test.sql`
- Modify: `pipeline/experiment.py` (insert the run row from `run_experiment`)
- Test: `tests/test_experiment.py` (extend)

**Interfaces:**
- Consumes: `Db.conn.execute` (direct insert — experiments are local-guarded already via `reset_clusters`), `summarize()`/`render_report()` from Task 6.
- Produces:
  - `public.experiment_runs(id uuid PK, name text, started_at timestamptz, finished_at timestamptz, config jsonb, cluster_report jsonb, summary jsonb, cache_hits int, cache_misses int, created_at timestamptz)` — RLS enabled, `select` granted to `service_role` only (dashboard read path), no write grants (bench writes run as local superuser; hosted rows would come via a future RPC if ever needed).
  - `record_run(db, name: str, cfg: Config, cluster_report: dict, summary: dict, cache_stats: dict, started_at, finished_at) -> str` in `pipeline/experiment.py` — inserts and returns the run id; secrets (`database_url`, `cf_account_id`, `cf_api_token`) stripped from the config jsonb (same redaction as `render_report`).
  - `run_experiment(...)` return value becomes `{"report": path, "run_id": id}` — CLI prints both.
- Note for the dashboard follow-up: "current clusters" = the clustering tables as-is (latest run's state — `reset --clusters` wipes them per run); "run history" = `experiment_runs`. A future variant that snapshots cluster assignments per run (`run_id` on a junction copy) is deliberately deferred until the dashboard design needs it.

- [ ] **Step 1: Write the failing pgTAP test**

```sql
-- supabase/tests/database/experiment_runs.test.sql
begin;

select plan(4);

select has_table('public', 'experiment_runs', 'experiment_runs table exists');

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname = 'experiment_runs'
    ),
    'RLS enabled on experiment_runs'
);

select ok(
    not has_table_privilege('anon', 'public.experiment_runs', 'select')
    and has_table_privilege('service_role', 'public.experiment_runs', 'select')
    and not has_table_privilege('service_role', 'public.experiment_runs', 'insert'),
    'grants: service_role read-only, anon nothing'
);

select throws_ok(
    $$insert into public.experiment_runs (name, started_at, finished_at)
      values ('', now(), now())$$,
    '23514',
    null,
    'empty name rejected'
);

select * from finish();

rollback;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm supabase test db`
Expected: FAIL — `experiment_runs table exists`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260718100200_create_experiment_runs.sql
begin;

create table public.experiment_runs (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    started_at timestamptz not null,
    finished_at timestamptz not null,
    config jsonb,
    cluster_report jsonb,
    summary jsonb,
    cache_hits integer not null default 0,
    cache_misses integer not null default 0,
    created_at timestamptz not null default now(),
    constraint experiment_runs_name_bounded
        check (length(name) between 1 and 128),
    constraint experiment_runs_window_valid
        check (started_at <= finished_at),
    constraint experiment_runs_config_valid
        check (config is null or (
            jsonb_typeof(config) = 'object'
            and pg_catalog.pg_column_size(config) <= 16384)),
    constraint experiment_runs_cluster_report_valid
        check (cluster_report is null or (
            jsonb_typeof(cluster_report) = 'object'
            and pg_catalog.pg_column_size(cluster_report) <= 16384)),
    constraint experiment_runs_summary_valid
        check (summary is null or (
            jsonb_typeof(summary) = 'object'
            and pg_catalog.pg_column_size(summary) <= 65536)),
    constraint experiment_runs_cache_counts_nonnegative
        check (cache_hits >= 0 and cache_misses >= 0)
);

comment on table public.experiment_runs is
    'One row per clustering experiment run: resolved config snapshot, cluster report, and summary stats. Clustering tables hold the latest run''s actual clusters; this table is the run history the dashboard lists.';

create index experiment_runs_created_idx
    on public.experiment_runs (created_at desc);

alter table public.experiment_runs enable row level security;

revoke all privileges on table public.experiment_runs
    from public, anon, authenticated, service_role;

grant select on table public.experiment_runs to service_role;

commit;
```

- [ ] **Step 4: Apply and run pgTAP**

Run: `pnpm supabase migration up && pnpm supabase test db`
Expected: PASS — 4 new assertions green, all prior suites green. Then apply to hosted the same way as `100000`/`100100` (Management API or `db push`) so schemas stay aligned — the table simply stays empty on hosted.

- [ ] **Step 5: Extend the failing Python test**

Append to `tests/test_experiment.py`:

```python
def test_record_run_inserts_redacted_config():
    from pipeline.experiment import record_run

    class RecordingConn:
        def __init__(self):
            self.executed = []
            class Info:  # local DSN so nothing guards against it
                dsn = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
            self.info = Info()

        def execute(self, sql, params=None):
            self.executed.append((" ".join(sql.split()), params))
            class Cursor:
                def fetchone(_self):
                    return {"id": "run-1"}
            return Cursor()

    class RecordingDb:
        def __init__(self):
            self.conn = RecordingConn()

    from datetime import datetime, timezone
    t = datetime(2026, 5, 14, tzinfo=timezone.utc)
    db = RecordingDb()
    run_id = record_run(db, "baseline", CFG, {"processed": 10, "episodes_closed": 4},
                        {"episodes": 4}, {"hits": 1, "misses": 2}, t, t)
    assert run_id == "run-1"
    sql, params = db.conn.executed[0]
    assert sql.startswith("insert into public.experiment_runs")
    assert "cf_api_token" not in params["config"]
    assert '"near_dup_threshold": 0.9' in params["config"]
```

- [ ] **Step 6: Run test to verify it fails**

Run: `uv run pytest tests/test_experiment.py -q`
Expected: FAIL — `ImportError: cannot import name 'record_run'`.

- [ ] **Step 7: Implement — add to `pipeline/experiment.py`**

```python
def _redacted_config(cfg: Config) -> dict:
    return {k: v for k, v in asdict(cfg).items()
            if k not in ("database_url", "cf_account_id", "cf_api_token")}


def record_run(db, name: str, cfg: Config, cluster_report: dict, summary: dict,
               cache_stats: dict, started_at, finished_at) -> str:
    cursor = db.conn.execute(
        "insert into public.experiment_runs "
        "(name, started_at, finished_at, config, cluster_report, summary, "
        " cache_hits, cache_misses) "
        "values (%(name)s, %(started_at)s, %(finished_at)s, %(config)s::jsonb, "
        "        %(cluster_report)s::jsonb, %(summary)s::jsonb, %(hits)s, %(misses)s) "
        "returning id",
        {"name": name, "started_at": started_at, "finished_at": finished_at,
         "config": json.dumps(_redacted_config(cfg), sort_keys=True),
         "cluster_report": json.dumps(cluster_report, default=str),
         "summary": json.dumps(summary, default=str),
         "hits": cache_stats.get("hits", 0), "misses": cache_stats.get("misses", 0)})
    return str(cursor.fetchone()["id"])
```

Then in `run_experiment`: capture `started = datetime.now(timezone.utc)` before `reset_clusters` and `finished = datetime.now(timezone.utc)` after `cluster`; after writing `report.md` call `record_run(...)` and return `{"report": path, "run_id": run_id}` instead of the bare path. Update `render_report` usage accordingly (it already receives the same dicts) and change `run_experiment`'s callers: the CLI `experiment` branch becomes

```python
        out = run_experiment(db, store, _models(cfg, args.stub, args.no_cache), cfg,
                             args.name, limit=args.limit, until=_until(args.until),
                             out_dir=args.out)
```

(the function now returns the dict; no wrapping needed). Also update `render_report`'s duration to `round((finished - started).total_seconds(), 1)` and reuse `_redacted_config` inside it (replacing its inline redaction dict).

- [ ] **Step 8: Run tests to verify they pass**

Run: `uv run pytest -q`
Expected: PASS (full suite).

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260718100200_create_experiment_runs.sql supabase/tests/database/experiment_runs.test.sql pipeline/experiment.py tests/test_experiment.py
git commit -m "feat: persist experiment runs to db for dashboard consumption

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## The experiment loop this enables (runbook)

```bash
# one-time setup
pnpm supabase start                                   # local stack (migrations already applied)
uv run python -m pipeline.cli sync                    # hosted corpus -> local (6,553 entries)
uv run python -m pipeline.cli prepare                 # enrich+embed once (~10-15 min real models)

# iterate — each line is one experiment, seconds-to-minutes apiece
uv run python -m pipeline.cli experiment baseline --limit 1000
NEAR_DUP_THRESHOLD=0.87 uv run python -m pipeline.cli experiment near-dup-0.87 --limit 1000
AMBIENT_EMA_CEILING=5 uv run python -m pipeline.cli experiment ema-5 --limit 1000
ENRICHMENT_ENABLED=false uv run python -m pipeline.cli experiment no-enrich --limit 1000   # needs reset --features + re-prepare first

# compare
diff docs/eval/baseline/report.md docs/eval/near-dup-0.87/report.md
```

Note on the enrichment A/B: embeddings are computed from enriched text, so `no-enrich` requires `reset --features` + `ENRICHMENT_ENABLED=false prepare` first — it is a feature-level experiment, not a threshold-level one. The report's config snapshot records which mode produced it.

## Deliberately out of scope

- Full evaluation harness (Task 9 of the parent plan: calibration percentiles, label sheets, B-Cubed) — manual eval first, per direction; `summarize()` covers the eyeball stats.
- Operator-dashboard integration and ALL cluster visualization — the dashboard renders chains/clusters/raw entries straight from the clustering tables and lists runs from `experiment_runs`; the CLI only executes and persists.
- Compression-call caching (ids in output; low volume).
- Hosted-target runs (pooler DSN) — bench tools structurally refuse; revisit when clustering is validated.

