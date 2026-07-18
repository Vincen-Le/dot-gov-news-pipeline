# Clustering Processing Pipeline + Evaluation Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Python processing pipeline (enrich → embed → dedupe → episodes → storylines → event cards), the `security definer` write RPCs the data-model plan deferred, a seed loader for scraped gov-news corpora, and an evaluation harness — so a historical corpus from the top-30 gov sites can be run end-to-end and the clustering hypothesis measured.

**Architecture:** Python package `pipeline/` at repo root (uv-managed, container-ready later, run locally as a CLI against local/hosted Supabase). All writes go through `security definer` RPCs (two new migrations, continuing the data-model plan's sequence). LLM/embedding inference stays on Workers AI REST (no non-Cloudflare inference). The runner processes the seeded corpus in **event time** — ordered by `published_at`, with every window (72 h dedupe, 4 h episode dormancy) measured against the current entry's timestamp, never wall clock — so a backfilled corpus replays exactly as it would have streamed, deterministically.

**Tech Stack:** Python 3.12 + uv (`psycopg[binary]`, `httpx`, `numpy`, `python-dotenv`, `pytest`), Supabase Postgres 15+ with pgTAP, Cloudflare Workers AI REST.

**Prerequisite:** `docs/superpowers/plans/2026-07-18-clustering-data-model.md` fully executed (migrations `20260718000400`–`20260718000800`: `news_entries`, `entity_stats`, `storylines`, `episodes`, `episode_entries`, `event_cards`, `rubric_weights`).

**Specs:** `docs/superpowers/specs/2026-07-18-storyline-event-cards-design.md` (pipeline stages 0–3) and surviving sections of `docs/superpowers/specs/2026-07-17-ranking-pipeline-design.md` (dedupe layering, entity extraction, rank_key, judge rubric, audit trail).

## Design amendments (locked in by this plan)

1. **Event-time processing.** Backfill breaks the streaming spec's implicit wall-clock: with months of history, "last 72 h" and "4 h quiet" must be relative to the entry being processed. The runner sorts by `published_at` and carries an event clock. Live streaming later reuses the same engines with `fetched_at` ordering — no logic changes.
2. **Embedding model default `@cf/baai/bge-m3`** (1024 dims), replacing spec-era `bge-large-en-v1.5` — per the modern-approaches review (2024–2026 MTEB gains). Config value; every decision row records `embedding_model`, so a swap forces recalibration by construction.
3. **Storyline representation = latest overview-card embedding**, not a running-mean centroid (running means drift/blur over long chains; summary-anchored representation is the USTORY result). `storylines.centroid` stores the embedding of the latest overview card's summary; refreshed on every card regeneration.
4. **Cited timeline bullets.** Every overview timeline bullet must cite a member `episode_id`; a validator drops uncited bullets before the card is written (LLM-TLS hallucination guard).
5. **Free calibration labels from exact dupes.** `content_hash` attach pairs are known same-event pairs at zero labeling cost; the eval harness computes their cosine distribution to ground `NEAR_DUP_THRESHOLD` / `CLUSTER_JOIN_THRESHOLD` empirically (specs' open item #1).
6. **Normalization lives in Python for the seed path.** Specs place `url_canonical`/`content_hash` in TS at live ingest; that stage doesn't exist yet. The seed loader computes both in `pipeline/normalize.py`. When live TS ingest is built, port the rules and add cross-language golden tests — flagged in "Out of scope".
7. **Overview regeneration happens at episode close** (content final), not on every attach. Deterministic, cheaper; deviation from spec's "every episode attach" trigger recorded here.
8. **`exact_url` attach method never fires in seeded runs**: `news_entries.url_canonical` is `UNIQUE`, so the loader drops same-URL rows at ingest (`ingest_news_entry` returns null). Cross-source syndication has distinct URLs; verbatim copies are caught by `content_hash`.

## Seed data contract (for the top-30 scrape)

The loader consumes JSONL, one object per scraped item:

```json
{
  "url": "https://www.fda.gov/news-events/press-announcements/fda-recalls-valsatrex",
  "title": "FDA Announces Recall of Valsatrex",
  "summary": "The FDA announced a nationwide recall of Valsatrex after contamination was found...",
  "published_at": "2026-05-14T14:30:00Z",
  "source_url": "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml",
  "source_type": "rss",
  "agency": "fda.gov"
}
```

- `url`, `title`, `published_at`, `source_url`, `source_type` required; `summary` strongly recommended (clustering quality degrades on title-only); `agency` optional — stored as the source's display title; the pipeline derives the agency facet from the `source_url` host (`news_sources` has no agency column).
- `source_type` must satisfy the `news_sources` check constraint (`rss` etc. — see `20260718000300_generalize_news_sources.sql`).
- Duplicate `url` (after canonicalization) across the file or across loads: silently skipped, count reported.
- Scrape as much history as available; the pipeline is insensitive to load order (runner sorts by `published_at`).

## Global Constraints

- SQL house style (from the data-model plan, applies to Tasks 3–4): single `begin; … commit;` per migration, lowercase SQL, `public.`-qualified relations, `text` + `check` never enums, bounded `length()`/`cardinality()` checks, `comment on` everything non-obvious, `timestamptz`, pgTAP tests in `supabase/tests/database/<name>.test.sql`.
- RPCs: `security definer`, `set search_path = ''`, `revoke execute … from public, anon, authenticated`, `grant execute … to service_role`.
- Migration filenames continue the sequence: `20260718001000`, `20260718001100` (`20260718000900` is taken by news-backfill-control from the seeding workstream).
- SQL tests: `pnpm supabase db reset && pnpm supabase test db` (local stack via `pnpm supabase start`).
- Python: package dir `pipeline/` at repo root, tests in `tests/`, run `uv run pytest` (unit) and `uv run pytest -m integration` (needs local Supabase + applied migrations). Type hints everywhere; no framework, plain modules.
- Python env keys (read from `.env` via python-dotenv): `DATABASE_URL` (local default `postgresql://postgres:postgres@127.0.0.1:54322/postgres`), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, plus optional overrides for every config default in Task 1.
- Attach-method vocabularies are fixed by the data-model plan's check constraints — entry→episode: `exact_url | content_hash | near_dup | event_key | centroid_join | entity_community | adjudicated_join | adjudicated_new | new_cluster | consolidation_merge | consolidation_split`; episode→storyline: `event_key | entity_candidate | adjudicated_join | new_storyline | consolidation_merge`. Use exactly these strings.
- Determinism: extraction and normalization are pure functions versioned by `extractor_version = 1`; enrichment runs at temperature 0 and embeds always from stored `enriched_text`; adjudicator/judge failures default to split/prior (never merge on error).
- Commit after every green task. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Python scaffold — config, vectors, db access

Foundation module trio every later task imports.

**Files:**
- Modify: `pyproject.toml` (dependencies via `uv add`)
- Create: `pipeline/__init__.py`, `pipeline/config.py`, `pipeline/vectors.py`, `pipeline/db.py`
- Test: `tests/test_config.py`, `tests/test_vectors.py`

**Interfaces:**
- Produces: `Config` frozen dataclass + `load_config() -> Config`; `pack_fp16(vec) -> bytes`, `unpack_fp16(raw) -> np.ndarray`, `cosine(a, b) -> float`, `running_mean(current, count, new) -> np.ndarray`; `Db(dsn)` with `.rpc(fn, **kwargs)`, `.all(sql, params)`, `.one(sql, params)`.

- [ ] **Step 1: Add dependencies**

```bash
uv add "psycopg[binary]>=3.2" "httpx>=0.27" "numpy>=2" "python-dotenv>=1.0"
uv add --dev "pytest>=8"
```

Then add to `pyproject.toml`:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
markers = ["integration: needs local Supabase with migrations applied"]
addopts = "-m 'not integration'"
```

- [ ] **Step 2: Write the failing tests**

```python
# tests/test_config.py
from pipeline.config import load_config


def test_defaults(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "tok")
    cfg = load_config()
    assert cfg.embedding_model == "@cf/baai/bge-m3"
    assert cfg.near_dup_threshold == 0.90
    assert cfg.episode_dormancy_hours == 4.0
    assert cfg.enrichment_enabled is True


def test_overrides(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "tok")
    monkeypatch.setenv("NEAR_DUP_THRESHOLD", "0.87")
    monkeypatch.setenv("ENRICHMENT_ENABLED", "false")
    cfg = load_config()
    assert cfg.near_dup_threshold == 0.87
    assert cfg.enrichment_enabled is False
```

```python
# tests/test_vectors.py
import numpy as np
from pipeline.vectors import pack_fp16, unpack_fp16, cosine, running_mean


def test_fp16_roundtrip():
    v = [0.1, -0.5, 0.25, 1.0]
    out = unpack_fp16(pack_fp16(v))
    assert out.dtype == np.float32
    assert np.allclose(out, v, atol=1e-3)


def test_cosine():
    a = np.array([1.0, 0.0], dtype=np.float32)
    assert cosine(a, a) == 1.0
    assert cosine(a, np.array([0.0, 1.0], dtype=np.float32)) == 0.0
    assert cosine(a, np.zeros(2, dtype=np.float32)) == 0.0


def test_running_mean():
    m = running_mean(None, 0, np.array([2.0, 2.0]))
    assert np.allclose(m, [2.0, 2.0])
    m = running_mean(m, 1, np.array([4.0, 0.0]))
    assert np.allclose(m, [3.0, 1.0])
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_config.py tests/test_vectors.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline'`.

- [ ] **Step 4: Implement**

```python
# pipeline/__init__.py
```

```python
# pipeline/config.py
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class Config:
    database_url: str
    cf_account_id: str
    cf_api_token: str
    embedding_model: str = "@cf/baai/bge-m3"
    enricher_model: str = "@cf/meta/llama-3.1-8b-instruct-fast"
    adjudicator_model: str = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    judge_model: str = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    near_dup_threshold: float = 0.90        # calibrate via `eval` (design amendment 5)
    cluster_join_threshold: float = 0.78    # ditto
    storyline_sim_floor: float = 0.60
    episode_dormancy_hours: float = 4.0
    dedupe_window_hours: float = 72.0
    enrichment_enabled: bool = True
    enricher_version: int = 1
    rubric_version: int = 1
    prompt_version: int = 1
    tau_seconds: float = 124_600.0


def _f(key: str, default: float) -> float:
    return float(os.environ.get(key, default))


def _b(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    return default if raw is None else raw.strip().lower() in ("1", "true", "yes")


def load_config() -> Config:
    load_dotenv()
    return Config(
        database_url=os.environ["DATABASE_URL"],
        cf_account_id=os.environ["CLOUDFLARE_ACCOUNT_ID"],
        cf_api_token=os.environ["CLOUDFLARE_API_TOKEN"],
        embedding_model=os.environ.get("EMBEDDING_MODEL", Config.embedding_model),
        enricher_model=os.environ.get("ENRICHER_MODEL", Config.enricher_model),
        adjudicator_model=os.environ.get("ADJUDICATOR_MODEL", Config.adjudicator_model),
        judge_model=os.environ.get("JUDGE_MODEL", Config.judge_model),
        near_dup_threshold=_f("NEAR_DUP_THRESHOLD", Config.near_dup_threshold),
        cluster_join_threshold=_f("CLUSTER_JOIN_THRESHOLD", Config.cluster_join_threshold),
        storyline_sim_floor=_f("STORYLINE_SIM_FLOOR", Config.storyline_sim_floor),
        episode_dormancy_hours=_f("EPISODE_DORMANCY_HOURS", Config.episode_dormancy_hours),
        dedupe_window_hours=_f("DEDUPE_WINDOW_HOURS", Config.dedupe_window_hours),
        enrichment_enabled=_b("ENRICHMENT_ENABLED", Config.enrichment_enabled),
        enricher_version=int(os.environ.get("ENRICHER_VERSION", Config.enricher_version)),
        rubric_version=int(os.environ.get("RUBRIC_VERSION", Config.rubric_version)),
        prompt_version=int(os.environ.get("PROMPT_VERSION", Config.prompt_version)),
        tau_seconds=_f("TAU_SECONDS", Config.tau_seconds),
    )
```

```python
# pipeline/vectors.py
from __future__ import annotations

import numpy as np


def pack_fp16(vec: list[float] | np.ndarray) -> bytes:
    return np.asarray(vec, dtype=np.float16).tobytes()


def unpack_fp16(raw: bytes) -> np.ndarray:
    return np.frombuffer(raw, dtype=np.float16).astype(np.float32)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def running_mean(current: np.ndarray | None, count: int, new: np.ndarray) -> np.ndarray:
    if current is None or count == 0:
        return np.asarray(new, dtype=np.float32)
    return (current * count + new) / (count + 1)
```

```python
# pipeline/db.py
from __future__ import annotations

from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


class Db:
    """Thin Postgres access: raw reads + named-arg RPC calls. All writes go through RPCs."""

    def __init__(self, dsn: str) -> None:
        self.conn = psycopg.connect(dsn, row_factory=dict_row, autocommit=True)

    def rpc(self, fn: str, **kwargs: Any) -> Any:
        args = ", ".join(f"{k} => %({k})s" for k in kwargs)
        with self.conn.cursor() as cur:
            cur.execute(f"select public.{fn}({args}) as result", kwargs)
            row = cur.fetchone()
            return row["result"] if row else None

    def rpc_row(self, fn: str, **kwargs: Any) -> dict | None:
        args = ", ".join(f"{k} => %({k})s" for k in kwargs)
        with self.conn.cursor() as cur:
            cur.execute(f"select * from public.{fn}({args})", kwargs)
            return cur.fetchone()

    def all(self, sql: str, params: dict | tuple | None = None) -> list[dict]:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    def one(self, sql: str, params: dict | tuple | None = None) -> dict | None:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    @staticmethod
    def jsonb(value: Any) -> Jsonb:
        return Jsonb(value)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_config.py tests/test_vectors.py -v`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml uv.lock requirements.txt pipeline/ tests/
git commit -m "feat: scaffold python pipeline package (config, vectors, db)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Normalization + deterministic extraction

Pure, versioned functions: URL canonicalization, content hashing, salient-discriminator entities, hard event keys. The identity anchors of the whole system — richest test coverage in the plan.

**Files:**
- Create: `pipeline/normalize.py`, `pipeline/extraction.py`
- Test: `tests/test_normalize.py`, `tests/test_extraction.py`

**Interfaces:**
- Produces: `canonicalize_url(url: str) -> str`; `content_hash(title: str | None, summary: str | None) -> str` (64-char sha256 hex); `extract(title: str | None, summary: str | None) -> tuple[list[str], list[str]]` returning `(entity_set, event_keys)`, both sorted/deduped/casefolded; module constant `EXTRACTOR_VERSION = 1`.
- Rules consumed by Task 5 (seed loader) and Task 6 (engines). Entity extraction runs on RAW title/summary only — never enriched text (poisoning containment, v2 spec stage 0).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_normalize.py
from pipeline.normalize import canonicalize_url, content_hash


def test_strips_tracking_and_fragment():
    u = "https://WWW.FDA.gov/news/recall?utm_source=x&utm_medium=y&id=42#section"
    assert canonicalize_url(u) == "https://www.fda.gov/news/recall?id=42"


def test_sorts_query_and_strips_default_port():
    u = "https://fda.gov:443/a?b=2&a=1"
    assert canonicalize_url(u) == "https://fda.gov/a?a=1&b=2"


def test_strips_trailing_slash_on_path_only():
    assert canonicalize_url("https://fda.gov/news/") == "https://fda.gov/news"
    assert canonicalize_url("https://fda.gov/") == "https://fda.gov/"


def test_preserves_semantic_query_params():
    u = "https://regulations.gov/docket?D=EPA-HQ-2026-0001"
    assert "D=EPA-HQ-2026-0001" in canonicalize_url(u)


def test_content_hash_normalization_invariant():
    a = content_hash("FDA  Recalls Valsatrex", "Contamination   found.")
    b = content_hash("fda recalls valsatrex", "contamination found.")
    assert a == b
    assert len(a) == 64 and all(c in "0123456789abcdef" for c in a)


def test_content_hash_differs_on_content():
    assert content_hash("A", "x") != content_hash("B", "x")
    assert content_hash(None, None) == content_hash("", "")
```

```python
# tests/test_extraction.py
from pipeline.extraction import EXTRACTOR_VERSION, extract


def test_version_frozen():
    assert EXTRACTOR_VERSION == 1


def test_drug_recall_headline():
    entities, keys = extract(
        "FDA Announces Recall of Valsatrex Blood Pressure Medication",
        "Sundexo Pharmaceuticals initiated the recall after contamination was found.",
    )
    assert "valsatrex" in entities
    assert "sundexo" in entities
    # agency + boilerplate + common-english filtered
    for banned in ("fda", "announces", "recall", "blood", "pressure", "medication"):
        assert banned not in entities
    assert keys == []


def test_event_keys_extracted():
    entities, keys = extract(
        "EPA Proposes Rule on Emissions",
        "Comments accepted under docket EPA-HQ-OAR-2026-0143. See 40 CFR 60. "
        "Related advisory CVE-2026-12345 and FR document 2026-11234.",
    )
    assert "epa-hq-oar-2026-0143" in keys
    assert "cve-2026-12345" in keys
    assert "2026-11234" in keys
    assert "40 cfr 60" in keys


def test_all_caps_title_yields_inconclusive_not_noise():
    entities, _ = extract("FDA ANNOUNCES NATIONWIDE RECALL", None)
    assert entities == []  # empty = inconclusive; never vetoes (spec: precision over recall)


def test_sentence_initial_singleton_excluded():
    entities, _ = extract("Yesterday the agency acted", "Valsatrex was named.")
    assert "yesterday" not in entities
    assert "valsatrex" in entities


def test_dollar_amounts_captured():
    entities, _ = extract("HHS Awards Grant", "The department awarded $4.5 million to states.")
    assert "$4.5 million" in entities


def test_deterministic_and_sorted():
    a = extract("FDA Recalls Valsatrex", "Sundexo Pharmaceuticals recall.")
    b = extract("FDA Recalls Valsatrex", "Sundexo Pharmaceuticals recall.")
    assert a == b
    assert a[0] == sorted(a[0])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_normalize.py tests/test_extraction.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# pipeline/normalize.py
from __future__ import annotations

import hashlib
import re
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Tracking params only — semantic query params are preserved (spec caution:
# feed canonicalization must respect path/query semantics).
_TRACKING = {"gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "igshid", "_ga"}


def canonicalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    host = parts.hostname.lower() if parts.hostname else ""
    port = parts.port
    if port and not ((scheme == "https" and port == 443) or (scheme == "http" and port == 80)):
        host = f"{host}:{port}"
    path = parts.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    query_pairs = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in _TRACKING
    ]
    query = urlencode(sorted(query_pairs))
    return urlunsplit((scheme, host, path, query, ""))


def _norm_text(text: str | None) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    return re.sub(r"\s+", " ", text).strip().casefold()


def content_hash(title: str | None, summary: str | None) -> str:
    payload = _norm_text(title) + "\n" + _norm_text(summary)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
```

```python
# pipeline/extraction.py
"""Salient-discriminator extraction (entity guard) + hard event keys.

Pure, versioned: same (title, summary, EXTRACTOR_VERSION) -> identical output
on any instance, any replay. Runs on RAW title/summary only — never enriched
text. Subtractive by design: wide capitalization net filtered by frozen lexicons.
"""

from __future__ import annotations

import re
import unicodedata

EXTRACTOR_VERSION = 1

_EVENT_KEY_PATTERNS = [
    re.compile(r"\bCVE-\d{4}-\d{4,7}\b", re.IGNORECASE),                       # CVEs
    re.compile(r"\b[A-Z]{2,6}(?:-[A-Z]{1,6})*-\d{4}-\d{3,5}(?:-\d{1,6})?\b"),  # dockets
    re.compile(r"\b\d{4}-\d{5,6}\b"),                                          # FR doc numbers
    re.compile(r"\b\d{1,3}\s?CFR\s?(?:Part\s?)?\d+(?:\.\d+)?\b", re.IGNORECASE),
    re.compile(r"\b[ZF]-\d{4}-\d{2,4}\b"),                                     # FDA recall numbers
    re.compile(r"\bNo\.\s?\d{2}-\d{2,5}\b"),                                   # case numbers
]

_DOLLAR = re.compile(r"\$\d[\d,.]*(?:\s?(?:million|billion|trillion))?", re.IGNORECASE)
_CAP_SPAN = re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b")

_AGENCY_LEXICON = frozenset("""
fda hhs epa cdc nih usda doj dhs dod doe dot va ssa irs gsa nasa noaa fema cms
department administration agency office bureau commission federal national
united states secretary center centers institute institutes service services
""".split())

_BOILERPLATE_LEXICON = frozenset("""
announces announcement announced statement statements recall recalls notice
notices press release releases update updates news alert alerts issues issued
proposes proposed final rule rules regulation regulations report reports
january february march april may june july august september october november
december monday tuesday wednesday thursday friday saturday sunday today
yesterday week month year nationwide public
""".split())

_COMMON_ENGLISH = frozenset("""
blood pressure medication drug drugs company companies million billion state
states people american americans health safety program funding grant grants
water air food act law court case plan effort action actions
""".split())

_MIN_LEN = 4


def _first_sentence(text: str | None) -> str:
    text = text or ""
    match = re.search(r"[.!?](\s|$)", text)
    return text[: match.start() + 1] if match else text


def extract(title: str | None, summary: str | None) -> tuple[list[str], list[str]]:
    text = unicodedata.normalize("NFKC", (title or "") + ". " + _first_sentence(summary))

    keys: set[str] = set()
    for pattern in _EVENT_KEY_PATTERNS:
        for m in pattern.findall(text):
            keys.add(re.sub(r"\s+", " ", m).strip().casefold())

    entities: set[str] = set()
    for m in _DOLLAR.findall(text):
        entities.add(re.sub(r"\s+", " ", m).strip().casefold())

    sentence_starts = {s.strip()[:1] and s.strip().split()[0] for s in re.split(r"[.!?]", text) if s.strip()}
    for span in _CAP_SPAN.findall(text):
        tokens = span.split()
        for token in tokens:
            # sentence-initial singletons excluded
            if len(tokens) == 1 and span in sentence_starts:
                continue
            word = token.strip(".,;:'\"()").casefold()
            if len(word) < _MIN_LEN:
                continue
            if word in _AGENCY_LEXICON or word in _BOILERPLATE_LEXICON or word in _COMMON_ENGLISH:
                continue
            entities.add(word)

    return sorted(entities)[:64], sorted(keys)[:16]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_normalize.py tests/test_extraction.py -v`
Expected: PASS (13 tests). Iterate on regexes/lexicons until green — tests are the contract, not the draft implementation.

- [ ] **Step 5: Commit**

```bash
git add pipeline/normalize.py pipeline/extraction.py tests/test_normalize.py tests/test_extraction.py
git commit -m "feat: add versioned url/content normalization and entity/event-key extraction

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `compute_rank_key` function + rubric v1 seed weights

Ranking math in SQL, single source of truth. Cards are write-once, so this fires exactly once per card.

**Files:**
- Create: `supabase/migrations/20260718001000_create_compute_rank_key.sql`
- Test: `supabase/tests/database/compute_rank_key.test.sql`

**Interfaces:**
- Consumes: `public.rubric_weights` (data-model plan Task 5).
- Produces: `public.compute_rank_key(p_rubric jsonb, p_rubric_version integer, p_distinct_agencies integer, p_distinct_feeds integer, p_source_weight_max real, p_newest_entry_at timestamptz, p_tau double precision default 124600.0) returns double precision` — called by `insert_event_card` (Task 4). Rubric bits accepted as `1`/`true` jsonb values. Null rubric → prior = ½ Σ weights for the version. Seeds rubric v1: eight criteria (`mass_impact, health_safety, economic, policy_change, rights_legal, national_scope, urgency, novelty`), weight 1.0 each.

- [ ] **Step 1: Write the failing test**

```sql
-- supabase/tests/database/compute_rank_key.test.sql
begin;

select plan(7);

select has_function(
    'public', 'compute_rank_key',
    array['jsonb', 'integer', 'integer', 'integer', 'real', 'timestamptz', 'double precision'],
    'compute_rank_key exists with expected signature'
);

select is(
    (select count(*)::integer from public.rubric_weights where rubric_version = 1),
    8,
    'rubric v1 seeds eight criteria'
);

-- prior for unjudged = half the total weight (8 * 1.0 / 2 = 4.0)
select ok(
    abs(
        public.compute_rank_key(null, null, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz)
        - (4.0 + extract(epoch from '2026-01-01T00:00:00Z'::timestamptz) / 124600.0)
    ) < 1e-6,
    'null rubric scores the prior'
);

-- all-ones rubric beats the prior by the other half of the weights
select ok(
    public.compute_rank_key(
        '{"mass_impact":1,"health_safety":1,"economic":1,"policy_change":1,
          "rights_legal":1,"national_scope":1,"urgency":1,"novelty":1}'::jsonb,
        1, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz)
    > public.compute_rank_key(null, null, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz),
    'fully judged rubric outranks the prior'
);

select ok(
    public.compute_rank_key(null, null, 5, 5, 1.0, '2026-01-01T00:00:00Z'::timestamptz)
    > public.compute_rank_key(null, null, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz),
    'corroboration terms increase the key'
);

select ok(
    public.compute_rank_key(null, null, 0, 0, 1.0, '2026-01-02T00:00:00Z'::timestamptz)
    > public.compute_rank_key(null, null, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz),
    'fresher newest_entry_at increases the key'
);

-- boolean-typed bits also count
select ok(
    public.compute_rank_key('{"urgency":true}'::jsonb, 1, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz)
    > public.compute_rank_key('{}'::jsonb, 1, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz),
    'jsonb true counts as a set bit'
);

select * from finish();

rollback;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm supabase test db`
Expected: FAIL — `compute_rank_key exists with expected signature`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260718001000_create_compute_rank_key.sql
begin;

insert into public.rubric_weights (rubric_version, criterion, weight)
values
    (1, 'mass_impact', 1.0),
    (1, 'health_safety', 1.0),
    (1, 'economic', 1.0),
    (1, 'policy_change', 1.0),
    (1, 'rights_legal', 1.0),
    (1, 'national_scope', 1.0),
    (1, 'urgency', 1.0),
    (1, 'novelty', 1.0);

create or replace function public.compute_rank_key(
    p_rubric jsonb,
    p_rubric_version integer,
    p_distinct_agencies integer,
    p_distinct_feeds integer,
    p_source_weight_max real,
    p_newest_entry_at timestamptz,
    p_tau double precision default 124600.0
) returns double precision
language sql
stable
set search_path = ''
as $fn$
    select
        case
            when p_rubric is null then
                (select 0.5 * sum(rw.weight)
                 from public.rubric_weights rw
                 where rw.rubric_version = coalesce(p_rubric_version, 1))
            else
                coalesce(
                    (select sum(
                        case
                            when p_rubric -> rw.criterion in ('1'::jsonb, 'true'::jsonb) then rw.weight
                            else 0.0
                        end)
                     from public.rubric_weights rw
                     where rw.rubric_version = p_rubric_version),
                    0.0)
        end
        + 0.5 * ln(1 + greatest(coalesce(p_distinct_agencies, 0), 0))
        + 0.5 * ln(1 + greatest(coalesce(p_distinct_feeds, 0), 0))
        + ln(greatest(coalesce(p_source_weight_max, 1.0), 0.001))
        + extract(epoch from least(p_newest_entry_at, now())) / p_tau
$fn$;

comment on function public.compute_rank_key is
    'Single source of truth for card rank_key: rubric points (prior = half total weight when unjudged) + corroboration logs + source authority + freshness/tau. Cards are write-once, so this runs exactly once per card.';

revoke execute on function public.compute_rank_key(jsonb, integer, integer, integer, real, timestamptz, double precision)
    from public, anon, authenticated;
grant execute on function public.compute_rank_key(jsonb, integer, integer, integer, real, timestamptz, double precision)
    to service_role;

commit;
```

- [ ] **Step 4: Apply and run tests**

Run: `pnpm supabase db reset && pnpm supabase test db`
Expected: PASS — 7 assertions green; all prior suites green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260718001000_create_compute_rank_key.sql supabase/tests/database/compute_rank_key.test.sql
git commit -m "feat: add compute_rank_key function and rubric v1 weights

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Clustering write RPCs

The only write path into the clustering tables (data-model plan grants `select` only). Six `security definer` functions; every aggregate is recomputed from junction rows inside the transaction, so replays converge (idempotent by construction).

**Files:**
- Create: `supabase/migrations/20260718001100_create_clustering_write_rpcs.sql`
- Test: `supabase/tests/database/clustering_write_rpcs.test.sql`

**Interfaces:**
- Consumes: all tables from the data-model plan; `compute_rank_key` from Task 3.
- Produces (exact signatures the Python store in Task 6 calls):
  - `upsert_news_source(p_canonical_url text, p_source_type text, p_title text default null) returns uuid`
  - `ingest_news_entry(p_news_source_id uuid, p_url text, p_url_canonical text, p_title text, p_summary text, p_published_at timestamptz, p_content_hash text, p_entity_set text[], p_event_keys text[], p_extractor_version integer) returns uuid` — null on duplicate `url_canonical`; upserts `entity_stats` (lazy EMA decay, 7-day half-life) for every entity and event key.
  - `update_entry_features(p_entry_id uuid, p_enriched_text text, p_enricher_version integer, p_embedding bytea, p_embedding_model text) returns void`
  - `create_episode_with_storyline(p_storyline_id uuid, p_attach_method text, p_attach_similarity real, p_attach_reason text, p_adjudicator_model text, p_event_time timestamptz) returns table (episode_id uuid, storyline_id uuid)` — null `p_storyline_id` creates a storyline (method must then be `new_storyline`).
  - `attach_entry_to_episode(p_entry_id uuid, p_episode_id uuid, p_agency text, p_is_syndicated boolean, p_attach_method text, p_similarity real, p_matched_entry_id uuid, p_threshold_used real, p_embedding_model text, p_episode_centroid bytea, p_published_at timestamptz) returns void`
  - `close_episode(p_episode_id uuid) returns boolean` — true iff transitioned open→dormant.
  - `insert_event_card(p_storyline_id uuid, p_episode_id uuid, p_kind text, p_headline text, p_summary text, p_timeline jsonb, p_rubric jsonb, p_rubric_version integer, p_interest_reason text, p_representative_entry_id uuid, p_judge_model text, p_prompt_version integer, p_overview_embedding bytea, p_tau double precision default 124600.0) returns uuid` — computes `rank_key` at birth; for `overview` kind: supersedes the previous overview, updates `storylines.latest_card_id` and `storylines.centroid` (design amendment 3); for `episode` kind on a single-episode storyline: sets `latest_card_id` when unset (single-episode collapse).

- [ ] **Step 1: Write the failing test**

```sql
-- supabase/tests/database/clustering_write_rpcs.test.sql
begin;

select plan(12);

select has_function('public', 'upsert_news_source', array['text', 'text', 'text'],
    'upsert_news_source exists');
select has_function('public', 'ingest_news_entry',
    array['uuid', 'text', 'text', 'text', 'text', 'timestamptz', 'text', 'text[]', 'text[]', 'integer'],
    'ingest_news_entry exists');
select has_function('public', 'attach_entry_to_episode',
    array['uuid', 'uuid', 'text', 'boolean', 'text', 'real', 'uuid', 'real', 'text', 'bytea', 'timestamptz'],
    'attach_entry_to_episode exists');

-- happy path: source -> entry -> episode+storyline -> attach -> card
select lives_ok($setup$
    do $body$
    declare
        v_source uuid;
        v_entry uuid;
        v_episode uuid;
        v_storyline uuid;
        v_card uuid;
    begin
        v_source := public.upsert_news_source('https://example.gov/feed.xml', 'rss', 'Example');
        v_entry := public.ingest_news_entry(
            v_source,
            'https://example.gov/a?utm=1', 'https://example.gov/a',
            'FDA recalls Valsatrex', 'Sundexo Pharmaceuticals recall.',
            '2026-05-14T14:30:00Z', repeat('ab', 32),
            array['valsatrex', 'sundexo'], array['z-2026-0143'], 1);
        select t.episode_id, t.storyline_id into v_episode, v_storyline
        from public.create_episode_with_storyline(
            null, 'new_storyline', null, null, null, '2026-05-14T14:30:00Z') t;
        perform public.attach_entry_to_episode(
            v_entry, v_episode, 'fda.gov', false, 'new_cluster',
            null, null, null, 'stub', null, '2026-05-14T14:30:00Z');
        v_card := public.insert_event_card(
            v_storyline, v_episode, 'episode',
            'FDA recalls Valsatrex', 'Recall pulse.', null,
            null, null, null, v_entry, 'stub-judge', 1, null);
        if v_card is null then raise exception 'card not created'; end if;
    end
    $body$;
$setup$, 'full write path executes');

select is(
    (select count(*)::integer from public.news_entries where url_canonical = 'https://example.gov/a'),
    1, 'entry landed');

select ok(
    (select entry_count = 1 and cardinality(entity_set) = 2 and 'z-2026-0143' = any(event_keys)
     from public.episodes limit 1),
    'episode aggregates recomputed from junction');

select ok(
    (select entry_count = 1 and episode_count = 1 and distinct_feeds = 1
        and 'fda.gov' = any(agency_ids) and 'valsatrex' = any(entity_set)
     from public.storylines limit 1),
    'storyline aggregates recomputed');

select ok(
    (select daily_ema > 0 and total_count = 1 from public.entity_stats where entity = 'valsatrex'),
    'entity_stats upserted on ingest');

select is(
    public.ingest_news_entry(
        (select id from public.news_sources limit 1),
        'https://example.gov/a', 'https://example.gov/a', 'dup', 'dup',
        '2026-05-14T15:00:00Z', repeat('cd', 32), '{}', '{}', 1),
    null, 'duplicate url_canonical returns null');

-- replay safety: same attach twice does not double-count
select lives_ok($replay$
    select public.attach_entry_to_episode(
        (select id from public.news_entries where url_canonical = 'https://example.gov/a'),
        (select id from public.episodes limit 1),
        'fda.gov', false, 'new_cluster', null, null, null, 'stub', null,
        '2026-05-14T14:30:00Z')
$replay$, 'replayed attach is a no-op');

select ok(
    (select entry_count = 1 from public.episodes limit 1),
    'replay did not inflate entry_count');

select ok(
    not has_function_privilege('anon',
        'public.ingest_news_entry(uuid, text, text, text, text, timestamptz, text, text[], text[], integer)',
        'execute'),
    'anon cannot execute write RPCs');

select * from finish();

rollback;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm supabase test db`
Expected: FAIL — `upsert_news_source exists`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260718001100_create_clustering_write_rpcs.sql
begin;

create or replace function public.upsert_news_source(
    p_canonical_url text,
    p_source_type text,
    p_title text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_id uuid;
begin
    insert into public.news_sources (canonical_url, source_type, title)
    values (p_canonical_url, p_source_type, p_title)
    on conflict (canonical_url) do nothing
    returning id into v_id;
    if v_id is null then
        select id into v_id from public.news_sources
        where canonical_url = p_canonical_url;
    end if;
    return v_id;
end
$fn$;

create or replace function public.ingest_news_entry(
    p_news_source_id uuid,
    p_url text,
    p_url_canonical text,
    p_title text,
    p_summary text,
    p_published_at timestamptz,
    p_content_hash text,
    p_entity_set text[],
    p_event_keys text[],
    p_extractor_version integer
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_id uuid;
    v_token text;
    v_t timestamptz := coalesce(p_published_at, now());
begin
    insert into public.news_entries
        (news_source_id, url, url_canonical, title, summary,
         published_at, content_hash, entity_set, event_keys, extractor_version)
    values
        (p_news_source_id, p_url, p_url_canonical, p_title, p_summary,
         p_published_at, p_content_hash, p_entity_set, p_event_keys, p_extractor_version)
    on conflict (url_canonical) do nothing
    returning id into v_id;

    if v_id is null then
        return null;
    end if;

    foreach v_token in array (p_entity_set || p_event_keys) loop
        insert into public.entity_stats as es
            (entity, first_seen_at, last_seen_at, total_count, daily_ema, ema_updated_at)
        values (v_token, v_t, v_t, 1, 1.0, v_t)
        on conflict (entity) do update set
            first_seen_at = least(es.first_seen_at, excluded.first_seen_at),
            last_seen_at = greatest(es.last_seen_at, excluded.last_seen_at),
            total_count = es.total_count + 1,
            -- lazy EMA: decay by elapsed days (7-day half-life), then increment
            daily_ema = es.daily_ema
                * power(0.5, greatest(extract(epoch from (excluded.ema_updated_at - es.ema_updated_at)), 0) / (86400.0 * 7.0))
                + 1.0,
            ema_updated_at = greatest(es.ema_updated_at, excluded.ema_updated_at);
    end loop;

    return v_id;
end
$fn$;

create or replace function public.update_entry_features(
    p_entry_id uuid,
    p_enriched_text text,
    p_enricher_version integer,
    p_embedding bytea,
    p_embedding_model text
) returns void
language sql
security definer
set search_path = ''
as $fn$
    update public.news_entries set
        enriched_text = coalesce(p_enriched_text, enriched_text),
        enricher_version = coalesce(p_enricher_version, enricher_version),
        embedding = coalesce(p_embedding, embedding),
        embedding_model = coalesce(p_embedding_model, embedding_model)
    where id = p_entry_id;
$fn$;

create or replace function public.create_episode_with_storyline(
    p_storyline_id uuid,
    p_attach_method text,
    p_attach_similarity real,
    p_attach_reason text,
    p_adjudicator_model text,
    p_event_time timestamptz
) returns table (episode_id uuid, storyline_id uuid)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_storyline uuid := p_storyline_id;
    v_episode uuid;
begin
    if v_storyline is null then
        if p_attach_method <> 'new_storyline' then
            raise exception 'null storyline requires attach_method new_storyline, got %', p_attach_method;
        end if;
        insert into public.storylines (first_entry_at, newest_entry_at)
        values (p_event_time, p_event_time)
        returning id into v_storyline;
    end if;

    insert into public.episodes
        (storyline_id, first_entry_at, newest_entry_at,
         attach_method, attach_similarity, attach_reason, adjudicator_model)
    values
        (v_storyline, p_event_time, p_event_time,
         p_attach_method, p_attach_similarity, p_attach_reason, p_adjudicator_model)
    returning id into v_episode;

    update public.storylines s
    set episode_count = (select count(*) from public.episodes e where e.storyline_id = s.id)
    where s.id = v_storyline;

    return query select v_episode, v_storyline;
end
$fn$;

create or replace function public.attach_entry_to_episode(
    p_entry_id uuid,
    p_episode_id uuid,
    p_agency text,
    p_is_syndicated boolean,
    p_attach_method text,
    p_similarity real,
    p_matched_entry_id uuid,
    p_threshold_used real,
    p_embedding_model text,
    p_episode_centroid bytea,
    p_published_at timestamptz
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_storyline uuid;
begin
    insert into public.episode_entries
        (episode_id, entry_id, is_syndicated, attach_method, similarity,
         matched_entry_id, threshold_used, embedding_model)
    values
        (p_episode_id, p_entry_id, p_is_syndicated, p_attach_method, p_similarity,
         p_matched_entry_id, p_threshold_used, p_embedding_model)
    on conflict do nothing;

    if not found then
        return;  -- replay: junction row already exists, aggregates already counted
    end if;

    select e.storyline_id into v_storyline from public.episodes e where e.id = p_episode_id;

    update public.news_entries
    set episode_id = p_episode_id
    where id = p_entry_id and episode_id is null;

    update public.episodes e set
        entry_count = (select count(*) from public.episode_entries ee where ee.episode_id = e.id),
        first_entry_at = least(e.first_entry_at, coalesce(p_published_at, e.first_entry_at)),
        newest_entry_at = greatest(e.newest_entry_at, coalesce(p_published_at, e.newest_entry_at)),
        centroid = coalesce(p_episode_centroid, e.centroid),
        entity_set = (
            select coalesce(array_agg(x order by x), '{}'::text[]) from (
                select distinct unnest(ne.entity_set) as x
                from public.episode_entries ee
                join public.news_entries ne on ne.id = ee.entry_id
                where ee.episode_id = e.id
                limit 128
            ) t
        ),
        event_keys = (
            select coalesce(array_agg(x order by x), '{}'::text[]) from (
                select distinct unnest(ne.event_keys) as x
                from public.episode_entries ee
                join public.news_entries ne on ne.id = ee.entry_id
                where ee.episode_id = e.id
                limit 32
            ) t
        )
    where e.id = p_episode_id;

    update public.storylines s set
        entry_count = (
            select count(*) from public.episode_entries ee
            join public.episodes ep on ep.id = ee.episode_id
            where ep.storyline_id = s.id
        ),
        distinct_feeds = (
            select count(distinct ne.news_source_id) from public.episode_entries ee
            join public.episodes ep on ep.id = ee.episode_id
            join public.news_entries ne on ne.id = ee.entry_id
            where ep.storyline_id = s.id
        ),
        agency_ids = (
            select coalesce(array_agg(x order by x), '{}'::text[]) from (
                select distinct x from unnest(s.agency_ids || array[p_agency]) as t(x)
                where x is not null
                limit 128
            ) t
        ),
        entity_set = (
            select coalesce(array_agg(x order by x), '{}'::text[]) from (
                select distinct unnest(ep.entity_set) as x
                from public.episodes ep where ep.storyline_id = s.id
                limit 256
            ) t
        ),
        event_keys = (
            select coalesce(array_agg(x order by x), '{}'::text[]) from (
                select distinct unnest(ep.event_keys) as x
                from public.episodes ep where ep.storyline_id = s.id
                limit 64
            ) t
        ),
        first_entry_at = least(s.first_entry_at, coalesce(p_published_at, s.first_entry_at)),
        newest_entry_at = greatest(s.newest_entry_at, coalesce(p_published_at, s.newest_entry_at))
    where s.id = v_storyline;
end
$fn$;

create or replace function public.close_episode(
    p_episode_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_closed boolean;
begin
    update public.episodes
    set status = 'dormant'
    where id = p_episode_id and status = 'open';
    v_closed := found;
    return v_closed;
end
$fn$;

create or replace function public.insert_event_card(
    p_storyline_id uuid,
    p_episode_id uuid,
    p_kind text,
    p_headline text,
    p_summary text,
    p_timeline jsonb,
    p_rubric jsonb,
    p_rubric_version integer,
    p_interest_reason text,
    p_representative_entry_id uuid,
    p_judge_model text,
    p_prompt_version integer,
    p_overview_embedding bytea,
    p_tau double precision default 124600.0
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_card uuid;
    v_version integer;
    s public.storylines%rowtype;
begin
    select * into s from public.storylines where id = p_storyline_id;

    select coalesce(max(version), 0) + 1 into v_version
    from public.event_cards
    where storyline_id = p_storyline_id and kind = p_kind;

    insert into public.event_cards
        (storyline_id, episode_id, kind, version, headline, summary, timeline,
         rubric, rubric_version, interest_reason, representative_entry_id,
         newest_entry_at, rank_key, judge_model, prompt_version)
    values
        (p_storyline_id, p_episode_id, p_kind, v_version, p_headline, p_summary, p_timeline,
         p_rubric, p_rubric_version, p_interest_reason, p_representative_entry_id,
         s.newest_entry_at,
         public.compute_rank_key(
             p_rubric, p_rubric_version,
             cardinality(s.agency_ids), s.distinct_feeds,
             s.source_weight_max, s.newest_entry_at, p_tau),
         p_judge_model, p_prompt_version)
    returning id into v_card;

    if p_kind = 'overview' then
        update public.event_cards
        set superseded_by = v_card
        where storyline_id = p_storyline_id
          and kind = 'overview'
          and superseded_by is null
          and id <> v_card;
        update public.storylines
        set latest_card_id = v_card,
            centroid = coalesce(p_overview_embedding, centroid)
        where id = p_storyline_id;
    elsif p_kind = 'episode' and s.latest_card_id is null then
        -- single-episode collapse: the episode card doubles as the overview
        update public.storylines set latest_card_id = v_card where id = p_storyline_id;
    end if;

    return v_card;
end
$fn$;

comment on function public.attach_entry_to_episode is
    'Sole entry->episode write path. Junction insert is the idempotency guard; every aggregate recomputes from junction rows, so replays converge.';
comment on function public.insert_event_card is
    'Write-once card insert: rank_key computed at birth; overview kind supersedes the previous overview and refreshes storylines.latest_card_id + centroid (overview embedding).';

do $grants$
declare
    v_sig text;
begin
    foreach v_sig in array array[
        'public.upsert_news_source(text, text, text)',
        'public.ingest_news_entry(uuid, text, text, text, text, timestamptz, text, text[], text[], integer)',
        'public.update_entry_features(uuid, text, integer, bytea, text)',
        'public.create_episode_with_storyline(uuid, text, real, text, text, timestamptz)',
        'public.attach_entry_to_episode(uuid, uuid, text, boolean, text, real, uuid, real, text, bytea, timestamptz)',
        'public.close_episode(uuid)',
        'public.insert_event_card(uuid, uuid, text, text, text, jsonb, jsonb, integer, text, uuid, text, integer, bytea, double precision)'
    ] loop
        execute format('revoke execute on function %s from public, anon, authenticated', v_sig);
        execute format('grant execute on function %s to service_role', v_sig);
    end loop;
end
$grants$;

commit;
```

- [ ] **Step 4: Apply and run tests**

Run: `pnpm supabase db reset && pnpm supabase test db`
Expected: PASS — 12 assertions green; all prior suites green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260718001100_create_clustering_write_rpcs.sql supabase/tests/database/clustering_write_rpcs.test.sql
git commit -m "feat: add security definer write RPCs for clustering pipeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Workers AI clients, prompts, validators, deterministic stubs

All inference behind one interface so engines are testable and the whole pipeline can run LLM-free (stubs) for integration tests and dry runs.

**Files:**
- Create: `pipeline/ai.py`, `pipeline/prompts.py`, `pipeline/stub.py`
- Test: `tests/test_ai.py`, `tests/test_prompts.py`, `tests/test_stub.py`

**Interfaces:**
- Produces the `ModelClient` protocol both engines consume:
  - `embed(texts: list[str]) -> list[np.ndarray]`
  - `enrich(title: str, summary: str | None) -> str`
  - `adjudicate_same_event(a: dict, b: dict, context: str) -> tuple[bool, str]` — split-biased; any error/timeout returns `(False, "adjudicator_error: ...")`
  - `compress_overview(storyline_summary: dict, episode_cards: list[dict]) -> dict` — returns `{headline, summary, timeline: [{episode_id, date, text}], rubric: {bit: 0|1}, reason}`
- `WorkersAI(cfg, transport=None)` implements it over Cloudflare REST (`transport` injectable for tests); `StubModels()` implements it deterministically (hashing bag-of-words embedder, entity-overlap adjudicator, template compressor).
- `pipeline/prompts.py` exports `validate_timeline(timeline: list[dict], valid_episode_ids: set[str]) -> list[dict]` (design amendment 4) plus the prompt-builder functions.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_prompts.py
from pipeline.prompts import build_adjudicator_prompt, validate_timeline


def test_adjudicator_prompt_is_split_biased():
    system, _ = build_adjudicator_prompt(
        {"title": "A", "summary": "x", "entities": ["a"]},
        {"title": "B", "summary": "y", "entities": ["b"]},
        context="",
    )
    lowered = system.lower()
    assert "only if clearly the same specific" in lowered
    assert "different products, companies, cases, or locations" in lowered


def test_validate_timeline_drops_uncited_and_unknown():
    timeline = [
        {"episode_id": "e1", "date": "2026-05-14", "text": "Recall announced"},
        {"episode_id": "hallucinated", "date": "2026-05-15", "text": "Made up"},
        {"date": "2026-05-16", "text": "No citation"},
    ]
    out = validate_timeline(timeline, {"e1", "e2"})
    assert out == [{"episode_id": "e1", "date": "2026-05-14", "text": "Recall announced"}]
```

```python
# tests/test_ai.py
import json

import httpx
import numpy as np

from pipeline.ai import WorkersAI
from pipeline.config import Config


def _cfg() -> Config:
    return Config(database_url="x", cf_account_id="acct", cf_api_token="tok")


def _transport(handler):
    return httpx.MockTransport(handler)


def test_embed_parses_batch():
    def handler(request):
        assert "acct/ai/run/@cf/baai/bge-m3" in str(request.url)
        return httpx.Response(200, json={"result": {"data": [[0.1, 0.2], [0.3, 0.4]]}, "success": True})

    ai = WorkersAI(_cfg(), transport=_transport(handler))
    vecs = ai.embed(["a", "b"])
    assert len(vecs) == 2
    assert isinstance(vecs[0], np.ndarray)


def test_adjudicate_parses_json_and_defaults_to_split_on_error():
    def ok(request):
        body = json.loads(request.content)
        assert body.get("temperature") == 0
        return httpx.Response(200, json={
            "result": {"response": json.dumps({"same_event": True, "reason": "same recall"})},
            "success": True,
        })

    ai = WorkersAI(_cfg(), transport=_transport(ok))
    same, reason = ai.adjudicate_same_event(
        {"title": "A", "summary": "", "entities": []},
        {"title": "B", "summary": "", "entities": []},
        context="",
    )
    assert same is True and reason == "same recall"

    def boom(request):
        return httpx.Response(500, json={"success": False})

    ai = WorkersAI(_cfg(), transport=_transport(boom))
    same, reason = ai.adjudicate_same_event(
        {"title": "A", "summary": "", "entities": []},
        {"title": "B", "summary": "", "entities": []},
        context="",
    )
    assert same is False
    assert reason.startswith("adjudicator_error")
```

```python
# tests/test_stub.py
from pipeline.stub import StubModels
from pipeline.vectors import cosine


def test_stub_embedder_similarity_ordering():
    stub = StubModels()
    a, b, c = stub.embed([
        "FDA recalls Valsatrex blood pressure medication contamination",
        "Valsatrex recall expanded by FDA after contamination found",
        "EPA finalizes emissions rule for power plants",
    ])
    assert cosine(a, b) > cosine(a, c)


def test_stub_adjudicator_uses_entity_overlap():
    stub = StubModels()
    same, _ = stub.adjudicate_same_event(
        {"title": "x", "summary": "", "entities": ["valsatrex"]},
        {"title": "y", "summary": "", "entities": ["valsatrex", "sundexo"]},
        context="",
    )
    assert same is True
    same, _ = stub.adjudicate_same_event(
        {"title": "x", "summary": "", "entities": ["valsatrex"]},
        {"title": "y", "summary": "", "entities": ["oxprenol"]},
        context="",
    )
    assert same is False


def test_stub_compressor_cites_episodes():
    stub = StubModels()
    card = stub.compress_overview(
        {"id": "s1"},
        [{"episode_id": "e1", "date": "2026-05-14", "headline": "Recall announced", "summary": "..."}],
    )
    assert card["timeline"][0]["episode_id"] == "e1"
    assert set(card["rubric"]) == {
        "mass_impact", "health_safety", "economic", "policy_change",
        "rights_legal", "national_scope", "urgency", "novelty",
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_ai.py tests/test_prompts.py tests/test_stub.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# pipeline/prompts.py
from __future__ import annotations

import json

RUBRIC_CRITERIA = [
    "mass_impact", "health_safety", "economic", "policy_change",
    "rights_legal", "national_scope", "urgency", "novelty",
]

ENRICHER_SYSTEM = (
    "You rewrite US government news items into one dense, self-contained event "
    "description of 2-3 sentences for semantic search. Restate and contextualize "
    "what is stated; name the acting agency, the specific subject, and the action. "
    "Add no facts that are not in the input. Output only the description."
)

ADJUDICATOR_SYSTEM = (
    "You decide whether two US government news items describe the same specific "
    "real-world event. Answer true only if clearly the same specific event; "
    "different products, companies, cases, or locations = different events. "
    "When uncertain, answer false. "
    'Respond with JSON only: {"same_event": boolean, "reason": "one sentence"}'
)

COMPRESSOR_SYSTEM = (
    "You compress a chain of related US government news episodes into an overview card. "
    "Respond with JSON only, schema: "
    '{"headline": string, "summary": string (<= 3 sentences), '
    '"timeline": [{"episode_id": string, "date": "YYYY-MM-DD", "text": string}], '
    '"rubric": {' + ", ".join(f'"{c}": 0 or 1' for c in RUBRIC_CRITERIA) + '}, '
    '"reason": "one sentence explaining the rubric"}. '
    "Every timeline item MUST cite one episode_id from the input verbatim. "
    "Use only facts present in the input episodes."
)


def build_enricher_prompt(title: str, summary: str | None) -> tuple[str, str]:
    return ENRICHER_SYSTEM, f"Title: {title}\nSummary: {summary or '(none)'}"


def build_adjudicator_prompt(a: dict, b: dict, context: str) -> tuple[str, str]:
    user = (
        f"Item A title: {a['title']}\nItem A summary: {a.get('summary') or '(none)'}\n"
        f"Item A entities: {', '.join(a.get('entities', [])) or '(none)'}\n\n"
        f"Item B title: {b['title']}\nItem B summary: {b.get('summary') or '(none)'}\n"
        f"Item B entities: {', '.join(b.get('entities', [])) or '(none)'}"
    )
    if context:
        user += f"\n\nContext: {context}"
    return ADJUDICATOR_SYSTEM, user


def build_compressor_prompt(storyline_summary: dict, episode_cards: list[dict]) -> tuple[str, str]:
    episodes = [
        {"episode_id": str(c["episode_id"]), "date": c["date"], "headline": c["headline"], "summary": c["summary"]}
        for c in episode_cards
    ]
    return COMPRESSOR_SYSTEM, "Episodes (oldest first):\n" + json.dumps(episodes, indent=2)


def validate_timeline(timeline: list[dict], valid_episode_ids: set[str]) -> list[dict]:
    """Hallucination guard: drop bullets that do not cite a real member episode."""
    return [
        item for item in (timeline or [])
        if isinstance(item, dict) and str(item.get("episode_id")) in valid_episode_ids
    ]
```

```python
# pipeline/ai.py
from __future__ import annotations

import json
import re

import httpx
import numpy as np

from pipeline.config import Config
from pipeline.prompts import (
    RUBRIC_CRITERIA,
    build_adjudicator_prompt,
    build_compressor_prompt,
    build_enricher_prompt,
)


def _extract_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"no json object in model output: {text[:200]}")
    return json.loads(match.group(0))


class WorkersAI:
    def __init__(self, cfg: Config, transport: httpx.BaseTransport | None = None) -> None:
        self.cfg = cfg
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{cfg.cf_account_id}/ai/run/"
        self.http = httpx.Client(
            headers={"Authorization": f"Bearer {cfg.cf_api_token}"},
            timeout=120.0,
            transport=transport,
        )

    def _run(self, model: str, payload: dict) -> dict:
        response = self.http.post(self.base + model, json=payload)
        response.raise_for_status()
        body = response.json()
        if not body.get("success", False):
            raise RuntimeError(f"workers ai error: {body.get('errors')}")
        return body["result"]

    def _chat(self, model: str, system: str, user: str) -> str:
        result = self._run(model, {
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
        })
        return result["response"]

    def embed(self, texts: list[str]) -> list[np.ndarray]:
        result = self._run(self.cfg.embedding_model, {"text": texts})
        return [np.asarray(v, dtype=np.float32) for v in result["data"]]

    def enrich(self, title: str, summary: str | None) -> str:
        system, user = build_enricher_prompt(title, summary)
        return self._chat(self.cfg.enricher_model, system, user).strip()

    def adjudicate_same_event(self, a: dict, b: dict, context: str) -> tuple[bool, str]:
        system, user = build_adjudicator_prompt(a, b, context)
        try:
            parsed = _extract_json(self._chat(self.cfg.adjudicator_model, system, user))
            return bool(parsed.get("same_event", False)), str(parsed.get("reason", ""))
        except Exception as exc:  # split-biased: any failure means "not the same event"
            return False, f"adjudicator_error: {exc}"

    def compress_overview(self, storyline_summary: dict, episode_cards: list[dict]) -> dict:
        system, user = build_compressor_prompt(storyline_summary, episode_cards)
        parsed = _extract_json(self._chat(self.cfg.judge_model, system, user))
        parsed.setdefault("rubric", {})
        for criterion in RUBRIC_CRITERIA:
            parsed["rubric"].setdefault(criterion, 0)
        return parsed
```

```python
# pipeline/stub.py
"""Deterministic LLM-free ModelClient for tests, dry runs, and CI.

Embedder: hashed bag-of-words (similar texts share tokens -> high cosine).
Adjudicator: same_event iff entity sets overlap. Compressor: template with
verbatim episode citations. No randomness, no network, no clock.
"""

from __future__ import annotations

import hashlib

import numpy as np

from pipeline.prompts import RUBRIC_CRITERIA

_DIM = 256


class StubModels:
    def embed(self, texts: list[str]) -> list[np.ndarray]:
        out: list[np.ndarray] = []
        for text in texts:
            vec = np.zeros(_DIM, dtype=np.float32)
            for token in text.casefold().split():
                token = token.strip(".,;:!?()'\"")
                if len(token) < 3:
                    continue
                digest = hashlib.sha256(token.encode()).digest()
                vec[digest[0] % _DIM] += 1.0
                vec[digest[1] % _DIM] += 1.0
            norm = np.linalg.norm(vec)
            out.append(vec / norm if norm > 0 else vec)
        return out

    def enrich(self, title: str, summary: str | None) -> str:
        return f"{title}. {summary or ''}".strip()

    def adjudicate_same_event(self, a: dict, b: dict, context: str) -> tuple[bool, str]:
        overlap = set(a.get("entities", [])) & set(b.get("entities", []))
        if overlap:
            return True, f"stub: shared entities {sorted(overlap)}"
        return False, "stub: disjoint entities"

    def compress_overview(self, storyline_summary: dict, episode_cards: list[dict]) -> dict:
        latest = episode_cards[-1]
        return {
            "headline": latest["headline"],
            "summary": " / ".join(c["headline"] for c in episode_cards),
            "timeline": [
                {"episode_id": str(c["episode_id"]), "date": c["date"], "text": c["headline"]}
                for c in episode_cards
            ],
            "rubric": {c: 0 for c in RUBRIC_CRITERIA},
            "reason": "stub rubric",
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_ai.py tests/test_prompts.py tests/test_stub.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline/ai.py pipeline/prompts.py pipeline/stub.py tests/test_ai.py tests/test_prompts.py tests/test_stub.py
git commit -m "feat: add workers ai clients, prompts, timeline validator, deterministic stubs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Store + episode formation engine

`Store` wraps every SQL read and RPC write (single seam for tests). `EpisodeEngine` implements Stage 1: dedupe tiers → event-key tier → centroid nominate / entity gate / adjudicate → new episode; plus event-time dormancy closes.

**Files:**
- Create: `pipeline/store.py`, `pipeline/episodes.py`
- Test: `tests/test_episodes.py`, `tests/fakes.py`

**Interfaces:**
- Consumes: `Db` (Task 1), extraction/normalize (Task 2), `ModelClient` (Task 5), RPCs (Task 4).
- Produces:
  - `Store(db)` methods: `upsert_news_source(canonical_url, source_type, title) -> str`; `ingest_entry(source_id, url, url_canonical, title, summary, published_at, hash_, entities, keys) -> str | None`; `update_entry_features(entry_id, enriched_text, enricher_version, embedding_bytes, embedding_model)`; `content_hash_dup(hash_, t, window_hours) -> dict | None`; `recent_embedded(t, window_hours) -> list[dict]` (`{id, episode_id, embedding}`); `open_episodes() -> list[dict]`; `create_episode(storyline_id, method, similarity, reason, model, t) -> (episode_id, storyline_id)`; `attach_entry(...)` mirroring the RPC; `close_episode(episode_id) -> bool`; `episode_members(episode_id) -> list[dict]`; `unprocessed_entries(batch) -> list[dict]` ordered by `published_at`; storyline reads used by Task 7: `storylines_by_event_keys(keys)`, `storylines_by_entities(entities)`, `entity_emas(entities) -> dict[str, float]`, `latest_overview(storyline_id) -> dict | None`, `episode_cards_for(storyline_id) -> list[dict]`, `insert_card(...) -> str`.
  - `EpisodeEngine(store, models, cfg, storyline_resolver)` with `process_entry(entry: dict, vec: np.ndarray) -> dict` (attach decision record) and `close_due(t: datetime) -> list[dict]` (closed episodes). `storyline_resolver` is a callable `(entry, vec) -> (storyline_id | None, method, similarity, reason, model)` — Task 7 provides the real one.
  - `AttachDecision` dict shape: `{entry_id, episode_id, method, similarity, matched_entry_id, threshold, is_syndicated}`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/fakes.py
"""In-memory Store fake mirroring Store's read/write surface for engine unit tests."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from pipeline.vectors import pack_fp16, unpack_fp16


class FakeStore:
    def __init__(self) -> None:
        self.entries: dict[str, dict] = {}
        self.episodes: dict[str, dict] = {}
        self.storylines: dict[str, dict] = {}
        self.attaches: list[dict] = []
        self.cards: list[dict] = []

    # -- writes --------------------------------------------------------
    def create_episode(self, storyline_id, method, similarity, reason, model, t):
        if storyline_id is None:
            storyline_id = str(uuid.uuid4())
            self.storylines[storyline_id] = {
                "id": storyline_id, "entity_set": [], "event_keys": [],
                "centroid": None, "episode_count": 0, "newest_entry_at": t,
            }
        episode_id = str(uuid.uuid4())
        self.episodes[episode_id] = {
            "id": episode_id, "storyline_id": storyline_id, "status": "open",
            "centroid": None, "entity_set": [], "event_keys": [],
            "entry_count": 0, "first_entry_at": t, "newest_entry_at": t,
            "attach_method": method,
        }
        self.storylines[storyline_id]["episode_count"] += 1
        return episode_id, storyline_id

    def attach_entry(self, entry_id, episode_id, agency, is_syndicated, method,
                     similarity, matched_entry_id, threshold, embedding_model,
                     episode_centroid, published_at):
        self.attaches.append({"entry_id": entry_id, "episode_id": episode_id,
                              "method": method, "similarity": similarity,
                              "is_syndicated": is_syndicated})
        ep = self.episodes[episode_id]
        entry = self.entries[entry_id]
        ep["entry_count"] += 1
        ep["newest_entry_at"] = max(ep["newest_entry_at"], published_at)
        ep["centroid"] = episode_centroid
        ep["entity_set"] = sorted(set(ep["entity_set"]) | set(entry["entity_set"]))
        ep["event_keys"] = sorted(set(ep["event_keys"]) | set(entry["event_keys"]))
        entry["episode_id"] = episode_id
        story = self.storylines[ep["storyline_id"]]
        story["entity_set"] = sorted(set(story["entity_set"]) | set(entry["entity_set"]))
        story["event_keys"] = sorted(set(story["event_keys"]) | set(entry["event_keys"]))
        story["newest_entry_at"] = max(story["newest_entry_at"], published_at)

    def close_episode(self, episode_id):
        ep = self.episodes[episode_id]
        was_open = ep["status"] == "open"
        ep["status"] = "dormant"
        return was_open

    # -- reads ---------------------------------------------------------
    def content_hash_dup(self, hash_, t, window_hours):
        for e in self.entries.values():
            if (e.get("episode_id") and e["content_hash"] == hash_
                    and e["published_at"] > t - timedelta(hours=window_hours)):
                return {"id": e["id"], "episode_id": e["episode_id"]}
        return None

    def recent_embedded(self, t, window_hours):
        return [
            {"id": e["id"], "episode_id": e["episode_id"],
             "embedding": unpack_fp16(e["embedding"])}
            for e in self.entries.values()
            if e.get("episode_id") and e.get("embedding") is not None
            and e["published_at"] > t - timedelta(hours=window_hours)
        ]

    def open_episodes(self):
        return [dict(e, centroid=unpack_fp16(e["centroid"]) if e["centroid"] else None)
                for e in self.episodes.values() if e["status"] == "open"]

    # -- test helpers ----------------------------------------------------
    def add_entry(self, **kw: Any) -> dict:
        vec = kw.pop("vec", None)
        entry = {
            "id": str(uuid.uuid4()), "episode_id": None, "embedding": None,
            "entity_set": [], "event_keys": [], "agency": "x.gov",
            "news_source_id": "src", **kw,
        }
        if vec is not None:
            entry["embedding"] = pack_fp16(vec)
        self.entries[entry["id"]] = entry
        return entry
```

```python
# tests/test_episodes.py
from datetime import datetime, timedelta, timezone

import numpy as np

from pipeline.config import Config
from pipeline.episodes import EpisodeEngine
from tests.fakes import FakeStore

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


def new_storyline_resolver(entry, vec):
    return None, "new_storyline", None, None, None


class SayNoModels:
    def adjudicate_same_event(self, a, b, context):
        return False, "no"


class SayYesModels:
    def adjudicate_same_event(self, a, b, context):
        return True, "yes"


def make_engine(store, models=None):
    return EpisodeEngine(store, models or SayNoModels(), CFG, new_storyline_resolver)


def vec(seed_axis: int) -> np.ndarray:
    v = np.zeros(8, dtype=np.float32)
    v[seed_axis] = 1.0
    return v


def test_first_entry_creates_episode_and_storyline():
    store = FakeStore()
    engine = make_engine(store)
    e = store.add_entry(title="FDA recalls Valsatrex", content_hash="h1",
                        published_at=T0, entity_set=["valsatrex"], event_keys=[])
    decision = engine.process_entry(e, vec(0))
    assert decision["method"] == "new_cluster"
    assert len(store.episodes) == 1 and len(store.storylines) == 1


def test_content_hash_dup_folds_as_syndicated():
    store = FakeStore()
    engine = make_engine(store)
    a = store.add_entry(title="t", content_hash="same", published_at=T0,
                        entity_set=["valsatrex"], event_keys=[])
    engine.process_entry(a, vec(0))
    b = store.add_entry(title="t copy", content_hash="same",
                        published_at=T0 + timedelta(hours=1),
                        entity_set=["valsatrex"], event_keys=[])
    decision = engine.process_entry(b, vec(0))
    assert decision["method"] == "content_hash"
    assert decision["is_syndicated"] is True
    assert len(store.episodes) == 1


def test_near_dup_folds():
    store = FakeStore()
    engine = make_engine(store)
    # vec= stores the embedding on the entry (the runner's update_entry_features
    # does this in production), so recent_embedded() can serve the near-dup tier
    a = store.add_entry(title="t", content_hash="h1", published_at=T0,
                        entity_set=["valsatrex"], event_keys=[], vec=vec(0))
    engine.process_entry(a, vec(0))
    b = store.add_entry(title="t2", content_hash="h2",
                        published_at=T0 + timedelta(hours=2),
                        entity_set=["valsatrex"], event_keys=[])
    decision = engine.process_entry(b, vec(0))  # identical vector -> cosine 1.0
    assert decision["method"] == "near_dup"
    assert len(store.episodes) == 1


def test_event_key_joins_open_episode():
    store = FakeStore()
    engine = make_engine(store)
    a = store.add_entry(title="EPA docket opens", content_hash="h1", published_at=T0,
                        entity_set=[], event_keys=["epa-hq-2026-0001"])
    engine.process_entry(a, vec(1))
    b = store.add_entry(title="Comment period", content_hash="h2",
                        published_at=T0 + timedelta(hours=3),
                        entity_set=[], event_keys=["epa-hq-2026-0001"])
    decision = engine.process_entry(b, vec(2))  # dissimilar vector; key still wins
    assert decision["method"] == "event_key"
    assert len(store.episodes) == 1


def test_template_twin_splits_via_entity_gate_and_adjudicator():
    store = FakeStore()
    engine = make_engine(store, SayNoModels())
    a = store.add_entry(title="FDA recalls Valsatrex", content_hash="h1", published_at=T0,
                        entity_set=["valsatrex"], event_keys=[])
    engine.process_entry(a, vec(0))
    twin_vec = vec(0) * 0.9 + vec(1) * 0.1  # above join threshold, below near-dup
    twin_vec /= np.linalg.norm(twin_vec)
    b = store.add_entry(title="FDA recalls Oxprenol", content_hash="h2",
                        published_at=T0 + timedelta(hours=1),
                        entity_set=["oxprenol"], event_keys=[])
    decision = engine.process_entry(b, twin_vec)
    assert decision["method"] == "adjudicated_new"
    assert len(store.episodes) == 2


def test_entity_overlap_auto_joins_without_adjudicator():
    store = FakeStore()
    engine = make_engine(store, SayNoModels())  # adjudicator would say no; must not be asked
    a = store.add_entry(title="FDA recalls Valsatrex", content_hash="h1", published_at=T0,
                        entity_set=["valsatrex"], event_keys=[])
    engine.process_entry(a, vec(0))
    joiner = vec(0) * 0.9 + vec(1) * 0.1
    joiner /= np.linalg.norm(joiner)
    b = store.add_entry(title="Valsatrex recall expands", content_hash="h2",
                        published_at=T0 + timedelta(hours=1),
                        entity_set=["valsatrex", "sundexo"], event_keys=[])
    decision = engine.process_entry(b, joiner)
    assert decision["method"] == "centroid_join"
    assert len(store.episodes) == 1


def test_dormancy_close_in_event_time():
    store = FakeStore()
    engine = make_engine(store)
    a = store.add_entry(title="t", content_hash="h1", published_at=T0,
                        entity_set=["valsatrex"], event_keys=[])
    engine.process_entry(a, vec(0))
    assert engine.close_due(T0 + timedelta(hours=3)) == []
    closed = engine.close_due(T0 + timedelta(hours=5))
    assert len(closed) == 1
    assert store.episodes[closed[0]["id"]]["status"] == "dormant"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_episodes.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.episodes'`.

- [ ] **Step 3: Implement**

```python
# pipeline/store.py
from __future__ import annotations

from datetime import datetime
from typing import Any

from pipeline.db import Db
from pipeline.vectors import unpack_fp16


class Store:
    """All SQL reads + RPC writes behind one seam. Tests use tests/fakes.FakeStore."""

    def __init__(self, db: Db) -> None:
        self.db = db

    # -- writes (RPCs) -------------------------------------------------
    def upsert_news_source(self, canonical_url: str, source_type: str, title: str | None) -> str:
        return self.db.rpc("upsert_news_source", p_canonical_url=canonical_url,
                           p_source_type=source_type, p_title=title)

    def ingest_entry(self, source_id: str, url: str, url_canonical: str, title: str | None,
                     summary: str | None, published_at: datetime, hash_: str,
                     entities: list[str], keys: list[str], extractor_version: int) -> str | None:
        return self.db.rpc("ingest_news_entry", p_news_source_id=source_id, p_url=url,
                           p_url_canonical=url_canonical, p_title=title, p_summary=summary,
                           p_published_at=published_at, p_content_hash=hash_,
                           p_entity_set=entities, p_event_keys=keys,
                           p_extractor_version=extractor_version)

    def update_entry_features(self, entry_id: str, enriched_text: str | None,
                              enricher_version: int | None, embedding: bytes | None,
                              embedding_model: str | None) -> None:
        self.db.rpc("update_entry_features", p_entry_id=entry_id, p_enriched_text=enriched_text,
                    p_enricher_version=enricher_version, p_embedding=embedding,
                    p_embedding_model=embedding_model)

    def create_episode(self, storyline_id: str | None, method: str, similarity: float | None,
                       reason: str | None, model: str | None, t: datetime) -> tuple[str, str]:
        row = self.db.rpc_row("create_episode_with_storyline", p_storyline_id=storyline_id,
                              p_attach_method=method, p_attach_similarity=similarity,
                              p_attach_reason=reason, p_adjudicator_model=model, p_event_time=t)
        return str(row["episode_id"]), str(row["storyline_id"])

    def attach_entry(self, entry_id: str, episode_id: str, agency: str, is_syndicated: bool,
                     method: str, similarity: float | None, matched_entry_id: str | None,
                     threshold: float | None, embedding_model: str | None,
                     episode_centroid: bytes | None, published_at: datetime) -> None:
        self.db.rpc("attach_entry_to_episode", p_entry_id=entry_id, p_episode_id=episode_id,
                    p_agency=agency, p_is_syndicated=is_syndicated, p_attach_method=method,
                    p_similarity=similarity, p_matched_entry_id=matched_entry_id,
                    p_threshold_used=threshold, p_embedding_model=embedding_model,
                    p_episode_centroid=episode_centroid, p_published_at=published_at)

    def close_episode(self, episode_id: str) -> bool:
        return bool(self.db.rpc("close_episode", p_episode_id=episode_id))

    def insert_card(self, storyline_id: str, episode_id: str | None, kind: str, headline: str,
                    summary: str, timeline: list | None, rubric: dict | None,
                    rubric_version: int | None, interest_reason: str | None,
                    representative_entry_id: str | None, judge_model: str | None,
                    prompt_version: int | None, overview_embedding: bytes | None,
                    tau: float) -> str:
        return self.db.rpc(
            "insert_event_card", p_storyline_id=storyline_id, p_episode_id=episode_id,
            p_kind=kind, p_headline=headline, p_summary=summary,
            p_timeline=self.db.jsonb(timeline) if timeline is not None else None,
            p_rubric=self.db.jsonb(rubric) if rubric is not None else None,
            p_rubric_version=rubric_version, p_interest_reason=interest_reason,
            p_representative_entry_id=representative_entry_id, p_judge_model=judge_model,
            p_prompt_version=prompt_version, p_overview_embedding=overview_embedding,
            p_tau=tau)

    # -- reads ----------------------------------------------------------
    def unprocessed_entries(self, batch: int = 500) -> list[dict]:
        return self.db.all(
            """
            select ne.id, ne.news_source_id, ne.url, ne.url_canonical, ne.title, ne.summary,
                   ne.published_at, ne.content_hash, ne.entity_set, ne.event_keys,
                   ne.enriched_text, ne.enricher_version, ne.embedding,
                   split_part(ns.canonical_url, '/', 3) as agency
            from public.news_entries ne
            join public.news_sources ns on ns.id = ne.news_source_id
            where ne.episode_id is null and ne.published_at is not null
            order by ne.published_at, ne.id
            limit %(batch)s
            """,
            {"batch": batch},
        )

    def content_hash_dup(self, hash_: str, t: datetime, window_hours: float) -> dict | None:
        return self.db.one(
            """
            select id, episode_id from public.news_entries
            where content_hash = %(h)s and episode_id is not null
              and published_at > %(t)s - make_interval(hours => %(w)s)
            order by published_at desc limit 1
            """,
            {"h": hash_, "t": t, "w": window_hours},
        )

    def recent_embedded(self, t: datetime, window_hours: float) -> list[dict]:
        rows = self.db.all(
            """
            select id, episode_id, embedding from public.news_entries
            where episode_id is not null and embedding is not null
              and published_at > %(t)s - make_interval(hours => %(w)s)
              and published_at <= %(t)s
            """,
            {"t": t, "w": window_hours},
        )
        return [dict(r, embedding=unpack_fp16(r["embedding"])) for r in rows]

    def open_episodes(self) -> list[dict]:
        rows = self.db.all(
            """
            select id, storyline_id, status, centroid, entity_set, event_keys,
                   entry_count, first_entry_at, newest_entry_at
            from public.episodes where status = 'open'
            """
        )
        return [dict(r, centroid=unpack_fp16(r["centroid"]) if r["centroid"] else None)
                for r in rows]

    def episode_members(self, episode_id: str) -> list[dict]:
        return self.db.all(
            """
            select ne.id, ne.title, ne.summary, ne.published_at, ee.is_syndicated
            from public.episode_entries ee
            join public.news_entries ne on ne.id = ee.entry_id
            where ee.episode_id = %(e)s
            order by ne.published_at
            """,
            {"e": episode_id},
        )

    def storylines_by_event_keys(self, keys: list[str]) -> list[dict]:
        if not keys:
            return []
        return self._storyline_rows("s.event_keys && %(keys)s::text[]", {"keys": keys})

    def storylines_by_entities(self, entities: list[str]) -> list[dict]:
        if not entities:
            return []
        return self._storyline_rows("s.entity_set && %(ents)s::text[]", {"ents": entities})

    def _storyline_rows(self, where: str, params: dict) -> list[dict]:
        rows = self.db.all(
            f"""
            select s.id, s.entity_set, s.event_keys, s.centroid, s.episode_count,
                   s.newest_entry_at, s.latest_card_id
            from public.storylines s
            where s.merged_into is null and {where}
            """,
            params,
        )
        return [dict(r, centroid=unpack_fp16(r["centroid"]) if r["centroid"] else None)
                for r in rows]

    def entity_emas(self, entities: list[str]) -> dict[str, float]:
        if not entities:
            return {}
        rows = self.db.all(
            "select entity, daily_ema from public.entity_stats where entity = any(%(e)s)",
            {"e": entities},
        )
        return {r["entity"]: float(r["daily_ema"]) for r in rows}

    def latest_overview(self, storyline_id: str) -> dict | None:
        return self.db.one(
            """
            select c.id, c.headline, c.summary from public.event_cards c
            join public.storylines s on s.latest_card_id = c.id
            where s.id = %(s)s
            """,
            {"s": storyline_id},
        )

    def episode_cards_for(self, storyline_id: str) -> list[dict]:
        return self.db.all(
            """
            select c.episode_id, c.headline, c.summary,
                   to_char(c.newest_entry_at, 'YYYY-MM-DD') as date
            from public.event_cards c
            where c.storyline_id = %(s)s and c.kind = 'episode'
            order by c.newest_entry_at
            """,
            {"s": storyline_id},
        )
```

```python
# pipeline/episodes.py
"""Stage 1 — episode formation (v1 pipeline, event-time windows).

Tier order per entry: content-hash dedupe -> near-dup -> event-key ->
centroid nominate + entity gate + adjudicator -> new episode (storyline
attach delegated to the resolver). Split-biased everywhere.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Callable, Protocol

import numpy as np

from pipeline.config import Config
from pipeline.vectors import cosine, pack_fp16, running_mean


class ModelClient(Protocol):
    def adjudicate_same_event(self, a: dict, b: dict, context: str) -> tuple[bool, str]: ...


StorylineResolver = Callable[[dict, np.ndarray], tuple[str | None, str, float | None, str | None, str | None]]


class EpisodeEngine:
    def __init__(self, store, models: ModelClient, cfg: Config,
                 storyline_resolver: StorylineResolver) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg
        self.resolve_storyline = storyline_resolver
        self._open: list[dict] | None = None  # lazy cache of open episodes

    # -- open-episode cache --------------------------------------------
    def _open_episodes(self) -> list[dict]:
        if self._open is None:
            self._open = self.store.open_episodes()
        return self._open

    def _refresh_episode(self, episode_id: str, entry: dict, vec: np.ndarray,
                         published_at: datetime) -> None:
        for ep in self._open_episodes():
            if str(ep["id"]) == str(episode_id):
                ep["centroid"] = running_mean(ep.get("centroid"), ep["entry_count"], vec)
                ep["entry_count"] += 1
                ep["newest_entry_at"] = max(ep["newest_entry_at"], published_at)
                ep["entity_set"] = sorted(set(ep["entity_set"]) | set(entry["entity_set"]))
                ep["event_keys"] = sorted(set(ep["event_keys"]) | set(entry["event_keys"]))
                return

    def _attach(self, entry: dict, episode: dict, method: str, similarity: float | None,
                matched_entry_id: str | None, threshold: float | None,
                vec: np.ndarray, is_syndicated: bool) -> dict:
        new_centroid = running_mean(episode.get("centroid"), episode["entry_count"], vec)
        self.store.attach_entry(
            entry["id"], str(episode["id"]), entry["agency"], is_syndicated, method,
            similarity, matched_entry_id, threshold, self.cfg.embedding_model,
            pack_fp16(new_centroid), entry["published_at"])
        self._refresh_episode(str(episode["id"]), entry, vec, entry["published_at"])
        return {"entry_id": entry["id"], "episode_id": str(episode["id"]), "method": method,
                "similarity": similarity, "matched_entry_id": matched_entry_id,
                "threshold": threshold, "is_syndicated": is_syndicated}

    def _episode_by_id(self, episode_id: str) -> dict:
        for ep in self._open_episodes():
            if str(ep["id"]) == str(episode_id):
                return ep
        # dup matched a since-closed episode within the dedupe window: attach anyway
        return {"id": episode_id, "entry_count": 0, "centroid": None,
                "entity_set": [], "event_keys": [], "newest_entry_at": None,
                "first_entry_at": None, "storyline_id": None}

    # -- main entry point ------------------------------------------------
    def process_entry(self, entry: dict, vec: np.ndarray) -> dict:
        t = entry["published_at"]

        # tier 1: verbatim syndication (72 h, decoupled from dormancy)
        dup = self.store.content_hash_dup(entry["content_hash"], t, self.cfg.dedupe_window_hours)
        if dup and str(dup["id"]) != str(entry["id"]):
            episode = self._episode_by_id(str(dup["episode_id"]))
            return self._attach(entry, episode, "content_hash", None, str(dup["id"]), None, vec, True)

        # tier 2: fuzzy near-dup vs recent embedded entries
        best_sim, best_row = 0.0, None
        for row in self.store.recent_embedded(t, self.cfg.dedupe_window_hours):
            if str(row["id"]) == str(entry["id"]):
                continue
            sim = cosine(vec, row["embedding"])
            if sim > best_sim:
                best_sim, best_row = sim, row
        if best_row is not None and best_sim >= self.cfg.near_dup_threshold:
            episode = self._episode_by_id(str(best_row["episode_id"]))
            return self._attach(entry, episode, "near_dup", best_sim, str(best_row["id"]),
                                self.cfg.near_dup_threshold, vec, True)

        # tier 3: hard event keys against open episodes
        if entry["event_keys"]:
            for ep in self._open_episodes():
                if set(entry["event_keys"]) & set(ep["event_keys"]):
                    return self._attach(entry, ep, "event_key", None, None, None, vec, False)

        # tier 4: centroid nominates, entities gate, adjudicator arbitrates
        candidate, cand_sim = None, 0.0
        for ep in self._open_episodes():
            if ep.get("centroid") is None:
                continue
            sim = cosine(vec, ep["centroid"])
            if sim >= self.cfg.cluster_join_threshold and sim > cand_sim:
                candidate, cand_sim = ep, sim
        if candidate is not None:
            entry_entities, ep_entities = set(entry["entity_set"]), set(candidate["entity_set"])
            if entry_entities & ep_entities:
                return self._attach(entry, candidate, "centroid_join", cand_sim, None,
                                    self.cfg.cluster_join_threshold, vec, False)
            same, reason = self.models.adjudicate_same_event(
                {"title": entry["title"], "summary": entry.get("summary"),
                 "entities": sorted(entry_entities)},
                {"title": "(episode)", "summary": " / ".join(sorted(ep_entities)) or "(no entities)",
                 "entities": sorted(ep_entities)},
                context="Decide if the new item belongs to this in-progress episode.")
            if same:
                return self._attach(entry, candidate, "adjudicated_join", cand_sim, None,
                                    self.cfg.cluster_join_threshold, vec, False)
            method = "adjudicated_new"
        else:
            method = "new_cluster"

        # tier 5: new episode; resolver decides the storyline
        storyline_id, s_method, s_sim, s_reason, s_model = self.resolve_storyline(entry, vec)
        episode_id, storyline_id = self.store.create_episode(
            storyline_id, s_method, s_sim, s_reason, s_model, t)
        episode = {"id": episode_id, "storyline_id": storyline_id, "status": "open",
                   "centroid": None, "entity_set": [], "event_keys": [],
                   "entry_count": 0, "first_entry_at": t, "newest_entry_at": t}
        self._open_episodes().append(episode)
        return self._attach(entry, episode, method, None, None, None, vec, False)

    # -- dormancy ---------------------------------------------------------
    def close_due(self, t: datetime) -> list[dict]:
        closed: list[dict] = []
        cutoff = t - timedelta(hours=self.cfg.episode_dormancy_hours)
        for ep in list(self._open_episodes()):
            if ep["newest_entry_at"] is not None and ep["newest_entry_at"] < cutoff:
                if self.store.close_episode(str(ep["id"])):
                    ep["status"] = "dormant"
                    closed.append(ep)
                self._open_episodes().remove(ep)
        return closed
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_episodes.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline/store.py pipeline/episodes.py tests/fakes.py tests/test_episodes.py
git commit -m "feat: add store seam and event-time episode formation engine

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Storyline attachment + card generation engines

Stage 2 (entity-anchored, time-unbounded chain attach) and Stage 3 (episode cards at close, overview compression with cited timeline, rank_key at birth).

**Files:**
- Create: `pipeline/storylines.py`, `pipeline/cards.py`
- Test: `tests/test_storylines.py`, `tests/test_cards.py`

**Interfaces:**
- Consumes: `Store` reads (`storylines_by_event_keys`, `storylines_by_entities`, `entity_emas`, `latest_overview`, `episode_cards_for`, `episode_members`, `insert_card`), `ModelClient`, `Config`, `validate_timeline`.
- Produces:
  - `StorylineEngine(store, models, cfg)` with `resolve(entry: dict, vec: np.ndarray) -> tuple[str | None, str, float | None, str | None, str | None]` — exactly the `storyline_resolver` signature Task 6 consumes: `(storyline_id, attach_method, similarity, reason, adjudicator_model)`.
  - `CardEngine(store, models, cfg)` with `on_episode_closed(episode: dict) -> None` — writes the immutable episode card, then regenerates the storyline overview when `episode_count >= 2` (single-episode collapse otherwise; design amendment 7).
- Tier order in `resolve`: shared `event_keys` → auto (`event_key`); entity candidates ranked by EMA-down-weighted overlap `sum(1 / (1 + daily_ema))`; strong candidates (≥ 2 shared entities AND cosine vs storyline centroid ≥ `cluster_join_threshold`) → auto (`entity_candidate`); remaining candidates with cosine ≥ `storyline_sim_floor` → adjudicated against the latest overview card with the dormancy gap in the prompt (`adjudicated_join`); nothing survives → `new_storyline`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_storylines.py
from datetime import datetime, timezone

import numpy as np

from pipeline.config import Config
from pipeline.storylines import StorylineEngine

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


class StorylineFakeStore:
    """Read-only storyline surface used by StorylineEngine.resolve."""

    def __init__(self, storylines, emas=None, overview=None):
        self._storylines = storylines
        self._emas = emas or {}
        self._overview = overview

    def storylines_by_event_keys(self, keys):
        return [s for s in self._storylines if set(s["event_keys"]) & set(keys)]

    def storylines_by_entities(self, entities):
        return [s for s in self._storylines if set(s["entity_set"]) & set(entities)]

    def entity_emas(self, entities):
        return {e: self._emas.get(e, 0.0) for e in entities}

    def latest_overview(self, storyline_id):
        return self._overview


class SayYes:
    def adjudicate_same_event(self, a, b, context):
        return True, "same chain"


class SayNo:
    def adjudicate_same_event(self, a, b, context):
        return False, "different"


def entry(**kw):
    return {"id": "n1", "title": "Valsatrex recall expands", "summary": "s",
            "entity_set": ["valsatrex", "sundexo"], "event_keys": [],
            "published_at": T0, **kw}


def unit(axis):
    v = np.zeros(8, dtype=np.float32)
    v[axis] = 1.0
    return v


def storyline(**kw):
    return {"id": "s1", "entity_set": ["valsatrex"], "event_keys": [],
            "centroid": unit(0), "episode_count": 2, "newest_entry_at": T0,
            "latest_card_id": "c1", **kw}


def test_event_key_tier_wins_without_llm():
    store = StorylineFakeStore([storyline(event_keys=["z-2026-0143"])])
    engine = StorylineEngine(store, SayNo(), CFG)
    sid, method, _, _, _ = engine.resolve(entry(event_keys=["z-2026-0143"]), unit(3))
    assert sid == "s1" and method == "event_key"


def test_strong_entity_candidate_auto_joins():
    store = StorylineFakeStore([storyline(entity_set=["valsatrex", "sundexo"])])
    engine = StorylineEngine(store, SayNo(), CFG)  # adjudicator must not be consulted
    sid, method, sim, _, _ = engine.resolve(entry(), unit(0))
    assert sid == "s1" and method == "entity_candidate"
    assert sim is not None and sim >= CFG.cluster_join_threshold


def test_weak_candidate_adjudicated_against_overview():
    store = StorylineFakeStore(
        [storyline()],
        overview={"id": "c1", "headline": "Valsatrex recall", "summary": "FDA recall ongoing."},
    )
    mixed = unit(0) * 0.7 + unit(1) * 0.3
    mixed /= np.linalg.norm(mixed)
    sid, method, _, reason, _ = StorylineEngine(store, SayYes(), CFG).resolve(entry(), mixed)
    assert sid == "s1" and method == "adjudicated_join" and reason == "same chain"
    sid, method, _, _, _ = StorylineEngine(store, SayNo(), CFG).resolve(entry(), mixed)
    assert sid is None and method == "new_storyline"


def test_ambient_entities_downweighted():
    # 'washington' is ambient (high EMA); a storyline sharing only it must rank
    # below one sharing the rare entity, and alone must not out-candidate it.
    rare = storyline(id="rare", entity_set=["valsatrex"])
    ambient = storyline(id="ambient", entity_set=["washington"], centroid=unit(0))
    store = StorylineFakeStore([ambient, rare], emas={"washington": 50.0, "valsatrex": 0.2})
    engine = StorylineEngine(store, SayNo(), CFG)
    e = entry(entity_set=["valsatrex", "washington", "sundexo"])
    ranked = engine._rank_candidates(e, [ambient, rare])
    assert ranked[0]["id"] == "rare"


def test_no_candidates_new_storyline():
    engine = StorylineEngine(StorylineFakeStore([]), SayNo(), CFG)
    sid, method, _, _, _ = engine.resolve(entry(), unit(0))
    assert sid is None and method == "new_storyline"
```

```python
# tests/test_cards.py
from datetime import datetime, timezone

from pipeline.cards import CardEngine
from pipeline.config import Config
from pipeline.stub import StubModels

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


class CardFakeStore:
    def __init__(self, episode_count=1):
        self.cards = []
        self.episode_count = episode_count

    def episode_members(self, episode_id):
        return [{"id": "n1", "title": "FDA recalls Valsatrex", "summary": "Contamination.",
                 "published_at": T0, "is_syndicated": False}]

    def episode_cards_for(self, storyline_id):
        return [{"episode_id": "e1", "headline": "FDA recalls Valsatrex",
                 "summary": "Contamination.", "date": "2026-05-14"}]

    def storyline_episode_count(self, storyline_id):
        return self.episode_count

    def insert_card(self, **kw):
        self.cards.append(kw)
        return f"card-{len(self.cards)}"


def episode():
    return {"id": "e1", "storyline_id": "s1", "entity_set": ["valsatrex"],
            "newest_entry_at": T0, "first_entry_at": T0, "entry_count": 1}


def test_episode_card_written_at_close_single_episode_no_overview():
    store = CardFakeStore(episode_count=1)
    CardEngine(store, StubModels(), CFG).on_episode_closed(episode())
    kinds = [c["kind"] for c in store.cards]
    assert kinds == ["episode"]  # single-episode collapse: no overview call


def test_overview_regenerated_on_multi_episode_storyline():
    store = CardFakeStore(episode_count=2)
    CardEngine(store, StubModels(), CFG).on_episode_closed(episode())
    kinds = [c["kind"] for c in store.cards]
    assert kinds == ["episode", "overview"]
    overview = store.cards[1]
    assert overview["timeline"][0]["episode_id"] == "e1"  # cited bullets survive validation
    assert overview["overview_embedding"] is not None      # design amendment 3
    assert set(overview["rubric"].keys()) >= {"urgency", "novelty"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_storylines.py tests/test_cards.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# pipeline/storylines.py
"""Stage 2 — storyline attachment: entity-anchored candidates over unbounded
time, adjudicated against the chain's own latest overview. Split-biased."""

from __future__ import annotations

import numpy as np

from pipeline.config import Config
from pipeline.vectors import cosine

_TOP_K = 3


class StorylineEngine:
    def __init__(self, store, models, cfg: Config) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg

    def _rank_candidates(self, entry: dict, candidates: list[dict]) -> list[dict]:
        emas = self.store.entity_emas(entry["entity_set"])
        scored = []
        for cand in candidates:
            shared = set(entry["entity_set"]) & set(cand["entity_set"])
            score = sum(1.0 / (1.0 + emas.get(e, 0.0)) for e in shared)
            scored.append((score, len(shared), cand))
        scored.sort(key=lambda x: (-x[0], -x[1], str(x[2]["id"])))
        return [c for _, _, c in scored]

    def resolve(self, entry: dict, vec: np.ndarray
                ) -> tuple[str | None, str, float | None, str | None, str | None]:
        # tier 1: hard event keys — deterministic chain identity
        for cand in self.store.storylines_by_event_keys(entry["event_keys"]):
            return str(cand["id"]), "event_key", None, None, None

        # tier 2/3: entity candidates via GIN, EMA-down-weighted
        candidates = self._rank_candidates(
            entry, self.store.storylines_by_entities(entry["entity_set"]))
        for cand in candidates[:_TOP_K]:
            sim = cosine(vec, cand["centroid"]) if cand.get("centroid") is not None else 0.0
            shared = set(entry["entity_set"]) & set(cand["entity_set"])

            # strong deterministic join: multiple shared discriminators + tight embedding
            if len(shared) >= 2 and sim >= self.cfg.cluster_join_threshold:
                return str(cand["id"]), "entity_candidate", sim, None, None

            if sim < self.cfg.storyline_sim_floor:
                continue

            overview = self.store.latest_overview(str(cand["id"]))
            gap_days = (entry["published_at"] - cand["newest_entry_at"]).days
            context = (
                f"The storyline's current overview: "
                f"{(overview or {}).get('headline', '(none)')} — "
                f"{(overview or {}).get('summary', '(no overview yet)')} "
                f"Last activity {gap_days} days before the new item. "
                "Is the new item a development of this same historical event chain?"
            )
            same, reason = self.models.adjudicate_same_event(
                {"title": entry["title"], "summary": entry.get("summary"),
                 "entities": entry["entity_set"]},
                {"title": (overview or {}).get("headline", "(storyline)"),
                 "summary": (overview or {}).get("summary", ""),
                 "entities": sorted(cand["entity_set"])[:32]},
                context=context)
            if same:
                return (str(cand["id"]), "adjudicated_join", sim, reason,
                        self.cfg.adjudicator_model)

        return None, "new_storyline", None, None, None
```

```python
# pipeline/cards.py
"""Stage 3 — cards. Episode card once at close (immutable); overview
compression + rubric in one call, cited timeline validated, rank_key at birth
(inside the insert_event_card RPC)."""

from __future__ import annotations

from pipeline.config import Config
from pipeline.prompts import validate_timeline
from pipeline.vectors import pack_fp16


class CardEngine:
    def __init__(self, store, models, cfg: Config) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg

    def on_episode_closed(self, episode: dict) -> None:
        members = self.store.episode_members(str(episode["id"]))
        originals = [m for m in members if not m["is_syndicated"]] or members
        representative = originals[0]
        syndicated_count = sum(1 for m in members if m["is_syndicated"])
        summary = (representative.get("summary") or representative["title"]).strip()
        if syndicated_count:
            summary += f" (+{syndicated_count} republications)"

        self.store.insert_card(
            storyline_id=str(episode["storyline_id"]), episode_id=str(episode["id"]),
            kind="episode", headline=representative["title"], summary=summary,
            timeline=None, rubric=None, rubric_version=None, interest_reason=None,
            representative_entry_id=str(representative["id"]),
            judge_model=None, prompt_version=self.cfg.prompt_version,
            overview_embedding=None, tau=self.cfg.tau_seconds)

        # single-episode collapse: only compress once a second episode exists
        if self.store.storyline_episode_count(str(episode["storyline_id"])) < 2:
            return
        self._regenerate_overview(str(episode["storyline_id"]),
                                  representative_entry_id=str(representative["id"]))

    def _regenerate_overview(self, storyline_id: str, representative_entry_id: str) -> None:
        episode_cards = self.store.episode_cards_for(storyline_id)
        card = self.models.compress_overview({"id": storyline_id}, episode_cards)
        valid_ids = {str(c["episode_id"]) for c in episode_cards}
        timeline = validate_timeline(card.get("timeline", []), valid_ids)
        overview_vec = self.models.embed([card["summary"]])[0]

        self.store.insert_card(
            storyline_id=storyline_id, episode_id=None, kind="overview",
            headline=card["headline"], summary=card["summary"], timeline=timeline,
            rubric=card["rubric"], rubric_version=self.cfg.rubric_version,
            interest_reason=card.get("reason"),
            representative_entry_id=representative_entry_id,
            judge_model=self.cfg.judge_model, prompt_version=self.cfg.prompt_version,
            overview_embedding=pack_fp16(overview_vec), tau=self.cfg.tau_seconds)
```

Add to `pipeline/store.py` (Store class, reads section):

```python
    def storyline_episode_count(self, storyline_id: str) -> int:
        row = self.db.one("select episode_count from public.storylines where id = %(s)s",
                          {"s": storyline_id})
        return int(row["episode_count"]) if row else 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_storylines.py tests/test_cards.py -v`
Expected: PASS (7 tests). Full suite: `uv run pytest` — all green.

- [ ] **Step 5: Commit**

```bash
git add pipeline/storylines.py pipeline/cards.py pipeline/store.py tests/test_storylines.py tests/test_cards.py
git commit -m "feat: add storyline attachment and card generation engines

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Seed loader, event-time runner, CLI, integration smoke test

Wires everything: `seed` loads scraped JSONL through the ingest RPC; `run` drains unprocessed entries in event-time order (enrich → embed → episode engine → dormancy closes → cards). Integration test replays a synthetic corpus with stub models against local Supabase and asserts the cluster structure.

**Files:**
- Create: `pipeline/seed.py`, `pipeline/runner.py`, `pipeline/cli.py`, `tests/fixtures/smoke.jsonl`
- Test: `tests/test_seed.py`, `tests/test_integration_smoke.py`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `load_jsonl(store, path, extractor_version) -> dict` returning `{"loaded": int, "skipped_duplicates": int, "errors": int}`.
  - `Runner(store, models, cfg)` with `.run(batch: int = 500) -> dict` returning `{"processed": int, "episodes_closed": int}`; `.finalize() -> dict` closes all remaining open episodes and generates their cards (end-of-corpus flush for eval runs).
  - CLI: `uv run python -m pipeline.cli seed <path.jsonl>`, `uv run python -m pipeline.cli run [--stub] [--finalize]`, `uv run python -m pipeline.cli eval` (Task 9 fills in `eval`). `--stub` swaps `WorkersAI` for `StubModels` (dry runs, CI).

- [ ] **Step 1: Write the failing unit test for the loader**

```python
# tests/test_seed.py
import json
from datetime import datetime, timezone

from pipeline.seed import load_jsonl


class SeedFakeStore:
    def __init__(self):
        self.sources: dict[str, str] = {}
        self.entries: list[dict] = []
        self.seen_canonical: set[str] = set()

    def upsert_news_source(self, canonical_url, source_type, title):
        return self.sources.setdefault(canonical_url, f"src-{len(self.sources)}")

    def ingest_entry(self, source_id, url, url_canonical, title, summary,
                     published_at, hash_, entities, keys, extractor_version):
        if url_canonical in self.seen_canonical:
            return None
        self.seen_canonical.add(url_canonical)
        self.entries.append({"url_canonical": url_canonical, "entities": entities,
                             "keys": keys, "published_at": published_at})
        return f"entry-{len(self.entries)}"


def test_loader_canonicalizes_extracts_and_dedupes(tmp_path):
    rows = [
        {"url": "https://fda.gov/a?utm_source=x", "title": "FDA Recalls Valsatrex",
         "summary": "Sundexo Pharmaceuticals recall.", "published_at": "2026-05-14T14:30:00Z",
         "source_url": "https://fda.gov/feed.xml", "source_type": "rss", "agency": "fda.gov"},
        {"url": "https://fda.gov/a", "title": "dup", "summary": "dup",
         "published_at": "2026-05-14T15:00:00Z",
         "source_url": "https://fda.gov/feed.xml", "source_type": "rss"},
        {"url": "not a url and missing fields"},
    ]
    path = tmp_path / "seed.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in rows))

    store = SeedFakeStore()
    report = load_jsonl(store, str(path), extractor_version=1)

    assert report == {"loaded": 1, "skipped_duplicates": 1, "errors": 1}
    entry = store.entries[0]
    assert entry["url_canonical"] == "https://fda.gov/a"
    assert "valsatrex" in entry["entities"]
    assert entry["published_at"] == datetime(2026, 5, 14, 14, 30, tzinfo=timezone.utc)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_seed.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement loader, runner, CLI**

```python
# pipeline/seed.py
from __future__ import annotations

import json
from datetime import datetime

from pipeline.extraction import extract
from pipeline.normalize import canonicalize_url, content_hash

_REQUIRED = ("url", "title", "published_at", "source_url", "source_type")


def load_jsonl(store, path: str, extractor_version: int) -> dict:
    loaded = skipped = errors = 0
    source_ids: dict[str, str] = {}

    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                for key in _REQUIRED:
                    if not row.get(key):
                        raise ValueError(f"missing {key}")
                published_at = datetime.fromisoformat(row["published_at"].replace("Z", "+00:00"))
                source_key = canonicalize_url(row["source_url"])
                if source_key not in source_ids:
                    source_ids[source_key] = store.upsert_news_source(
                        source_key, row["source_type"], row.get("agency"))
                entities, keys = extract(row["title"], row.get("summary"))
                entry_id = store.ingest_entry(
                    source_ids[source_key], row["url"], canonicalize_url(row["url"]),
                    row["title"], row.get("summary"), published_at,
                    content_hash(row["title"], row.get("summary")),
                    entities, keys, extractor_version)
                if entry_id is None:
                    skipped += 1
                else:
                    loaded += 1
            except Exception:
                errors += 1

    return {"loaded": loaded, "skipped_duplicates": skipped, "errors": errors}
```

```python
# pipeline/runner.py
"""Event-time drain: entries in published_at order; dormancy closes fire
against the advancing event clock, cards generate at close."""

from __future__ import annotations

from pipeline.cards import CardEngine
from pipeline.config import Config
from pipeline.episodes import EpisodeEngine
from pipeline.storylines import StorylineEngine
from pipeline.vectors import pack_fp16


class Runner:
    def __init__(self, store, models, cfg: Config) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg
        self.storyline_engine = StorylineEngine(store, models, cfg)
        self.card_engine = CardEngine(store, models, cfg)
        self.episode_engine = EpisodeEngine(store, models, cfg, self.storyline_engine.resolve)

    def _prepare(self, entry: dict):
        """Enrich (idempotent via stored enriched_text) + embed. Returns vector."""
        text = entry.get("enriched_text")
        if text is None and self.cfg.enrichment_enabled:
            text = self.models.enrich(entry["title"], entry.get("summary"))
        if text is None:
            text = f"{entry['title']}. {entry.get('summary') or ''}".strip()
        vec = self.models.embed([text])[0]
        self.store.update_entry_features(
            entry["id"],
            text if self.cfg.enrichment_enabled else None,
            self.cfg.enricher_version if self.cfg.enrichment_enabled else None,
            pack_fp16(vec), self.cfg.embedding_model)
        return vec

    def run(self, batch: int = 500) -> dict:
        processed = episodes_closed = 0
        while True:
            entries = self.store.unprocessed_entries(batch)
            if not entries:
                break
            for entry in entries:
                for closed in self.episode_engine.close_due(entry["published_at"]):
                    self.card_engine.on_episode_closed(closed)
                    episodes_closed += 1
                vec = self._prepare(entry)
                self.episode_engine.process_entry(entry, vec)
                processed += 1
        return {"processed": processed, "episodes_closed": episodes_closed}

    def finalize(self) -> dict:
        """End-of-corpus flush: close every remaining open episode and card it."""
        closed = 0
        for episode in list(self.episode_engine._open_episodes()):
            if self.store.close_episode(str(episode["id"])):
                self.card_engine.on_episode_closed(episode)
                closed += 1
        self.episode_engine._open = []
        return {"episodes_closed": closed}
```

```python
# pipeline/cli.py
from __future__ import annotations

import argparse
import json

from pipeline.ai import WorkersAI
from pipeline.config import load_config
from pipeline.db import Db
from pipeline.extraction import EXTRACTOR_VERSION
from pipeline.seed import load_jsonl
from pipeline.store import Store
from pipeline.stub import StubModels


def main() -> None:
    parser = argparse.ArgumentParser(prog="pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    seed_parser = sub.add_parser("seed", help="load scraped JSONL into news_entries")
    seed_parser.add_argument("path")

    run_parser = sub.add_parser("run", help="process unclustered entries in event time")
    run_parser.add_argument("--stub", action="store_true", help="use deterministic stub models")
    run_parser.add_argument("--finalize", action="store_true",
                            help="close all open episodes at end (eval runs)")
    run_parser.add_argument("--batch", type=int, default=500)

    eval_parser = sub.add_parser("eval", help="clustering evaluation report")
    eval_parser.add_argument("--out", default="docs/eval")
    eval_parser.add_argument("--sample", type=int, default=0,
                             help="also export N borderline pairs for labeling")
    eval_parser.add_argument("--labels", default=None,
                             help="score against a labeled pairs CSV")

    args = parser.parse_args()
    cfg = load_config()
    store = Store(Db(cfg.database_url))

    if args.command == "seed":
        print(json.dumps(load_jsonl(store, args.path, EXTRACTOR_VERSION)))
    elif args.command == "run":
        from pipeline.runner import Runner
        models = StubModels() if args.stub else WorkersAI(cfg)
        runner = Runner(store, models, cfg)
        report = runner.run(batch=args.batch)
        if args.finalize:
            report |= runner.finalize()
        print(json.dumps(report, default=str))
    elif args.command == "eval":
        from pipeline.evaluate import run_eval
        print(run_eval(store, cfg, out_dir=args.out, sample=args.sample,
                       labels_path=args.labels))


if __name__ == "__main__":
    main()
```

(Leave `pipeline/evaluate.py` unimported until Task 9 — the `eval` branch import is local, so `seed`/`run` work now.)

- [ ] **Step 4: Run the loader unit test**

Run: `uv run pytest tests/test_seed.py -v`
Expected: PASS.

- [ ] **Step 5: Write the integration smoke fixture and test**

Write `tests/fixtures/smoke.jsonl` with exactly these 12 lines (the fixture file itself contains no comment lines — JSONL only):

```jsonl
{"url": "https://fda.gov/press/valsatrex-recall", "title": "FDA Announces Recall of Valsatrex", "summary": "Sundexo Pharmaceuticals recalled Valsatrex lots after contamination. Recall number Z-2026-0143.", "published_at": "2026-05-14T14:00:00Z", "source_url": "https://fda.gov/press.xml", "source_type": "rss", "agency": "fda.gov"}
{"url": "https://hhs.gov/news/valsatrex", "title": "HHS Statement on Valsatrex Recall", "summary": "Sundexo Pharmaceuticals recalled Valsatrex lots after contamination. Recall number Z-2026-0143.", "published_at": "2026-05-14T16:00:00Z", "source_url": "https://hhs.gov/news.xml", "source_type": "rss", "agency": "hhs.gov"}
{"url": "https://cdc.gov/media/valsatrex-advisory", "title": "CDC Advisory on Valsatrex Contamination", "summary": "Patients taking Valsatrex from Sundexo Pharmaceuticals should consult providers.", "published_at": "2026-05-14T17:00:00Z", "source_url": "https://cdc.gov/media.xml", "source_type": "rss", "agency": "cdc.gov"}
{"url": "https://fda.gov/press/oxprenol-recall", "title": "FDA Announces Recall of Oxprenol", "summary": "Bexley Labs recalled Oxprenol tablets after labeling errors. Recall number Z-2026-0177.", "published_at": "2026-05-14T18:00:00Z", "source_url": "https://fda.gov/press.xml", "source_type": "rss", "agency": "fda.gov"}
{"url": "https://fda.gov/press/valsatrex-recall-expanded", "title": "FDA Expands Valsatrex Recall Nationwide", "summary": "Sundexo Pharmaceuticals expanded the Valsatrex recall to all lots. Recall number Z-2026-0143.", "published_at": "2026-05-17T15:00:00Z", "source_url": "https://fda.gov/press.xml", "source_type": "rss", "agency": "fda.gov"}
{"url": "https://hhs.gov/news/valsatrex-expanded", "title": "HHS on Expanded Valsatrex Recall", "summary": "Sundexo Pharmaceuticals expanded the Valsatrex recall to all lots. Recall number Z-2026-0143.", "published_at": "2026-05-17T16:30:00Z", "source_url": "https://hhs.gov/news.xml", "source_type": "rss", "agency": "hhs.gov"}
{"url": "https://epa.gov/newsreleases/emissions-rule", "title": "EPA Proposes Power Plant Emissions Rule", "summary": "Comments accepted under docket EPA-HQ-OAR-2026-0143.", "published_at": "2026-05-15T12:00:00Z", "source_url": "https://epa.gov/news.xml", "source_type": "rss", "agency": "epa.gov"}
{"url": "https://epa.gov/newsreleases/emissions-rule-hearing", "title": "EPA Schedules Hearing on Emissions Rule", "summary": "Public hearing announced for docket EPA-HQ-OAR-2026-0143.", "published_at": "2026-05-20T12:00:00Z", "source_url": "https://epa.gov/news.xml", "source_type": "rss", "agency": "epa.gov"}
{"url": "https://ssa.gov/news/cola-2027", "title": "SSA Announces 2027 Cost of Living Adjustment", "summary": "Benefits will increase 2.6 percent for Zylera beneficiaries program.", "published_at": "2026-05-16T09:00:00Z", "source_url": "https://ssa.gov/news.xml", "source_type": "rss", "agency": "ssa.gov"}
{"url": "https://fda.gov/press/valsatrex-recall-mirror", "title": "FDA Announces Recall of Valsatrex", "summary": "Sundexo Pharmaceuticals recalled Valsatrex lots after contamination. Recall number Z-2026-0143.", "published_at": "2026-05-14T20:00:00Z", "source_url": "https://mirror.gov/feed.xml", "source_type": "rss", "agency": "mirror.gov"}
{"url": "https://doj.gov/opa/pr/sundexo-settlement", "title": "Justice Department Reaches Settlement with Sundexo Pharmaceuticals", "summary": "Sundexo Pharmaceuticals settles claims over Valsatrex contamination disclosures.", "published_at": "2026-06-20T14:00:00Z", "source_url": "https://doj.gov/opa.xml", "source_type": "rss", "agency": "doj.gov"}
{"url": "https://ssa.gov/news/field-office", "title": "SSA Opens New Field Office in Tulsa", "summary": "The Tulsa office expands services for Oklahoma residents.", "published_at": "2026-05-18T09:00:00Z", "source_url": "https://ssa.gov/news.xml", "source_type": "rss", "agency": "ssa.gov"}
```

```python
# tests/test_integration_smoke.py
"""End-to-end replay against local Supabase with stub models.

Requires: pnpm supabase start && pnpm supabase db reset (migrations applied).
Run: uv run pytest -m integration
"""

import os
import pathlib

import pytest

from pipeline.config import Config
from pipeline.db import Db
from pipeline.extraction import EXTRACTOR_VERSION
from pipeline.runner import Runner
from pipeline.seed import load_jsonl
from pipeline.store import Store
from pipeline.stub import StubModels

pytestmark = pytest.mark.integration

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "smoke.jsonl"
DSN = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres")


@pytest.fixture()
def store():
    db = Db(DSN)
    # isolated replay: clear clustering tables (order respects FKs)
    for table in ("event_cards", "episode_entries", "news_entries", "episodes",
                  "storylines", "entity_stats"):
        db.conn.execute(
            f"truncate public.{table} cascade" if table != "news_entries"
            else "delete from public.news_entries")
    yield Store(db)


def test_smoke_corpus_clusters_correctly(store):
    cfg = Config(database_url=DSN, cf_account_id="x", cf_api_token="x",
                 enrichment_enabled=False)
    report = load_jsonl(store, str(FIXTURE), EXTRACTOR_VERSION)
    assert report["errors"] == 0 and report["loaded"] == 12

    runner = Runner(store, StubModels(), cfg)
    result = runner.run()
    assert result["processed"] == 12
    runner.finalize()

    db = store.db

    # verbatim mirror folded as syndicated content_hash dup
    row = db.one("""
        select count(*) as n from public.episode_entries
        where attach_method = 'content_hash' and is_syndicated
    """)
    assert row["n"] == 1

    # template twins (Valsatrex vs Oxprenol, same day) are in different storylines
    twins = db.all("""
        select distinct ep.storyline_id from public.episode_entries ee
        join public.news_entries ne on ne.id = ee.entry_id
        join public.episodes ep on ep.id = ee.episode_id
        where ne.title ilike '%recall%' and (ne.title ilike '%valsatrex%' or ne.title ilike '%oxprenol%')
    """)
    assert len(twins) == 2

    # day-3 recall expansion joined the original storyline (event_key/entity tier),
    # as a second episode
    valsatrex = db.one("""
        select s.id, s.episode_count from public.storylines s
        where 'z-2026-0143' = any(s.event_keys)
    """)
    assert valsatrex is not None and valsatrex["episode_count"] >= 2

    # multi-episode storyline has an overview card with cited timeline
    overview = db.one("""
        select c.timeline from public.event_cards c
        where c.storyline_id = %(s)s and c.kind = 'overview' and c.superseded_by is null
    """, {"s": valsatrex["id"]})
    assert overview is not None and len(overview["timeline"]) >= 2

    # every processed entry carries full audit evidence
    audit = db.one("""
        select count(*) as n from public.episode_entries where attach_method is null
    """)
    assert audit["n"] == 0
```

- [ ] **Step 6: Run integration test**

Run: `pnpm supabase db reset && uv run pytest -m integration -v`
Expected: PASS (1 test). Iterate on stub-model thresholds if the hashed bag-of-words cosine lands differently than assumed — thresholds are `Config` overrides, and the fixture texts share enough tokens that near-dup/template-twin behavior is robust.

- [ ] **Step 7: Commit**

```bash
git add pipeline/seed.py pipeline/runner.py pipeline/cli.py tests/test_seed.py tests/test_integration_smoke.py tests/fixtures/smoke.jsonl
git commit -m "feat: add seed loader, event-time runner, cli, and integration smoke test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Evaluation harness

Turns the audit trail into the verdict on the clustering hypothesis: health metrics from plain SQL, threshold calibration from free exact-dup labels (design amendment 5), a borderline-pair labeling loop, and pairwise P/R/F1 + B-Cubed once labels exist.

**Files:**
- Create: `pipeline/evaluate.py`
- Test: `tests/test_evaluate.py`

**Interfaces:**
- Consumes: `Store.db` (raw SQL), `Config`, embeddings via `unpack_fp16`.
- Produces:
  - `run_eval(store, cfg, out_dir, sample=0, labels_path=None) -> str` — writes `<out_dir>/clustering-eval.md` (+ `borderline-sample.csv` when `sample > 0`), returns the report path. Wired to `pipeline.cli eval` (Task 8).
  - Pure metric helpers (unit-testable without a DB): `pairwise_scores(pairs: list[tuple[str, str, bool]], cluster_of: dict[str, str]) -> dict` returning `{precision, recall, f1}`; `bcubed(cluster_of: dict[str, str], gold_of: dict[str, str]) -> dict` returning `{precision, recall, f1}`; `percentiles(values: list[float]) -> dict` (`p5/p25/p50/p75/p95`).
  - Labels CSV contract (hand-filled after `--sample`): columns `entry_a,entry_b,same_event` where `same_event` is `y`/`n`. Same file feeds `--labels`.
- Report sections (all real SQL, listed here as the contract):
  1. **Volume**: entries, episodes, storylines, cards; entries/day span.
  2. **Attach-method mix**: counts per `episode_entries.attach_method` and per `episodes.attach_method` — sudden shifts = threshold drift.
  3. **Similarity distributions**: percentiles of `similarity` per attach method; mass piling just above a threshold means it is doing real work.
  4. **Dedupe health**: syndication rate; `content_hash`-pair cosine percentiles → suggested `NEAR_DUP_THRESHOLD` = p5 of known-same-pair cosines minus 0.02.
  5. **Episode shape**: singleton-episode rate (too high → join threshold too strict; too low → over-merging); entries-per-episode histogram.
  6. **Storyline shape**: episodes-per-storyline histogram (the chain-reconstruction hypothesis lives here — count of ≥2-episode chains); top-10 longest chains with overview headlines and per-episode dates for eyeballing.
  7. **Adjudicator log**: every `adjudicated_join`/`adjudicated_new` decision with reason — 100% review at MVP volume per spec.
  8. **Label scores** (when `--labels` given): pairwise P/R/F1 at episode level and storyline level, B-Cubed over labeled entries.

- [ ] **Step 1: Write the failing tests (pure metric helpers)**

```python
# tests/test_evaluate.py
from pipeline.evaluate import bcubed, pairwise_scores, percentiles


def test_pairwise_scores():
    cluster_of = {"a": "c1", "b": "c1", "c": "c2"}
    pairs = [("a", "b", True), ("a", "c", False), ("b", "c", True)]
    scores = pairwise_scores(pairs, cluster_of)
    # predicted same: (a,b) -> TP; predicted diff: (a,c) -> TN, (b,c) -> FN
    assert scores["precision"] == 1.0
    assert scores["recall"] == 0.5
    assert 0 < scores["f1"] < 1


def test_pairwise_handles_empty():
    assert pairwise_scores([], {})["f1"] == 0.0


def test_bcubed_perfect():
    cluster_of = {"a": "c1", "b": "c1", "c": "c2"}
    gold_of = {"a": "g1", "b": "g1", "c": "g2"}
    scores = bcubed(cluster_of, gold_of)
    assert scores == {"precision": 1.0, "recall": 1.0, "f1": 1.0}


def test_bcubed_overmerge_hits_precision():
    cluster_of = {"a": "c1", "b": "c1", "c": "c1"}
    gold_of = {"a": "g1", "b": "g1", "c": "g2"}
    scores = bcubed(cluster_of, gold_of)
    assert scores["recall"] == 1.0
    assert scores["precision"] < 1.0


def test_percentiles():
    p = percentiles([float(i) for i in range(1, 101)])
    assert p["p50"] == 50.5
    assert p["p5"] < p["p95"]
    assert percentiles([]) == {}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_evaluate.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# pipeline/evaluate.py
"""Clustering evaluation: SQL health metrics + calibration + label scoring.

The audit trail (attach_method, similarity, threshold_used on every junction
row) makes all of this plain queries — no instrumentation after the fact.
"""

from __future__ import annotations

import csv
import os
import random
from itertools import combinations

import numpy as np

from pipeline.config import Config
from pipeline.vectors import cosine, unpack_fp16


# -- pure metric helpers ---------------------------------------------------

def percentiles(values: list[float]) -> dict:
    if not values:
        return {}
    arr = np.asarray(values, dtype=np.float64)
    return {f"p{q}": round(float(np.percentile(arr, q)), 4) for q in (5, 25, 50, 75, 95)}


def pairwise_scores(pairs: list[tuple[str, str, bool]], cluster_of: dict[str, str]) -> dict:
    tp = fp = fn = 0
    for a, b, gold_same in pairs:
        if a not in cluster_of or b not in cluster_of:
            continue
        predicted_same = cluster_of[a] == cluster_of[b]
        if predicted_same and gold_same:
            tp += 1
        elif predicted_same and not gold_same:
            fp += 1
        elif not predicted_same and gold_same:
            fn += 1
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4)}


def bcubed(cluster_of: dict[str, str], gold_of: dict[str, str]) -> dict:
    items = [i for i in cluster_of if i in gold_of]
    if not items:
        return {}
    p_sum = r_sum = 0.0
    for i in items:
        same_cluster = [j for j in items if cluster_of[j] == cluster_of[i]]
        same_gold = [j for j in items if gold_of[j] == gold_of[i]]
        correct = len([j for j in same_cluster if gold_of[j] == gold_of[i]])
        p_sum += correct / len(same_cluster)
        r_sum += correct / len(same_gold)
    precision, recall = p_sum / len(items), r_sum / len(items)
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4)}


# -- report ------------------------------------------------------------------

def run_eval(store, cfg: Config, out_dir: str, sample: int = 0,
             labels_path: str | None = None) -> str:
    db = store.db
    os.makedirs(out_dir, exist_ok=True)
    lines: list[str] = ["# Clustering Evaluation Report", ""]

    # 1. volume
    volume = db.one("""
        select (select count(*) from public.news_entries) as entries,
               (select count(*) from public.episodes) as episodes,
               (select count(*) from public.storylines) as storylines,
               (select count(*) from public.event_cards) as cards,
               (select min(published_at) from public.news_entries) as first,
               (select max(published_at) from public.news_entries) as last
    """)
    lines += ["## Volume", "",
              f"- entries: {volume['entries']} ({volume['first']} → {volume['last']})",
              f"- episodes: {volume['episodes']}  storylines: {volume['storylines']}  cards: {volume['cards']}", ""]

    # 2. attach-method mix
    lines += ["## Attach-method mix (entry → episode)", ""]
    for row in db.all("""
        select attach_method, count(*) as n, round(avg(similarity)::numeric, 3) as avg_sim
        from public.episode_entries group by 1 order by n desc
    """):
        lines.append(f"- {row['attach_method']}: {row['n']} (avg sim {row['avg_sim']})")
    lines += ["", "## Attach-method mix (episode → storyline)", ""]
    for row in db.all("""
        select attach_method, count(*) as n from public.episodes group by 1 order by n desc
    """):
        lines.append(f"- {row['attach_method']}: {row['n']}")

    # 3. similarity distributions per method
    lines += ["", "## Similarity distributions", ""]
    for row in db.all("""
        select attach_method, array_agg(similarity) as sims
        from public.episode_entries where similarity is not null group by 1
    """):
        lines.append(f"- {row['attach_method']}: {percentiles([float(s) for s in row['sims']])}")

    # 4. dedupe health + threshold calibration from free labels
    dup_pairs = db.all("""
        select a.embedding as ea, b.embedding as eb
        from public.episode_entries ee
        join public.news_entries a on a.id = ee.entry_id
        join public.news_entries b on b.id = ee.matched_entry_id
        where ee.attach_method = 'content_hash'
          and a.embedding is not null and b.embedding is not null
    """)
    dup_cosines = [cosine(unpack_fp16(r["ea"]), unpack_fp16(r["eb"])) for r in dup_pairs]
    lines += ["", "## Dedupe health / threshold calibration", "",
              f"- known-same (content_hash) pairs with embeddings: {len(dup_cosines)}",
              f"- cosine percentiles: {percentiles(dup_cosines)}"]
    if dup_cosines:
        suggested = round(float(np.percentile(dup_cosines, 5)) - 0.02, 3)
        lines.append(f"- suggested NEAR_DUP_THRESHOLD: {suggested} "
                     f"(current {cfg.near_dup_threshold})")

    # 5. episode shape
    singleton = db.one("""
        select round(avg((entry_count = 1)::int)::numeric, 3) as rate,
               count(*) as n from public.episodes
    """)
    lines += ["", "## Episode shape", "",
              f"- singleton-episode rate: {singleton['rate']} of {singleton['n']}"]
    for row in db.all("""
        select least(entry_count, 10) as bucket, count(*) as n
        from public.episodes group by 1 order by 1
    """):
        lines.append(f"- {row['bucket']}{'+' if row['bucket'] == 10 else ''} entries: {row['n']}")

    # 6. storyline shape — the chain-reconstruction hypothesis
    chains = db.one("""
        select count(*) filter (where episode_count >= 2) as multi,
               count(*) as total from public.storylines where merged_into is null
    """)
    lines += ["", "## Storyline shape", "",
              f"- multi-episode chains: {chains['multi']} / {chains['total']}"]
    lines += ["", "### Top 10 longest chains", ""]
    for row in db.all("""
        select s.id, s.episode_count, c.headline
        from public.storylines s
        left join public.event_cards c on c.id = s.latest_card_id
        where s.merged_into is null
        order by s.episode_count desc, s.entry_count desc limit 10
    """):
        lines.append(f"- [{row['episode_count']} episodes] {row['headline'] or '(no card)'} ({row['id']})")

    # 7. adjudicator log (100% review at MVP volume)
    lines += ["", "## Adjudicated storyline decisions", ""]
    for row in db.all("""
        select attach_method, attach_similarity, attach_reason
        from public.episodes
        where attach_method in ('adjudicated_join') or attach_reason is not null
        order by created_at
    """):
        lines.append(f"- {row['attach_method']} (sim {row['attach_similarity']}): {row['attach_reason']}")

    # 8. optional: borderline sample export for human labels
    if sample > 0:
        sample_path = os.path.join(out_dir, "borderline-sample.csv")
        rows = db.all("""
            select ee.entry_id, ee.matched_entry_id, ee.attach_method, ee.similarity,
                   ee.threshold_used, ne.title
            from public.episode_entries ee
            join public.news_entries ne on ne.id = ee.entry_id
            where ee.similarity is not null and ee.threshold_used is not null
              and abs(ee.similarity - ee.threshold_used) < 0.03
        """)
        random.Random(42).shuffle(rows)
        with open(sample_path, "w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["entry_a", "entry_b", "attach_method", "similarity", "title", "same_event"])
            for row in rows[:sample]:
                writer.writerow([row["entry_id"], row["matched_entry_id"] or "",
                                 row["attach_method"], row["similarity"], row["title"], ""])
        lines += ["", f"Borderline sample for labeling: {sample_path} "
                      f"({min(sample, len(rows))} pairs; fill same_event with y/n)"]

    # 9. optional: score against human labels
    if labels_path:
        pairs: list[tuple[str, str, bool]] = []
        with open(labels_path, newline="") as handle:
            for row in csv.DictReader(handle):
                if row.get("same_event", "").strip().lower() in ("y", "n"):
                    pairs.append((row["entry_a"], row["entry_b"],
                                  row["same_event"].strip().lower() == "y"))
        episode_of = {str(r["id"]): str(r["episode_id"]) for r in db.all(
            "select id, episode_id from public.news_entries where episode_id is not null")}
        storyline_of = {str(r["id"]): str(r["storyline_id"]) for r in db.all("""
            select ne.id, ep.storyline_id from public.news_entries ne
            join public.episodes ep on ep.id = ne.episode_id
        """)}
        lines += ["", "## Label scores", "",
                  f"- labeled pairs: {len(pairs)}",
                  f"- episode-level pairwise: {pairwise_scores(pairs, episode_of)}",
                  f"- storyline-level pairwise: {pairwise_scores(pairs, storyline_of)}"]

    report_path = os.path.join(out_dir, "clustering-eval.md")
    with open(report_path, "w") as handle:
        handle.write("\n".join(lines) + "\n")
    return report_path
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_evaluate.py -v`
Expected: PASS (5 tests). Full unit suite green: `uv run pytest`.

- [ ] **Step 5: End-to-end sanity on the smoke corpus**

```bash
pnpm supabase db reset
uv run pytest -m integration -v          # loads + runs smoke corpus
uv run python -m pipeline.cli eval --out /tmp/eval-smoke
cat /tmp/eval-smoke/clustering-eval.md
```

Expected: report renders every section; "multi-episode chains" ≥ 1 (Valsatrex chain); attach-method mix shows `content_hash`, `event_key`/`centroid_join`, `new_cluster`.

- [ ] **Step 6: Commit**

```bash
git add pipeline/evaluate.py tests/test_evaluate.py
git commit -m "feat: add clustering evaluation harness with calibration and label scoring

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Running the real experiment (once the top-30 scrape lands)

```bash
pnpm supabase start && pnpm supabase db reset       # schema + RPCs
uv run python -m pipeline.cli seed scrape.jsonl      # load corpus (report: loaded/skipped/errors)
uv run python -m pipeline.cli run --finalize         # real Workers AI models, event-time replay
uv run python -m pipeline.cli eval --out docs/eval --sample 100
# label docs/eval/borderline-sample.csv, then:
uv run python -m pipeline.cli eval --out docs/eval --labels docs/eval/borderline-sample.csv
```

Suggested first experiments (each is a fresh `db reset` + seed + run with different env):
1. Baseline: defaults as-is.
2. `ENRICHMENT_ENABLED=false` — quantifies the Stage-0 enrichment hypothesis (v2 open item #1) by diffing attach mix, singleton rate, and label scores.
3. `NEAR_DUP_THRESHOLD`/`CLUSTER_JOIN_THRESHOLD` set from the calibration section of run 1 — thresholds are the report's own suggestion, closing spec open item "calibrate on real corpus".

## Deliberately out of scope (follow-up plans)

- Live TS ingest wiring (poller → `news_entries` with TS-side normalization + cross-language golden tests against `pipeline/normalize.py`).
- Cloudflare Container packaging of the Python worker + DO wake plumbing (engines are transport-free by design; only `cli.py`/`runner.py` entry points change).
- Nightly consolidation passes (episode merge/split, storyline merge, labeling, retries) — needs real-corpus eval results first to justify thresholds.
- Chroma hot/search collections — at eval scale, in-memory numpy + SQL windows suffice; Chroma matters for the always-on service.
- Serving layer (anon grants, feed API, SSE, OG fetch).
- `entity_community` attach method (graph-based entity communities) — vocabulary slot reserved by the data model; not exercised by this plan.
- Distillation of adjudicator decisions into a local classifier (the audit trail is already accumulating the training data).
