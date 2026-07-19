# Simplified Storyline Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second, simpler aggregation engine (`spine/`) — entity-lossless enrichment → member-embedding retrieval → listwise LLM judge → gap-based episodes → global theme sweep — selectable via `LAB_ENGINE=spine` in the existing experiment harness. (Golden scoring deliberately excluded: `golden_news_entries` is not yet QAed — its labels must not drive decisions.)

**Architecture:** Spine reuses the whole `pipeline/` seam (`Db`, `Store`, `vectors`, `cards`, `window`, `cache`, `bench`, `experiment`, `rank`) and writes the same derived tables (`episodes`, `storylines`, `event_cards`, `topic_themes`), so summarize/report/`experiment_runs`/rank-snapshot work unchanged. New code is five focused modules under `spine/`. Design and research rationale: `docs/superpowers/specs/2026-07-19-simplified-storyline-spine-design.md`.

**Tech Stack:** Python 3.12, numpy, psycopg (existing deps only — no scipy/sklearn), pytest with `tests/fakes.py` FakeStore + `pipeline.stub.StubModels`; TypeScript only for the one-array whitelist change in `apps/operator-console/src/lab/harness.ts`.

## Global Constraints

- Working dir for all Python commands: repo root. Run tests with `uv run pytest ...`.
- Never touch `pipeline/episodes.py`, `storylines.py`, `topics.py`, `promotion.py`, `categories.py` (classic engine stays byte-identical; `categories.CategoryEngine` is *imported* by spine, not modified).
- All DB writes go through existing `Store` RPС methods; no new migrations. New `Store` methods are reads only.
- Determinism invariants: never order or tie-break on row ids (they regenerate every replay); decision-cache keys are content-only (follow `pipeline/cache.py` header comment); all replay iteration ordered by `(published_at, id)` comes from `store.prepared_unclustered` as-is.
- LLM failures never block replay: catch, fall back to the split-biased action (new storyline / keep theme unnamed), count in `models.errors`.
- Config defaults (exact values): `engine="classic"`, `spine_sim_floor=0.60`, `spine_top_k=3`, `spine_episode_gap_hours=48.0`, `spine_embed_source="enriched"`, `spine_theme_min_size=5`, `spine_theme_link_sim=0.55`, `spine_theme_sweep_interval_hours=168.0`, `spine_theme_keep_overlap=0.5`.
- Env names (exact): `LAB_ENGINE`, `SPINE_SIM_FLOOR`, `SPINE_TOP_K`, `SPINE_EPISODE_GAP_HOURS`, `SPINE_EMBED_SOURCE`, `SPINE_THEME_MIN_SIZE`, `SPINE_THEME_LINK_SIM`, `SPINE_THEME_SWEEP_INTERVAL_HOURS`, `SPINE_THEME_KEEP_OVERLAP`.
- Local DB is port 57422: `export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:57422/postgres'` for any non-test CLI command. `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` must be set even for `--stub`.
- Commit after every task (at minimum); `git add` only files the task names.

---

### Task 1: Config knobs, engine dispatch, harness whitelist

**Files:**
- Modify: `pipeline/config.py`
- Modify: `pipeline/experiment.py:246` (the `cluster(...)` call site in `run_experiment`)
- Modify: `apps/operator-console/src/lab/harness.ts:4-19` (`LAB_ENV_WHITELIST`)
- Create: `spine/__init__.py` (empty)
- Create: `spine/replay.py` (walking skeleton — replaced in Task 5)
- Create: `tests/test_spine_config.py`

**Interfaces:**
- Produces: `Config.engine: str` plus the nine `spine_*` fields with the Global Constraints defaults; `spine.replay.run(store, models, cfg, limit=None, since=None, until=None, per_agency=None) -> dict` (report dict with at least `{"processed": int, "episodes_closed": int}`).
- Consumes: `load_config()` env-override pattern (`_f`/`_b` helpers) already in `config.py`.

- [ ] **Step 1: Write failing tests**

```python
# tests/test_spine_config.py
import os
from unittest import mock

from pipeline.config import Config, load_config


_REQUIRED = {"CLOUDFLARE_ACCOUNT_ID": "acct", "CLOUDFLARE_API_TOKEN": "tok"}


def test_spine_defaults():
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t")
    assert cfg.engine == "classic"
    assert cfg.spine_sim_floor == 0.60
    assert cfg.spine_top_k == 3
    assert cfg.spine_episode_gap_hours == 48.0
    assert cfg.spine_embed_source == "enriched"
    assert cfg.spine_theme_min_size == 5
    assert cfg.spine_theme_link_sim == 0.55
    assert cfg.spine_theme_sweep_interval_hours == 168.0
    assert cfg.spine_theme_keep_overlap == 0.5


def test_env_overrides():
    env = {**_REQUIRED, "LAB_ENGINE": "spine", "SPINE_TOP_K": "5",
           "SPINE_SIM_FLOOR": "0.7"}
    with mock.patch.dict(os.environ, env):
        cfg = load_config()
    assert cfg.engine == "spine"
    assert cfg.spine_top_k == 5
    assert cfg.spine_sim_floor == 0.7
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_spine_config.py -v`
Expected: FAIL — `Config` has no attribute `engine`

- [ ] **Step 3: Add fields to `Config` and `load_config`**

Append to the `Config` dataclass (after `rank_audit_facets`):

```python
    engine: str = "classic"
    spine_sim_floor: float = 0.60
    spine_top_k: int = 3
    spine_episode_gap_hours: float = 48.0
    spine_embed_source: str = "enriched"
    spine_theme_min_size: int = 5
    spine_theme_link_sim: float = 0.55
    spine_theme_sweep_interval_hours: float = 168.0
    spine_theme_keep_overlap: float = 0.5
```

Append to the `Config(...)` call in `load_config` (matching the file's existing style):

```python
        engine=os.environ.get("LAB_ENGINE", Config.engine),
        spine_sim_floor=_f("SPINE_SIM_FLOOR", Config.spine_sim_floor),
        spine_top_k=int(os.environ.get("SPINE_TOP_K", Config.spine_top_k)),
        spine_episode_gap_hours=_f(
            "SPINE_EPISODE_GAP_HOURS", Config.spine_episode_gap_hours),
        spine_embed_source=os.environ.get(
            "SPINE_EMBED_SOURCE", Config.spine_embed_source),
        spine_theme_min_size=int(os.environ.get(
            "SPINE_THEME_MIN_SIZE", Config.spine_theme_min_size)),
        spine_theme_link_sim=_f("SPINE_THEME_LINK_SIM", Config.spine_theme_link_sim),
        spine_theme_sweep_interval_hours=_f(
            "SPINE_THEME_SWEEP_INTERVAL_HOURS",
            Config.spine_theme_sweep_interval_hours),
        spine_theme_keep_overlap=_f(
            "SPINE_THEME_KEEP_OVERLAP", Config.spine_theme_keep_overlap),
```

- [ ] **Step 4: Walking-skeleton `spine/replay.py` + dispatch**

`spine/__init__.py`: empty file.

```python
# spine/replay.py
"""Spine engine event-time replay driver. Skeleton — full driver in Task 5."""

from __future__ import annotations


def run(store, models, cfg, limit=None, since=None, until=None,
        per_agency=None) -> dict:
    rows = store.prepared_unclustered(limit=limit, since=since, until=until,
                                      per_agency=per_agency)
    return {"engine": "spine", "processed": 0, "episodes_closed": 0,
            "pending": len(rows)}
```

In `pipeline/experiment.py` `run_experiment`, replace the single `cluster_report = cluster(...)` statement with:

```python
    if cfg.engine == "spine":
        if topology_label_set_id is not None or use_golden:
            raise ValueError("spine engine does not support topology curation "
                             "or --use-golden yet")
        from spine.replay import run as spine_run
        cluster_report = spine_run(store, models, cfg, limit=limit,
                                   since=since, until=until,
                                   per_agency=per_agency)
    else:
        cluster_report = cluster(store, models, cfg, limit=limit, since=since,
                                 until=until, per_agency=per_agency,
                                 topology_label_set_id=topology_label_set_id,
                                 multi_episode_percent=multi_episode_percent,
                                 multi_entry_single_episode_percent=(
                                     multi_entry_single_episode_percent),
                                 topology_seed=topology_seed)
```

(Note: the `use_golden` guard must run *before* `apply_reviewed` — place the engine check at the top of `run_experiment`, immediately after `started = ...`, as a two-line guard, and keep dispatch at the call site.)

- [ ] **Step 5: Extend the TS whitelist**

In `apps/operator-console/src/lab/harness.ts`, extend `LAB_ENV_WHITELIST` (keep alphabetical):

```ts
export const LAB_ENV_WHITELIST = [
  "ADJUDICATOR_MODEL",
  "AMBIENT_EMA_CEILING",
  "CLUSTER_JOIN_THRESHOLD",
  "DEDUPE_WINDOW_HOURS",
  "EMBEDDING_MODEL",
  "ENRICHER_MODEL",
  "ENRICHER_VERSION",
  "ENRICHMENT_ENABLED",
  "EPISODE_DORMANCY_HOURS",
  "JUDGE_MODEL",
  "LAB_ENGINE",
  "NEAR_DUP_THRESHOLD",
  "PROMPT_VERSION",
  "RUBRIC_VERSION",
  "SPINE_EMBED_SOURCE",
  "SPINE_EPISODE_GAP_HOURS",
  "SPINE_SIM_FLOOR",
  "SPINE_THEME_KEEP_OVERLAP",
  "SPINE_THEME_LINK_SIM",
  "SPINE_THEME_MIN_SIZE",
  "SPINE_THEME_SWEEP_INTERVAL_HOURS",
  "SPINE_TOP_K",
] as const;
```

- [ ] **Step 6: Run tests + TS checks**

Run: `uv run pytest tests/test_spine_config.py -q` — Expected: 2 passed
Run: `pnpm --filter operator-console typecheck && pnpm --filter operator-console test` (use the package's actual script names from its `package.json`; fall back to `pnpm -r typecheck`) — Expected: green

- [ ] **Step 7: Commit**

```bash
git add pipeline/config.py pipeline/experiment.py spine/__init__.py spine/replay.py apps/operator-console/src/lab/harness.ts tests/test_spine_config.py
git commit -m "feat: spine engine config knobs, experiment dispatch, lab whitelist"
```

---

### Task 2: Spine prompts + model-layer methods

**Files:**
- Create: `spine/prompts.py`
- Modify: `pipeline/ai.py` (two methods on `WorkersAI`)
- Modify: `pipeline/stub.py` (two methods on `StubModels`)
- Modify: `pipeline/cache.py` (memoize `link_storyline`)
- Create: `tests/test_spine_models.py`

**Interfaces:**
- Produces:
  - `spine.prompts.SPINE_ENRICHER_SYSTEM: str`
  - `spine.prompts.build_link_prompt(entry: dict, candidates: list[dict]) -> tuple[str, str]` — entry needs `title`, `enriched_text`, `published_at`, `entity_set`; each candidate needs `headline`, `summary`, `newest_entry_at`, `gap_hours: float`, `shared_entities: list[str]`, `episode_count: int`.
  - `spine.prompts.build_theme_prompt(members: list[dict]) -> tuple[str, str]` — each member needs `headline`.
  - `models.link_storyline(entry: dict, candidates: list[dict]) -> dict` → `{"match": int | None, "same_development": bool, "reason": str}`; on any exception returns `{"match": None, "same_development": False, "reason": "adjudicator_error: ..."}` (never raises).
  - `models.induce_theme(members: list[dict]) -> dict` → `{"theme": bool, "name": str, "reason": str}`; error fallback `{"theme": False, "name": "", "reason": "adjudicator_error: ..."}`.
- Consumes: `WorkersAI._chat`, `_extract_json`, `self.errors` Counter (see `adjudicate_same_event` at `pipeline/ai.py:71` for the established error-tally pattern — copy it); `CachedModels._memo_json`.

- [ ] **Step 1: Write failing tests**

```python
# tests/test_spine_models.py
from pipeline.cache import CachedModels, DecisionCache
from pipeline.stub import StubModels
from spine.prompts import build_link_prompt, build_theme_prompt

ENTRY = {"title": "FTC sues Acme Corp over merger", "enriched_text":
         "FTC filed an antitrust suit against Acme Corp on 2025-07-02.",
         "published_at": "2025-07-02T12:00:00Z", "entity_set": ["ftc", "acme"],
         "content_hash": "abc123"}
CAND = {"headline": "FTC sues Acme Corp over merger", "summary":
        "FTC filed suit against Acme.", "newest_entry_at": "2025-07-01T12:00:00Z",
        "gap_hours": 24.0, "shared_entities": ["ftc", "acme"], "episode_count": 1}
UNRELATED = {"headline": "NASA launches lunar probe", "summary": "NASA probe.",
             "newest_entry_at": "2025-06-01T00:00:00Z", "gap_hours": 700.0,
             "shared_entities": [], "episode_count": 2}


def test_link_prompt_states_facts():
    system, user = build_link_prompt(ENTRY, [CAND, UNRELATED])
    assert "24.0" in user and "ftc" in user      # gap + shared entities explicit
    assert '"match"' in system and "null" in system  # none-option instructed


def test_stub_link_matches_on_token_overlap():
    stub = StubModels()
    verdict = stub.link_storyline(ENTRY, [UNRELATED, CAND])
    assert verdict["match"] == 1
    assert verdict["same_development"] is True
    assert stub.link_storyline(ENTRY, [UNRELATED])["match"] is None


def test_stub_induce_theme_deterministic():
    stub = StubModels()
    out = stub.induce_theme([{"headline": "FTC enforcement one"},
                             {"headline": "FTC enforcement two"}])
    assert out["theme"] is True and out["name"]
    assert out == stub.induce_theme([{"headline": "FTC enforcement one"},
                                     {"headline": "FTC enforcement two"}])


def test_cached_link_storyline_memoizes(tmp_path):
    cache = DecisionCache(str(tmp_path / "d.sqlite"))
    cached = CachedModels(StubModels(), cache, model_tag="stub")
    first = cached.link_storyline(ENTRY, [CAND])
    again = cached.link_storyline(ENTRY, [CAND])
    assert first == again
    assert cached.hits == 1 and cached.misses == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_spine_models.py -v`
Expected: FAIL — `No module named 'spine.prompts'`

- [ ] **Step 3: Implement `spine/prompts.py`**

```python
"""Spine prompt builders. All verdicts are strict JSON."""

from __future__ import annotations

import json

SPINE_ENRICHER_SYSTEM = (
    "Compress the article into exactly ONE sentence optimized for semantic "
    "search. Hard requirements: preserve every named agency, person, program, "
    "place, and date verbatim; state the concrete action (who did what to "
    "whom, with numbers if present); no editorializing, no vague abstractions "
    "like 'officials announced changes'. Output only the sentence."
)

LINK_SYSTEM = (
    "You link government news articles into storylines (chains of episodes "
    "about one evolving real-world matter). Given a new article and candidate "
    "storylines, respond with strict JSON: "
    '{"match": <candidate index or null>, "same_development": <bool>, '
    '"reason": "<one sentence>"}. '
    "match is the index of the storyline this article continues — the same "
    "specific evolving matter, not merely the same topic or agency. Use null "
    "if none qualify (prefer null when unsure; over-merging is worse than "
    "splitting). same_development is true only if the article reports the "
    "same concrete development as the storyline's latest coverage (a "
    "follow-up, restatement, or detail of it), false if it is a new "
    "development in the same storyline."
)

THEME_SYSTEM = (
    "You review a proposed theme: a group of storylines that may share a "
    "recurring pattern (same policy area, campaign, or recurring activity). "
    'Respond with strict JSON: {"theme": <bool>, "name": "<3-8 word title '
    'case name>", "reason": "<one sentence>"}. theme is true only if a '
    "clear majority of the storylines share one nameable pattern a reader "
    "would want to follow; the name must describe the pattern, not one event."
)


def build_link_prompt(entry: dict, candidates: list[dict]) -> tuple[str, str]:
    lines = [
        "NEW ARTICLE:",
        f"  title: {entry['title']}",
        f"  gist: {entry.get('enriched_text') or ''}",
        f"  published: {entry['published_at']}",
        f"  entities: {', '.join(entry.get('entity_set') or [])}",
        "",
        "CANDIDATE STORYLINES:",
    ]
    for i, c in enumerate(candidates):
        lines += [
            f"  [{i}] {c['headline']}",
            f"      overview: {c['summary']}",
            f"      episodes so far: {c['episode_count']}; latest coverage: "
            f"{c['newest_entry_at']} ({c['gap_hours']} hours before this "
            "article)",
            f"      shared entities with article: "
            f"{', '.join(c['shared_entities']) or '(none)'}",
        ]
    lines.append("\nJSON verdict:")
    return LINK_SYSTEM, "\n".join(lines)


def build_theme_prompt(members: list[dict]) -> tuple[str, str]:
    lines = ["PROPOSED THEME MEMBERS:"]
    lines += [f"  - {m['headline']}" for m in members]
    lines.append("\nJSON verdict:")
    return THEME_SYSTEM, "\n".join(lines)


def link_cache_parts(entry: dict, candidates: list[dict]) -> list:
    """Content-stable cache key parts — never row ids."""
    return [entry["content_hash"],
            [(c["headline"], c["summary"], str(c["newest_entry_at"]))
             for c in candidates]]


def _dump(obj) -> str:
    return json.dumps(obj, sort_keys=True, default=str)
```

- [ ] **Step 4: Implement model methods**

Append to `WorkersAI` in `pipeline/ai.py` (mirror the try/except + `self.errors` tally pattern of `adjudicate_same_event`; import `build_link_prompt`, `build_theme_prompt` from `spine.prompts` at the top of each method to avoid an import cycle at module load):

```python
    def link_storyline(self, entry: dict, candidates: list[dict]) -> dict:
        from spine.prompts import build_link_prompt
        try:
            system, user = build_link_prompt(entry, candidates)
            data = _extract_json(self._chat(self.cfg.adjudicator_model, system, user))
            match = data.get("match")
            if match is not None:
                match = int(match)
                if not 0 <= match < len(candidates):
                    match = None
            return {"match": match,
                    "same_development": bool(data.get("same_development")),
                    "reason": str(data.get("reason", ""))[:512]}
        except Exception as exc:
            self.errors["link_storyline"] += 1
            return {"match": None, "same_development": False,
                    "reason": f"adjudicator_error: {exc}"[:512]}

    def induce_theme(self, members: list[dict]) -> dict:
        from spine.prompts import build_theme_prompt
        try:
            system, user = build_theme_prompt(members)
            data = _extract_json(self._chat(self.cfg.judge_model, system, user))
            return {"theme": bool(data.get("theme")),
                    "name": str(data.get("name", "")).strip()[:120],
                    "reason": str(data.get("reason", ""))[:512]}
        except Exception as exc:
            self.errors["induce_theme"] += 1
            return {"theme": False, "name": "",
                    "reason": f"adjudicator_error: {exc}"[:512]}
```

(If `WorkersAI.errors` does not exist as a `Counter`, follow whatever tally mechanism `adjudicate_same_event` actually uses — read `pipeline/ai.py:71-79` first and copy it exactly.)

Append to `StubModels` in `pipeline/stub.py` (reuse its `_tokens` helper):

```python
    def link_storyline(self, entry: dict, candidates: list[dict]) -> dict:
        entry_tokens = _tokens(entry["title"])
        for i, c in enumerate(candidates):
            if len(entry_tokens & _tokens(c["headline"])) >= 3:
                return {"match": i, "same_development": True,
                        "reason": "stub token overlap"}
        return {"match": None, "same_development": False, "reason": "stub no overlap"}

    def induce_theme(self, members: list[dict]) -> dict:
        counts = Counter(t for m in members for t in _tokens(m["headline"]))
        top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:2]
        return {"theme": True, "name": " ".join(w for w, _ in top).title(),
                "reason": "stub theme"}
```

(add `from collections import Counter` to `stub.py` imports if absent).

Append to `CachedModels` in `pipeline/cache.py` (below `compare_rank`):

```python
    def link_storyline(self, entry: dict, candidates: list[dict]) -> dict:
        from spine.prompts import link_cache_parts
        return self._memo_json("spine_link", link_cache_parts(entry, candidates),
                               lambda: self.inner.link_storyline(entry, candidates))
```

(`_memo_json` already refuses to cache results whose reason starts with `adjudicator_error` — transient failures stay uncached. `induce_theme` is deliberately uncached: theme membership sets change between sweeps, so the memo would never hit.)

- [ ] **Step 5: Run tests**

Run: `uv run pytest tests/test_spine_models.py -q`
Expected: 4 passed

- [ ] **Step 6: Commit**

```bash
git add spine/prompts.py pipeline/ai.py pipeline/stub.py pipeline/cache.py tests/test_spine_models.py
git commit -m "feat: spine prompts and link/theme model methods with caching"
```

---

### Task 3: Storyline index — retrieval + burst rule (`spine/index.py`)

Pure in-memory, no store, no LLM. This is the research-amended core: candidates come from **max member-embedding cosine**, not the overview vector.

**Files:**
- Create: `spine/index.py`
- Create: `tests/test_spine_index.py`

**Interfaces:**
- Produces:

```python
@dataclass
class LiveStoryline:
    id: str
    order: int                      # insertion order — deterministic tie-break
    member_vecs: list[np.ndarray]
    centroid: np.ndarray | None
    entities: set[str]
    newest_entry_at: datetime
    open_episode_id: str | None
    open_episode_newest_at: datetime | None
    open_episode_centroid: np.ndarray | None
    open_episode_count: int
    episode_count: int

class StorylineIndex:
    def register(self, storyline_id, episode_id, vec, entities, t) -> LiveStoryline
    def add_member(self, storyline_id, vec, entities, t) -> None       # same episode
    def new_episode(self, storyline_id, episode_id, vec, entities, t) -> None
    def top_candidates(self, vec, k, floor) -> list[tuple[LiveStoryline, float]]
    def episode_active(self, story, t, gap_hours) -> bool
    def due_closes(self, t, gap_hours) -> list[LiveStoryline]  # open episode gone stale
    def mark_closed(self, storyline_id) -> None
    def all(self) -> list[LiveStoryline]
```

- Consumes: `pipeline.vectors.cosine`, `pipeline.vectors.running_mean`.

- [ ] **Step 1: Write failing tests**

```python
# tests/test_spine_index.py
from datetime import datetime, timedelta, timezone

import numpy as np

from spine.index import StorylineIndex

T0 = datetime(2025, 7, 1, tzinfo=timezone.utc)
VX = np.array([1.0, 0.0], dtype=np.float32)
VY = np.array([0.0, 1.0], dtype=np.float32)
VMID = np.array([0.8, 0.6], dtype=np.float32)


def test_top_candidates_max_member_cosine():
    idx = StorylineIndex()
    idx.register("s1", "e1", VX, {"ftc"}, T0)
    idx.register("s2", "e2", VY, {"nasa"}, T0)
    # drifted member added to s1: retrieval must use MAX member sim, not centroid
    idx.add_member("s1", VMID, {"acme"}, T0 + timedelta(hours=1))
    ranked = idx.top_candidates(VMID, k=2, floor=0.0)
    assert [s.id for s, _ in ranked] == ["s1", "s2"]
    assert ranked[0][1] == 1.0                      # exact member match, not centroid


def test_floor_and_k():
    idx = StorylineIndex()
    idx.register("s1", "e1", VX, set(), T0)
    idx.register("s2", "e2", VY, set(), T0)
    assert idx.top_candidates(VX, k=2, floor=0.5) == [
        (idx.all()[0], 1.0)]                        # s2 below floor
    assert len(idx.top_candidates(VMID, k=1, floor=0.0)) == 1


def test_tie_break_is_insertion_order():
    idx = StorylineIndex()
    idx.register("s1", "e1", VX, set(), T0)
    idx.register("s2", "e2", VX, set(), T0)
    ranked = idx.top_candidates(VX, k=2, floor=0.0)
    assert [s.id for s, _ in ranked] == ["s1", "s2"]


def test_burst_rule_and_due_closes():
    idx = StorylineIndex()
    s = idx.register("s1", "e1", VX, set(), T0)
    assert idx.episode_active(s, T0 + timedelta(hours=47), gap_hours=48.0)
    assert not idx.episode_active(s, T0 + timedelta(hours=49), gap_hours=48.0)
    assert idx.due_closes(T0 + timedelta(hours=49), gap_hours=48.0) == [s]
    idx.mark_closed("s1")
    assert idx.due_closes(T0 + timedelta(hours=49), gap_hours=48.0) == []
    assert s.open_episode_id is None


def test_new_episode_resets_open_state():
    idx = StorylineIndex()
    idx.register("s1", "e1", VX, {"a"}, T0)
    idx.mark_closed("s1")
    idx.new_episode("s1", "e2", VY, {"b"}, T0 + timedelta(days=3))
    s = idx.all()[0]
    assert s.open_episode_id == "e2" and s.episode_count == 2
    assert s.entities == {"a", "b"} and len(s.member_vecs) == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_spine_index.py -v`
Expected: FAIL — `No module named 'spine.index'`

- [ ] **Step 3: Implement `spine/index.py`**

```python
"""In-memory storyline index for the spine replay.

Retrieval is max cosine against MEMBER embeddings (research amendment #1:
overview vectors drift and hub; members do not). Centroids are kept only as
episode-attach metadata for the attach_entry RPC. Deterministic: candidate
ties break on insertion order, never on ids.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np

from pipeline.vectors import cosine, running_mean


@dataclass
class LiveStoryline:
    id: str
    order: int
    member_vecs: list = field(default_factory=list)
    centroid: np.ndarray | None = None
    entities: set = field(default_factory=set)
    newest_entry_at: datetime | None = None
    open_episode_id: str | None = None
    open_episode_newest_at: datetime | None = None
    open_episode_centroid: np.ndarray | None = None
    open_episode_count: int = 0
    episode_count: int = 0


class StorylineIndex:
    def __init__(self) -> None:
        self._stories: dict[str, LiveStoryline] = {}

    def register(self, storyline_id: str, episode_id: str, vec: np.ndarray,
                 entities: set, t: datetime) -> LiveStoryline:
        story = LiveStoryline(id=storyline_id, order=len(self._stories))
        self._stories[storyline_id] = story
        self.new_episode(storyline_id, episode_id, vec, entities, t)
        return story

    def new_episode(self, storyline_id: str, episode_id: str, vec: np.ndarray,
                    entities: set, t: datetime) -> None:
        s = self._stories[storyline_id]
        s.open_episode_id = episode_id
        s.open_episode_centroid = None
        s.open_episode_count = 0
        s.episode_count += 1
        self._absorb(s, vec, entities, t)

    def add_member(self, storyline_id: str, vec: np.ndarray, entities: set,
                   t: datetime) -> None:
        self._absorb(self._stories[storyline_id], vec, entities, t)

    def _absorb(self, s: LiveStoryline, vec: np.ndarray, entities: set,
                t: datetime) -> None:
        s.member_vecs.append(vec)
        s.centroid = running_mean(s.centroid, len(s.member_vecs) - 1, vec)
        s.open_episode_centroid = running_mean(
            s.open_episode_centroid, s.open_episode_count, vec)
        s.open_episode_count += 1
        s.entities |= set(entities)
        s.newest_entry_at = t
        s.open_episode_newest_at = t

    def top_candidates(self, vec: np.ndarray, k: int,
                       floor: float) -> list[tuple[LiveStoryline, float]]:
        scored = []
        for s in self._stories.values():
            sim = max(cosine(vec, m) for m in s.member_vecs)
            if sim >= floor:
                scored.append((s, sim))
        scored.sort(key=lambda pair: (-pair[1], pair[0].order))
        return scored[:k]

    def episode_active(self, story: LiveStoryline, t: datetime,
                       gap_hours: float) -> bool:
        return (story.open_episode_id is not None
                and story.open_episode_newest_at is not None
                and t - story.open_episode_newest_at
                <= timedelta(hours=gap_hours))

    def due_closes(self, t: datetime, gap_hours: float) -> list[LiveStoryline]:
        return [s for s in self._stories.values()
                if s.open_episode_id is not None
                and not self.episode_active(s, t, gap_hours)]

    def mark_closed(self, storyline_id: str) -> None:
        s = self._stories[storyline_id]
        s.open_episode_id = None
        s.open_episode_newest_at = None
        s.open_episode_centroid = None
        s.open_episode_count = 0

    def all(self) -> list[LiveStoryline]:
        return list(self._stories.values())
```

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_spine_index.py -q`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add spine/index.py tests/test_spine_index.py
git commit -m "feat: spine storyline index — member-embedding retrieval and burst rule"
```

---

### Task 4: Linker decision tree (`spine/linker.py`)

**Files:**
- Create: `spine/linker.py`
- Create: `tests/test_spine_linker.py`
- Modify (only if a used method is missing): `tests/fakes.py`

**Interfaces:**
- Produces: `Linker(store, models, cfg, index, category_engine)` with `process_entry(row: dict, vec: np.ndarray) -> dict` returning `{"episode_id": str, "storyline_id": str, "method": str}` where method ∈ `{"syndicated_dup", "judge_same_dev", "judge_new_episode", "new_storyline", "new_storyline_no_candidates"}`.
- Consumes: `StorylineIndex` (Task 3); `models.link_storyline` (Task 2); `Store.content_hash_dup/create_episode/attach_entry/insert_card/latest_overview/close_episode`; `pipeline.categories.CategoryEngine.classify(storyline_id)`; `pipeline.vectors.pack_fp16`; row dict shape from `store.prepared_unclustered` (`id`, `title`, `summary`, `enriched_text`, `published_at`, `content_hash`, `embedding`, `entity_set`, `event_keys`, `agency`).

Decision flow (implements the amended design):

1. `store.content_hash_dup(...)` within `cfg.dedupe_window_hours` → attach syndicated to that episode; done. (In replay this routes through `ReplayWindow` exactly like the classic engine.)
2. `index.top_candidates(vec, cfg.spine_top_k, cfg.spine_sim_floor)`; empty → new storyline (`method="new_storyline_no_candidates"`).
3. Build candidate payloads: `store.latest_overview(sid)` headline/summary (master node), `gap_hours` from `newest_entry_at`, `shared_entities = sorted(entities & entry entities)`, `episode_count`. One `models.link_storyline` call.
4. `match is None` → new storyline. `match=i` and `same_development` and `index.episode_active(...)` → attach to open episode. Otherwise → close the open episode if any (deferred to the driver's close loop — the linker only creates: `store.create_episode(storyline_id=...)`) and attach there.
5. New storyline: `store.create_episode(None, ...)` → initial **overview card** written immediately (headline=title, summary=`enriched_text or summary or title`, `overview_embedding=pack_fp16(vec)`, rubric `None`) so the master node exists from birth; then `category_engine.classify(storyline_id)`.

- [ ] **Step 1: Write failing tests**

```python
# tests/test_spine_linker.py
from datetime import datetime, timedelta, timezone

import numpy as np

from pipeline.config import Config
from pipeline.stub import StubModels
from spine.index import StorylineIndex
from spine.linker import Linker
from tests.fakes import FakeStore

CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             engine="spine")
T0 = datetime(2025, 7, 1, tzinfo=timezone.utc)


class NoCategories:
    def classify(self, storyline_id, method="stream"):
        return None


def _row(i, title, t, vec):
    return {"id": f"entry-{i}", "title": title, "summary": f"{title} summary.",
            "enriched_text": f"{title} enriched.", "published_at": t,
            "content_hash": f"hash-{i}",
            "embedding": vec, "entity_set": ["ftc"], "event_keys": [],
            "agency": "ftc"}


def _linker(store):
    return Linker(store, StubModels(), CFG, StorylineIndex(), NoCategories())


def test_first_entry_creates_storyline_with_master_node():
    store = FakeStore()
    linker = _linker(store)
    vec = np.array([1.0, 0.0], dtype=np.float32)
    out = linker.process_entry(_row(1, "FTC sues Acme Corp over merger", T0, vec), vec)
    assert out["method"] == "new_storyline_no_candidates"
    overviews = [c for c in store.cards if c["kind"] == "overview"]
    assert len(overviews) == 1                       # master node exists at birth
    assert overviews[0]["storyline_id"] == out["storyline_id"]


def test_same_development_attaches_to_open_episode():
    store = FakeStore()
    linker = _linker(store)
    vec = np.array([1.0, 0.0], dtype=np.float32)
    first = linker.process_entry(
        _row(1, "FTC sues Acme Corp over merger", T0, vec), vec)
    second = linker.process_entry(
        _row(2, "FTC sues Acme Corp — merger challenge detail",
             T0 + timedelta(hours=2), vec), vec)
    assert second["method"] == "judge_same_dev"
    assert second["episode_id"] == first["episode_id"]


def test_stale_episode_gets_new_episode_same_storyline():
    store = FakeStore()
    linker = _linker(store)
    vec = np.array([1.0, 0.0], dtype=np.float32)
    first = linker.process_entry(
        _row(1, "FTC sues Acme Corp over merger", T0, vec), vec)
    late = T0 + timedelta(hours=CFG.spine_episode_gap_hours + 1)
    second = linker.process_entry(
        _row(2, "FTC sues Acme Corp merger ruling", late, vec), vec)
    assert second["method"] == "judge_new_episode"
    assert second["storyline_id"] == first["storyline_id"]
    assert second["episode_id"] != first["episode_id"]


def test_unrelated_entry_spawns_new_storyline():
    store = FakeStore()
    linker = _linker(store)
    v1 = np.array([1.0, 0.0], dtype=np.float32)
    v2 = np.array([0.9, 0.44], dtype=np.float32)  # above floor but no token overlap
    first = linker.process_entry(
        _row(1, "FTC sues Acme Corp over merger", T0, v1), v1)
    second = linker.process_entry(
        _row(2, "NASA launches lunar probe mission", T0 + timedelta(hours=1), v2), v2)
    assert second["method"] == "new_storyline"
    assert second["storyline_id"] != first["storyline_id"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_spine_linker.py -v`
Expected: FAIL — `No module named 'spine.linker'`
(If `FakeStore` lacks `latest_overview`, `content_hash_dup` compatibility, or a `cards` list captured by `insert_card`, read `tests/fakes.py` and add the minimal missing pieces there — mirror the real `Store` signatures exactly.)

- [ ] **Step 3: Implement `spine/linker.py`**

```python
"""Spine decision tree: dup -> retrieve -> judge -> act.

Only the content-hash dup attaches without the LLM. The judge sees a
listwise shortlist with time gaps and entity overlap stated as facts
(research amendment #3); category never filters candidates (#4). A master
node (overview card) exists from storyline birth (design requirement).
"""

from __future__ import annotations

from datetime import datetime

from pipeline.vectors import pack_fp16
from spine.index import StorylineIndex

_MAX_HEADLINE = 512
_MAX_SUMMARY = 8192


class Linker:
    def __init__(self, store, models, cfg, index: StorylineIndex,
                 category_engine) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg
        self.index = index
        self.categories = category_engine

    def process_entry(self, row: dict, vec) -> dict:
        t: datetime = row["published_at"]
        dup = self.store.content_hash_dup(
            row["content_hash"], t, self.cfg.dedupe_window_hours)
        if dup is not None:
            self._attach(row, str(dup["episode_id"]), "syndicated_dup", 1.0,
                         matched=str(dup["id"]), syndicated=True,
                         episode_centroid=None)
            return {"episode_id": str(dup["episode_id"]),
                    "storyline_id": "", "method": "syndicated_dup"}

        candidates = self.index.top_candidates(
            vec, self.cfg.spine_top_k, self.cfg.spine_sim_floor)
        if not candidates:
            return self._new_storyline(row, vec, t, "new_storyline_no_candidates")

        payloads = [self._candidate_payload(s, sim, row, t)
                    for s, sim in candidates]
        verdict = self.models.link_storyline(self._entry_payload(row), payloads)
        match = verdict.get("match")
        if match is None:
            return self._new_storyline(row, vec, t, "new_storyline",
                                       reason=verdict.get("reason"))

        story, sim = candidates[match]
        if verdict.get("same_development") and self.index.episode_active(
                story, t, self.cfg.spine_episode_gap_hours):
            self._attach(row, story.open_episode_id, "judge_same_dev", sim,
                         matched=None, syndicated=False,
                         episode_centroid=pack_fp16(story.open_episode_centroid))
            self.index.add_member(story.id, vec, set(row["entity_set"]), t)
            return {"episode_id": story.open_episode_id,
                    "storyline_id": story.id, "method": "judge_same_dev"}

        episode_id, _ = self.store.create_episode(
            story.id, "judge_new_episode", sim,
            (verdict.get("reason") or "")[:512],
            self.cfg.adjudicator_model, t)
        self.index.new_episode(story.id, episode_id, vec,
                               set(row["entity_set"]), t)
        self._attach(row, episode_id, "judge_new_episode", sim,
                     matched=None, syndicated=False,
                     episode_centroid=pack_fp16(vec))
        return {"episode_id": episode_id, "storyline_id": story.id,
                "method": "judge_new_episode"}

    # -- helpers --------------------------------------------------------

    def _entry_payload(self, row: dict) -> dict:
        return {"title": row["title"], "enriched_text": row.get("enriched_text"),
                "published_at": str(row["published_at"]),
                "entity_set": list(row.get("entity_set") or []),
                "content_hash": row["content_hash"]}

    def _candidate_payload(self, story, sim: float, row: dict,
                           t: datetime) -> dict:
        overview = self.store.latest_overview(story.id) or {}
        gap_hours = round(
            (t - story.newest_entry_at).total_seconds() / 3600, 1)
        shared = sorted(story.entities & set(row.get("entity_set") or []))
        return {"headline": overview.get("headline", ""),
                "summary": overview.get("summary", ""),
                "newest_entry_at": str(story.newest_entry_at),
                "gap_hours": gap_hours, "shared_entities": shared,
                "episode_count": story.episode_count}

    def _new_storyline(self, row: dict, vec, t: datetime, method: str,
                       reason: str | None = None) -> dict:
        episode_id, storyline_id = self.store.create_episode(
            None, method, None, (reason or "")[:512] or None,
            self.cfg.adjudicator_model, t)
        self.index.register(storyline_id, episode_id, vec,
                            set(row["entity_set"]), t)
        self._attach(row, episode_id, method, None, matched=None,
                     syndicated=False, episode_centroid=pack_fp16(vec))
        summary = (row.get("enriched_text") or row.get("summary")
                   or row["title"]).strip()[:_MAX_SUMMARY]
        self.store.insert_card(
            storyline_id=storyline_id, episode_id=None, kind="overview",
            headline=row["title"][:_MAX_HEADLINE], summary=summary,
            timeline=None, rubric=None, rubric_version=None,
            interest_reason="spine_initial_overview",
            representative_entry_id=str(row["id"]),
            judge_model=None, prompt_version=self.cfg.prompt_version,
            overview_embedding=pack_fp16(vec), tau=self.cfg.tau_seconds)
        self.categories.classify(storyline_id)
        return {"episode_id": episode_id, "storyline_id": storyline_id,
                "method": method}

    def _attach(self, row: dict, episode_id: str, method: str,
                similarity: float | None, matched: str | None,
                syndicated: bool, episode_centroid: bytes | None) -> None:
        self.store.attach_entry(
            str(row["id"]), episode_id, row["agency"], syndicated, method,
            similarity, matched, self.cfg.spine_sim_floor,
            self.cfg.embedding_model, episode_centroid, row["published_at"],
            self.cfg.publisher_weight_version)
```

(Check `CategoryEngine.classify`'s exact signature in `pipeline/categories.py` before wiring — if it needs a `method=` kwarg, pass the default.)

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_spine_linker.py -q`
Expected: 4 passed

- [ ] **Step 5: Run the full suite (fakes changed?)**

Run: `uv run pytest -q`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add spine/linker.py tests/test_spine_linker.py tests/fakes.py
git commit -m "feat: spine linker — dup/retrieve/judge decision tree with master node at birth"
```

---

### Task 5: Replay driver (`spine/replay.py`, real version)

**Files:**
- Modify: `spine/replay.py` (replace the Task-1 skeleton)
- Create: `tests/test_spine_replay.py`

**Interfaces:**
- Produces: `run(store, models, cfg, limit=None, since=None, until=None, per_agency=None) -> dict` report: `{"engine": "spine", "processed", "episodes_closed", "storylines_created", "attach_mix": {method: n}, "theme_sweeps", "theme_sweep_totals"}`.
- Consumes: `Linker` (Task 4), `StorylineIndex` (Task 3), `pipeline.cards.CardEngine` (reused verbatim — episode card + LLM overview + rank_key), `pipeline.categories.CategoryEngine`, `pipeline.window.ReplayWindow/ReplayStore` + the window-priming pattern from `pipeline/runner.py:122-137` (copy it — golden curation resumes depend on it), `spine.themes.sweep` (Task 6 — stub it with a no-op import guard until then: `try: from spine.themes import sweep except ImportError: sweep = None`).

Driver loop (mirrors `runner.cluster` shape):

```python
def run(store, models, cfg, limit=None, since=None, until=None,
        per_agency=None) -> dict:
    rows = store.prepared_unclustered(limit=limit, since=since, until=until,
                                      per_agency=per_agency)
    # window priming: copy pipeline/runner.py lines 122-137 verbatim
    ...
    index = StorylineIndex()
    card_engine = CardEngine(replay, models, cfg)
    category_engine = CategoryEngine(replay, models, cfg)
    linker = Linker(replay, models, cfg, index, category_engine)
    attach_mix, processed, closed_count, created = {}, 0, 0, 0
    last_sweep_at = None
    sweep_totals = {"themes_created": 0, "themes_kept": 0,
                    "themes_demoted": 0, "storylines_assigned": 0}
    sweep_runs = 0
    for row in rows:
        t = row["published_at"]
        last_sweep_at = last_sweep_at or t
        window.advance(t)
        replay.touch_entities(list(row["entity_set"]) + list(row["event_keys"]), t)
        for story in index.due_closes(t, cfg.spine_episode_gap_hours):
            _close(replay, card_engine, index, story)
            closed_count += 1
        vec = unpack_fp16(row["embedding"])
        decision = linker.process_entry(row, vec)
        attach_mix[decision["method"]] = attach_mix.get(decision["method"], 0) + 1
        created += decision["method"].startswith("new_storyline")
        window.add(row["id"], decision["episode_id"], row["content_hash"], t, vec)
        processed += 1
        if (sweep is not None and t - last_sweep_at >= timedelta(
                hours=cfg.spine_theme_sweep_interval_hours)):
            _tally(sweep_totals, sweep(replay, models, cfg))
            sweep_runs += 1
            last_sweep_at = t
    for story in [s for s in index.all() if s.open_episode_id is not None]:
        _close(replay, card_engine, index, story)
        closed_count += 1
    if sweep is not None and rows:
        _tally(sweep_totals, sweep(replay, models, cfg))
        sweep_runs += 1
    ...
```

where `_close` calls `replay.close_episode(story.open_episode_id)`, then `card_engine.on_episode_closed({"id": story.open_episode_id, "storyline_id": story.id})`, then `index.mark_closed(story.id)`. `CardEngine.on_episode_closed` supersedes the initial birth card automatically via `insert_event_card` (verify: `store.insert_card` returns the new card id and the RPC maintains `latest_card_id`/`superseded_by`; confirm by reading the `insert_event_card` SQL in `supabase/migrations/20260718100100_create_clustering_write_rpcs.sql` before relying on it).

- [ ] **Step 1: Write failing test (stub end-to-end over FakeStore)**

```python
# tests/test_spine_replay.py
from datetime import datetime, timedelta, timezone

from pipeline.config import Config
from pipeline.stub import StubModels
from spine.replay import run
from tests.fakes import FakeStore

CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             engine="spine")
T0 = datetime(2025, 7, 1, tzinfo=timezone.utc)


def _entry(i, title, t):
    return {"id": f"entry-{i}", "title": title, "summary": f"{title} summary.",
            "enriched_text": None, "published_at": t, "content_hash": f"h{i}",
            "embedding": None, "entity_set": ["ftc"], "event_keys": [],
            "agency": "ftc"}


def test_replay_end_to_end_with_stub(monkeypatch):
    store = FakeStore()
    stub = StubModels()
    entries = [
        _entry(1, "FTC sues Acme Corp over merger", T0),
        _entry(2, "FTC sues Acme Corp over merger update", T0 + timedelta(hours=3)),
        _entry(3, "NASA launches lunar probe mission", T0 + timedelta(hours=5)),
    ]
    for e in entries:  # stub-embed the titles so replay has vectors
        e["embedding"] = None
    monkeypatch.setattr(store, "prepared_unclustered",
                        lambda **kw: entries, raising=False)
    report = run(store, stub, CFG)
    assert report["engine"] == "spine"
    assert report["processed"] == 3
    # 2 storylines: the FTC pair joined, NASA spun off
    assert report["storylines_created"] == 2
    assert report["episodes_closed"] == 2          # finalize closes both
    assert report["attach_mix"]["judge_same_dev"] == 1
```

Note: rows here carry `embedding=None`; the driver must stub-embed when `embedding` is `None` **only in the FakeStore path** — instead, keep the driver strict (`unpack_fp16(row["embedding"])`) and in the test pre-pack embeddings:

```python
from pipeline.vectors import pack_fp16
for e in entries:
    e["embedding"] = pack_fp16(stub.embed([e["title"]])[0])
```

Use the pre-pack version; delete the `embedding=None` loop.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_spine_replay.py -v`
Expected: FAIL — skeleton returns `processed: 0`

- [ ] **Step 3: Implement the real driver**

Write `spine/replay.py` per the loop above, completing `_tally` (`for k, v in result.items(): totals[k] += v`), the FakeStore/real-Store window split copied from `pipeline/runner.py:122-137` (real `Store` has `.db` → wrap with `ReplayStore`; fakes → `_WindowedFake` — import both from `pipeline.runner` rather than duplicating them), and the final report dict:

```python
    report = {"engine": "spine", "processed": processed,
              "episodes_closed": closed_count,
              "storylines_created": created, "attach_mix": attach_mix,
              "theme_sweeps": sweep_runs, "theme_sweep_totals": sweep_totals}
    return report
```

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_spine_replay.py -q`
Expected: 1 passed

- [ ] **Step 5: Full suite**

Run: `uv run pytest -q`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add spine/replay.py tests/test_spine_replay.py
git commit -m "feat: spine event-time replay driver reusing CardEngine and replay window"
```

---

### Task 6: Global theme sweep (`spine/themes.py`)

Research amendment #5: global average-linkage clustering instead of 10–15-item batches; persistent theme IDs reconciled by member overlap (merge and split fall out of reconciliation).

**Files:**
- Create: `spine/themes.py`
- Create: `tests/test_spine_themes.py`
- Modify: `pipeline/store.py` (one read method)

**Interfaces:**
- Produces:
  - `cluster_storylines(vecs: list[np.ndarray], link_sim: float) -> list[list[int]]` — pure average-linkage agglomerative over cosine sim; merges while the best cluster-pair average sim ≥ `link_sim`; deterministic (ties: lowest first-index first).
  - `reconcile(clusters: list[list[str]], existing: dict[str, set[str]], keep_overlap: float) -> list[tuple[str | None, list[str]]]` — pairs each cluster with the existing theme id it keeps (Jaccard ≥ `keep_overlap`, greedy best-first, each theme used once) or `None` for a new theme.
  - `sweep(store, models, cfg) -> dict` — `{"themes_created", "themes_kept", "themes_demoted", "storylines_assigned"}`.
- Consumes: new `Store.storylines_for_sweep() -> list[dict]` (`id`, `centroid` unpacked, `theme_id`, `headline` from latest card — same shape appended to `tests/fakes.py`); `Store.create_theme/assign_theme/update_theme/demote_theme/all_themes`; `models.induce_theme` (Task 2); `pipeline.vectors.cosine/pack_fp16`.

Sweep algorithm:
1. `rows = store.storylines_for_sweep()`; skip if fewer than `cfg.spine_theme_min_size`.
2. `clusters = cluster_storylines([r["centroid"] for r in rows], cfg.spine_theme_link_sim)`; drop clusters smaller than `cfg.spine_theme_min_size`.
3. For each surviving cluster: `models.induce_theme([{"headline": ...}, ...])` (cap the prompt at the 15 members nearest the cluster mean); drop clusters the LLM rejects (`theme: false`).
4. `existing = {theme_id: set(member storyline ids)}` from current `theme_id` column; `reconcile(...)`.
5. Matched cluster → keep theme id + display name (stability beats freshness; update centroid via `update_theme`); unmatched → `create_theme(name, centroid, category_id=None, ...)`. Assign every member `assign_theme(sid, theme_id, method="spine_sweep", similarity=cosine(member, cluster_mean), reason=verdict_reason)` — skip members already assigned to that theme id.
6. Existing themes with no matched cluster → `demote_theme(theme_id)` (this is both "merged away" and "dissolved"; splits keep the id on the best-overlap fragment automatically).

- [ ] **Step 1: Write failing tests**

```python
# tests/test_spine_themes.py
import numpy as np

from spine.themes import cluster_storylines, reconcile


def _v(x, y):
    return np.array([x, y], dtype=np.float32)


def test_average_linkage_two_groups():
    vecs = [_v(1, 0), _v(0.99, 0.14), _v(0, 1), _v(0.14, 0.99)]
    clusters = cluster_storylines(vecs, link_sim=0.9)
    assert sorted(sorted(c) for c in clusters) == [[0, 1], [2, 3]]


def test_no_merge_below_threshold():
    clusters = cluster_storylines([_v(1, 0), _v(0, 1)], link_sim=0.9)
    assert sorted(sorted(c) for c in clusters) == [[0], [1]]


def test_reconcile_keeps_id_on_majority_overlap():
    out = reconcile([["a", "b", "c", "d"]], {"t1": {"a", "b", "c"}},
                    keep_overlap=0.5)
    assert out == [("t1", ["a", "b", "c", "d"])]


def test_reconcile_split_keeps_id_on_best_fragment():
    existing = {"t1": {"a", "b", "c", "d", "e", "f"}}
    out = reconcile([["a", "b", "c", "d"], ["e", "f", "g", "h"]],
                    existing, keep_overlap=0.5)
    assert ("t1", ["a", "b", "c", "d"]) in out
    assert (None, ["e", "f", "g", "h"]) in out


def test_reconcile_merge_uses_larger_overlap_once():
    existing = {"t1": {"a", "b"}, "t2": {"c"}}
    out = reconcile([["a", "b", "c"]], existing, keep_overlap=0.5)
    assert out == [("t1", ["a", "b", "c"])]   # t2 unmatched -> demoted by sweep
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_spine_themes.py -v`
Expected: FAIL — `No module named 'spine.themes'`

- [ ] **Step 3: Implement pure functions**

```python
# spine/themes.py
"""Global theme sweep: average-linkage clustering + LLM confirm/name +
persistent-ID reconciliation. Batching rejected per design amendment #5 —
global visibility avoids batch-boundary duplicate themes; merge/split are
byproducts of reconciliation, not separate machinery."""

from __future__ import annotations

import numpy as np

from pipeline.vectors import cosine, pack_fp16


def cluster_storylines(vecs: list, link_sim: float) -> list[list[int]]:
    clusters = [[i] for i in range(len(vecs))]
    if len(vecs) < 2:
        return clusters
    sims = np.array([[cosine(a, b) for b in vecs] for a in vecs])
    while len(clusters) > 1:
        best, best_pair = -1.0, None
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                avg = float(np.mean(
                    [sims[a][b] for a in clusters[i] for b in clusters[j]]))
                if avg > best:
                    best, best_pair = avg, (i, j)
        if best < link_sim:
            break
        i, j = best_pair
        clusters[i] = clusters[i] + clusters[j]
        del clusters[j]
    return clusters


def reconcile(clusters: list[list[str]], existing: dict[str, set[str]],
              keep_overlap: float) -> list[tuple[str | None, list[str]]]:
    pairs = []
    for ci, cluster in enumerate(clusters):
        members = set(cluster)
        for theme_id, theme_members in existing.items():
            jaccard = (len(members & theme_members)
                       / len(members | theme_members))
            if jaccard >= keep_overlap:
                pairs.append((jaccard, ci, theme_id))
    pairs.sort(key=lambda p: (-p[0], p[1], p[2]))
    cluster_theme: dict[int, str] = {}
    used: set[str] = set()
    for jaccard, ci, theme_id in pairs:
        if ci not in cluster_theme and theme_id not in used:
            cluster_theme[ci] = theme_id
            used.add(theme_id)
    return [(cluster_theme.get(ci), cluster) for ci, cluster in
            enumerate(clusters)]
```

- [ ] **Step 4: Run pure-function tests**

Run: `uv run pytest tests/test_spine_themes.py -q`
Expected: 5 passed

- [ ] **Step 5: Add `Store.storylines_for_sweep` + `sweep()`**

Append to `Store` (`pipeline/store.py`, reads section — content-stable order like `_storyline_rows`):

```python
    def storylines_for_sweep(self) -> list[dict]:
        rows = self.db.all(
            """
            select s.id, s.centroid, s.theme_id,
                   coalesce(c.headline, '(no card)') as headline
            from public.storylines s
            left join public.event_cards c on c.id = s.latest_card_id
            where s.merged_into is null and s.centroid is not null
            order by s.first_entry_at, s.newest_entry_at, s.entity_set,
                     s.event_keys, s.centroid
            """
        )
        return [dict(r, centroid=unpack_fp16(r["centroid"])) for r in rows]
```

Add the same method to `tests/fakes.py` FakeStore (return its in-memory storylines in insertion order).

Append `sweep()` to `spine/themes.py`:

```python
def sweep(store, models, cfg) -> dict:
    result = {"themes_created": 0, "themes_kept": 0, "themes_demoted": 0,
              "storylines_assigned": 0}
    rows = store.storylines_for_sweep()
    if len(rows) < cfg.spine_theme_min_size:
        return result
    clusters_idx = cluster_storylines(
        [r["centroid"] for r in rows], cfg.spine_theme_link_sim)
    clusters_idx = [c for c in clusters_idx
                    if len(c) >= cfg.spine_theme_min_size]

    confirmed = []
    for cluster in clusters_idx:
        mean = np.mean([rows[i]["centroid"] for i in cluster], axis=0)
        ranked = sorted(cluster, key=lambda i: (-cosine(rows[i]["centroid"],
                                                        mean), i))
        verdict = models.induce_theme(
            [{"headline": rows[i]["headline"]} for i in ranked[:15]])
        if verdict.get("theme"):
            confirmed.append((cluster, mean, verdict))

    existing: dict[str, set[str]] = {}
    for r in rows:
        if r["theme_id"] is not None:
            existing.setdefault(str(r["theme_id"]), set()).add(str(r["id"]))

    id_clusters = [[str(rows[i]["id"]) for i in cluster]
                   for cluster, _, _ in confirmed]
    matched = reconcile(id_clusters, existing, cfg.spine_theme_keep_overlap)

    kept_ids = set()
    for (theme_id, members), (cluster, mean, verdict) in zip(matched, confirmed):
        if theme_id is None:
            theme_id = store.create_theme(
                verdict["name"] or "Unnamed theme", pack_fp16(mean),
                category_id=None, name_model=cfg.judge_model,
                reason=verdict.get("reason"))
            result["themes_created"] += 1
        else:
            store.update_theme(theme_id, centroid=pack_fp16(mean))
            result["themes_kept"] += 1
        kept_ids.add(theme_id)
        member_theme = {str(rows[i]["id"]): rows[i]["theme_id"]
                        for i in cluster}
        for i, sid in zip(cluster, members):
            if str(member_theme.get(sid)) != str(theme_id):
                store.assign_theme(
                    sid, theme_id, method="spine_sweep",
                    similarity=cosine(rows[i]["centroid"], mean),
                    reason=(verdict.get("reason") or "")[:512])
                result["storylines_assigned"] += 1

    for theme_id in existing:
        if theme_id not in kept_ids:
            store.demote_theme(theme_id)
            result["themes_demoted"] += 1
    return result
```

(Read the real `create_theme`/`assign_theme`/`update_theme` signatures at `pipeline/store.py:538-575` before finalizing — match their positional/keyword shapes exactly; `create_theme` may require an inclusion-criterion argument added by the lazy-promotion migration. Adjust `tests/fakes.py` equivalents to match.)

- [ ] **Step 6: Add a sweep integration-style test over FakeStore**

Append to `tests/test_spine_themes.py`:

```python
from pipeline.config import Config
from pipeline.stub import StubModels
from spine.themes import sweep
from tests.fakes import FakeStore


def test_sweep_creates_theme_of_min_size(monkeypatch):
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t",
                 spine_theme_min_size=3)
    store = FakeStore()
    base = _v(1, 0)
    rows = [{"id": f"s{i}", "centroid": base, "theme_id": None,
             "headline": f"FTC enforcement action {i}"} for i in range(3)]
    monkeypatch.setattr(store, "storylines_for_sweep", lambda: rows,
                        raising=False)
    result = sweep(store, StubModels(), cfg)
    assert result["themes_created"] == 1
    assert result["storylines_assigned"] == 3
```

Run: `uv run pytest tests/test_spine_themes.py -q`
Expected: 6 passed

- [ ] **Step 7: Remove the Task-5 import guard**

In `spine/replay.py`, replace the `try/except ImportError` sweep import with a plain `from spine.themes import sweep`.

Run: `uv run pytest -q`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add spine/themes.py tests/test_spine_themes.py pipeline/store.py tests/fakes.py spine/replay.py
git commit -m "feat: spine global theme sweep with persistent-ID reconciliation"
```

---

### Task 7: End-to-end verification and baseline A/B

No new production code — proving the harness contract holds, then producing the first spine-vs-classic comparison.

**Files:**
- Create: `tests/test_spine_integration.py` (marked `integration`)
- Create: `docs/eval/spine-vs-classic-2026-07/notes.md` (written from real results — see Step 5)
- Modify: `docs/operations/clustering-lab.md` (one short "Engines" subsection)

- [ ] **Step 1: Integration test (needs local Supabase + synced corpus)**

```python
# tests/test_spine_integration.py
import os

import pytest

pytestmark = pytest.mark.integration


def test_spine_experiment_records_run():
    os.environ["LAB_ENGINE"] = "spine"
    from pipeline.bench import assert_local_dsn
    from pipeline.cache import CachedModels, DecisionCache
    from pipeline.config import load_config
    from pipeline.db import Db
    from pipeline.experiment import run_experiment
    from pipeline.store import Store
    from pipeline.stub import StubModels

    cfg = load_config()
    assert cfg.engine == "spine"
    db = Db(cfg.database_url)
    assert_local_dsn(cfg.database_url)
    models = CachedModels(StubModels(), DecisionCache(".cache/test.sqlite"),
                          model_tag="stub")
    out = run_experiment(db, Store(db), models, cfg, "spine-smoke-stub",
                         limit=50)
    assert out["run_id"]
    row = db.one("select cluster_report from public.experiment_runs "
                 "where id = %(id)s::uuid", {"id": out["run_id"]})
    assert row["cluster_report"]["engine"] == "spine"
```

(Match the exact construction pattern `pipeline/cli.py` uses for db/store/models — read `cli.py:143-245` `_models` and the `experiment` branch and mirror it; if `Db`'s constructor differs, follow `cli.py`.)

Run: `DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:57422/postgres' uv run pytest tests/test_spine_integration.py -m integration -v`
Expected: PASS (requires local Supabase up + prepared corpus; if `prepared_unclustered` returns 0 rows, run `prepare` first — see Step 3)

- [ ] **Step 2: Stub smoke through the real CLI**

```bash
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:57422/postgres'
LAB_ENGINE=spine uv run python -m pipeline.cli experiment spine-smoke-stub --stub --limit 100
```

Expected: JSON line with `report` + `run_id`; `docs/eval/spine-smoke-stub/report.md` exists.

- [ ] **Step 3: Real-model baseline pair over the same slice**

```bash
uv run python -m pipeline.cli experiment classic-baseline-500 --limit 500
LAB_ENGINE=spine uv run python -m pipeline.cli experiment spine-baseline-500 --limit 500
```

Expected: both reports render; both `experiment_runs` rows exist. (The spine run resets the classic run's derived tables — expected; reports and `experiment_runs` history persist, which is how same-DB A/B works today. Task 8 adds a fully isolated spine bench for live side-by-side state.) Also verify the operator harness path: `pnpm ops lab run --name spine-lab-smoke --stub --limit 50 --set LAB_ENGINE=spine` completes with a parsed run id.

- [ ] **Step 4: Sanity-check spine output quality signals**

Inspect `docs/eval/spine-baseline-500/report.md`:
- `new_storyline*` + `judge_*` attach mix all nonzero (decision tree exercised).
- `episodes_closed > 0`, overview fallback rate < 0.5.
- Every storyline has an overview card (master-node invariant):

```sql
select count(*) from public.storylines s
where s.merged_into is null
  and not exists (select 1 from public.event_cards c
                  where c.storyline_id = s.id and c.kind = 'overview');
```

Expected: 0.

- [ ] **Step 5: Write the A/B notes doc**

`docs/eval/spine-vs-classic-2026-07/notes.md`: table of operational metrics for both runs (singleton episode/theme rates, storyline/episode/theme counts, attach mixes, multi-episode chains, LLM call/error counts) plus a manual-QA section: sample 15–20 storylines per engine via the lab storyline-QA surface and note over-merges, over-splits, and master-node quality (best/worst chains from each). This is analysis of real output — write it from the actual reports and hands-on inspection, not a template. Do NOT cite golden-set numbers; the golden labels are unvetted.

- [ ] **Step 6: Document the engine switch**

Add to `docs/operations/clustering-lab.md` a short subsection:

```markdown
## Engines

Two replay engines share the corpus, derived tables, and this harness:

- `classic` (default) — five-stage engine (`pipeline/episodes.py` → … → `promotion.py`).
- `spine` — simplified engine (`spine/`): member-embedding retrieval → listwise judge →
  gap-based episodes → global theme sweep. Design:
  `docs/superpowers/specs/2026-07-19-simplified-storyline-spine-design.md`.

Select per run: `pnpm ops lab run --name my-run --set LAB_ENGINE=spine` or
`LAB_ENGINE=spine uv run python -m pipeline.cli experiment my-run --limit 500`.
Spine knobs (`SPINE_*`) are in the lab `--set` whitelist; see `pipeline/config.py`.
Spine does not yet support `--use-golden` materialization or topology curation.
Engine comparison is operational metrics + manual QA for now; golden-based
scoring is deferred until `golden_news_entries` passes QA.
```

- [ ] **Step 7: Full suite + commit**

```bash
uv run pytest -q
git add tests/test_spine_integration.py docs/eval/spine-vs-classic-2026-07/notes.md docs/operations/clustering-lab.md
git commit -m "feat: spine e2e verification, baseline A/B notes, lab engine docs"
```

---

### Task 8: Parallel bench database + second dashboard

Spine evaluation must not clobber the classic engine's bench state (both engines share derived tables, and `reset_clusters` wipes them at every experiment start). Solution: a second database in the same local Supabase cluster, selected purely by `DATABASE_URL` — no engine code changes. Precedent for in-container provisioning: `scripts/test-news-source-migration.sh`.

**Files:**
- Create: `scripts/create-spine-bench.sh`
- Modify: `docs/operations/clustering-lab.md` (extend the Task-7 "Engines" subsection)

**Interfaces:**
- Consumes: running Supabase container (`supabase_db_dot-gov-news-pipeline`), `pipeline.cli reset --clusters`, `pnpm ops dashboard --port N` (`apps/operator-console/src/cli.ts:422`), the `DATABASE_URL` resolution in `apps/operator-console/src/config.ts:60` and `pipeline/config.py`.
- Produces: `spine_bench` database — full clone of the primary (corpus + prepared features + RPCs + grants) with derived clustering state and `experiment_runs` history wiped.

- [ ] **Step 1: Write the provisioning script**

```bash
#!/usr/bin/env bash
# scripts/create-spine-bench.sh
# Provision a parallel bench database so spine experiments never touch the
# classic engine's bench state. Clones corpus + prepared features (embeddings,
# enrichment — the expensive half) from the primary bench db, truncates run
# history, and wipes derived clustering state.
set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly database_container="${SUPABASE_DB_CONTAINER:-supabase_db_dot-gov-news-pipeline}"
readonly bench_database="${1:-spine_bench}"
readonly source_database="${SOURCE_DATABASE:-postgres}"
readonly bench_url="postgresql://postgres:postgres@127.0.0.1:57422/${bench_database}"

if ! docker inspect "${database_container}" >/dev/null 2>&1; then
  echo "Local Supabase database container ${database_container} is not running." >&2
  echo "Start it with: pnpm supabase start" >&2
  exit 1
fi

docker exec "${database_container}" dropdb \
  --username postgres --if-exists --force "${bench_database}"
docker exec "${database_container}" createdb \
  --username postgres "${bench_database}"

# Full-db clone keeps corpus, features, RPCs, and grants identical. Supabase
# system schemas restore with benign ownership noise (hence no ON_ERROR_STOP);
# the verification below is what actually gates success.
docker exec "${database_container}" pg_dump \
    --username postgres --dbname "${source_database}" \
  | docker exec -i "${database_container}" psql \
      --username postgres --dbname "${bench_database}" --quiet \
  >/dev/null 2>"/tmp/${bench_database}-restore.log" || true

sql() {
  docker exec "${database_container}" psql \
    --username postgres --dbname "${bench_database}" \
    --tuples-only --no-align --command "$1"
}

entries="$(sql 'select count(*) from public.news_entries')"
features="$(sql 'select count(*) from public.news_entries where embedding is not null')"
rpc="$(sql "select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname = 'create_episode_with_storyline'")"
if [[ "${entries}" -eq 0 || "${rpc}" -ne 1 ]]; then
  echo "Clone verification failed (entries=${entries}, rpc=${rpc})." >&2
  echo "See /tmp/${bench_database}-restore.log" >&2
  exit 1
fi

# Cloned run history belongs to the classic engine — drop it, then wipe
# derived clustering state (corpus + prepared features survive).
sql 'truncate public.experiment_runs cascade' >/dev/null
cd "${repository_root}"
DATABASE_URL="${bench_url}" uv run python -m pipeline.cli reset --clusters

echo "Bench database ready: ${bench_url}"
echo "  entries: ${entries}  with features: ${features}"
```

Then `chmod +x scripts/create-spine-bench.sh`. (Check before finalizing: does `pipeline.cli reset --clusters` prompt or need extra flags — read the `reset` branch of `pipeline/cli.py`; `load_config` requires `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` in the environment even here. If `rank_snapshots`/`rank_audit_runs` are not FK'd to `experiment_runs`, truncate them explicitly in the same statement.)

- [ ] **Step 2: Run it and verify isolation**

```bash
./scripts/create-spine-bench.sh
```

Expected: "Bench database ready" with nonzero entries/features. Then verify:

```bash
export SPINE_DB='postgresql://postgres:postgres@127.0.0.1:57422/spine_bench'
docker exec supabase_db_dot-gov-news-pipeline psql -U postgres -d spine_bench \
  -c 'select count(*) from public.episodes'          # expect 0
docker exec supabase_db_dot-gov-news-pipeline psql -U postgres -d postgres \
  -c 'select count(*) from public.experiment_runs'   # classic history untouched
```

- [ ] **Step 3: Spine smoke against the new bench**

```bash
DATABASE_URL="$SPINE_DB" LAB_ENGINE=spine \
  uv run python -m pipeline.cli experiment spine-bench-smoke --stub --limit 100
```

Expected: run completes; `experiment_runs` row exists in `spine_bench` and NOT in `postgres` (check both counts).

- [ ] **Step 4: Second dashboard instance**

```bash
DATABASE_URL="$SPINE_DB" pnpm ops dashboard --port 4174
```

Expected: dashboard on `127.0.0.1:4174` shows the spine bench (lab corpus page reflects `spine_bench` counts; run history shows only spine runs) while the classic dashboard on 4173 (started without the env override) is unaffected. Lab runs from this instance inherit the DSN (`server.ts:242` passes `config.databaseUrl` through to the Python harness).

- [ ] **Step 5: Startup banners — both entrypoints announce their database**

Docs go stale; the process itself must say where it points. Add a sanitized-DSN helper somewhere importable by both sides — top of `pipeline/experiment.py` is fine:

```python
def _dsn_label(database_url: str) -> str:
    """host:port/dbname only — never credentials."""
    from urllib.parse import urlsplit
    parts = urlsplit(database_url)
    return f"{parts.hostname}:{parts.port}{parts.path}"
```

In `run_experiment`, immediately after `started = datetime.now(timezone.utc)`:

```python
    import sys
    print(f"[experiment] engine={cfg.engine} "
          f"database={_dsn_label(cfg.database_url)}", file=sys.stderr)
```

(stderr, not stdout — the TS harness parses stdout's last JSON line for `run_id`.)

In `apps/operator-console/src/server.ts`, where the dashboard prints its startup line (near `apps/operator-console/src/cli.ts:432` "Operator dashboard: ..."), extend the output with the sanitized database (host:port/dbname parsed from `config.databaseUrl` — reuse or mirror whatever sanitization `lab/db.ts` has; never print credentials):

```ts
process.stdout.write(`Operator dashboard: ${dashboard.url}\n`);
process.stdout.write(`Lab database: ${sanitizedDsn(config.databaseUrl)}\n`);
```

Verify:

```bash
uv run python -m pipeline.cli experiment banner-check --stub --limit 5   # stderr: [experiment] engine=classic database=127.0.0.1:57422/postgres
DATABASE_URL="$SPINE_DB" LAB_ENGINE=spine \
  uv run python -m pipeline.cli experiment banner-check2 --stub --limit 5  # engine=spine database=.../spine_bench
pnpm ops dashboard                                                        # prints Lab database: 127.0.0.1:57422/postgres
```

- [ ] **Step 6: Document the workflow**

Extend the "Engines" subsection in `docs/operations/clustering-lab.md`:

```markdown
### Parallel bench (spine)

Spine evaluates in its own database so classic bench state survives:

    ./scripts/create-spine-bench.sh   # clone corpus+features -> spine_bench, wipe derived state

### Entrypoints — which database each spins up

| Engine | Database | Experiment entrypoint | Dashboard |
|---|---|---|---|
| classic | `postgresql://postgres:postgres@127.0.0.1:57422/postgres` (the default — no env needed) | `uv run python -m pipeline.cli experiment NAME --limit 500` or `pnpm ops lab run --name NAME` | `pnpm ops dashboard` → http://127.0.0.1:4173 |
| spine | `postgresql://postgres:postgres@127.0.0.1:57422/spine_bench` (must set `DATABASE_URL`) | `DATABASE_URL=$SPINE_DB LAB_ENGINE=spine uv run python -m pipeline.cli experiment NAME --limit 500` or `DATABASE_URL=$SPINE_DB pnpm ops lab run --name NAME --set LAB_ENGINE=spine` | `DATABASE_URL=$SPINE_DB pnpm ops dashboard --port 4174` → http://127.0.0.1:4174 |

where `SPINE_DB='postgresql://postgres:postgres@127.0.0.1:57422/spine_bench'`.

Rules of thumb: no `DATABASE_URL` = classic bench; spine work always pairs
`DATABASE_URL=$SPINE_DB` with `LAB_ENGINE=spine` — setting only one of the
two either runs spine over the classic bench (clobbers classic derived
state) or runs classic over the spine bench. A dashboard instance evaluates
whichever database its `DATABASE_URL` pointed at when it started.

Re-run the script anytime to re-clone (it drops and recreates `spine_bench`;
corpus refreshes in the primary propagate on the next clone).
```

- [ ] **Step 7: Commit**

```bash
git add scripts/create-spine-bench.sh docs/operations/clustering-lab.md pipeline/experiment.py apps/operator-console/src/server.ts
git commit -m "feat: parallel spine bench provisioning, startup DB banners, second dashboard workflow"
```

---

## Self-review notes

- Spec coverage: enrichment (Task 2 prompt + existing prepare; embed-source knob in Task 1 — note: `SPINE_EMBED_SOURCE=raw` is honored by the *existing* `prepare` only through `ENRICHMENT_ENABLED=false` + `--clear-features` for v1; a dedicated raw-embed prepare path is deliberately deferred and documented in the design's out-of-scope if needed), category (Task 4 via reused CategoryEngine), decision tree (Tasks 3–4), master node incl. singletons (Task 4 birth card + CardEngine regeneration), event-card checkpoints (CardEngine reuse, Task 5), themes with retroactive merge/split (Task 6), rank_key (free via `insert_event_card`), harness hookup (Task 1, Task 7), eval (operational metrics + manual QA in Task 7; golden scorer is a follow-up gated on golden-set QA — see design out-of-scope), parallel bench isolation + second dashboard (Task 8).
- Known verify-before-trusting points are called out inline: `insert_event_card` supersession behavior, `CategoryEngine.classify` signature, `create_theme` signature post-lazy-promotion migration, `WorkersAI.errors` mechanism, operator-console script names.
