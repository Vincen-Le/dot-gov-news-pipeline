"""Two-phase runner.

prepare: per-entry features (enrich concurrent, embed batched, extraction
backfill) persisted once — the expensive, experiment-invariant half.
cluster (Task 4): event-time replay over cached features — the cheap half
experiments iterate on.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from pipeline.cards import CardEngine
from pipeline.config import Config
from pipeline.episodes import EpisodeEngine
from pipeline.extraction import EXTRACTOR_VERSION, extract
from pipeline.storylines import StorylineEngine
from pipeline.topics import ThemeEngine
from pipeline.vectors import pack_fp16, unpack_fp16
from pipeline.window import ReplayStore, ReplayWindow

# DB constraint news_entries_enriched_text_bounded caps enriched_text at this length.
_MAX_ENRICHED_LEN = 16384


def _fallback_text(row: dict) -> str:
    content = row.get("body_text") or row.get("summary") or ""
    return f"{row['title']}. {content}".strip()[:_MAX_ENRICHED_LEN]


def prepare(store, models, cfg: Config, limit: int | None = None,
            concurrency: int = 8, embed_batch: int = 96,
            per_agency: int | None = None,
            agencies: list[str] | None = None) -> dict:
    rows = store.entries_needing_features(
        limit, per_agency=per_agency, agencies=agencies)
    if not rows:
        return {"prepared": 0, "failed": 0}

    # enrichment (concurrent; DB column is the cache — skip rows that have it)
    def enrich_one(row: dict) -> str | None:
        if not cfg.enrichment_enabled or row.get("enriched_text"):
            return None
        try:
            content = row.get("body_text") or row.get("summary")
            return models.enrich(row["title"], content)[:_MAX_ENRICHED_LEN]
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
            content = row.get("body_text") or row.get("summary")
            entities, keys = extract(row["title"], content) if needs_anchors else (None, None)
            store.update_entry_features(
                row["id"],
                new_enrichment,
                cfg.enricher_version if new_enrichment else None,
                pack_fp16(vec), models.embedding_tag,
                entity_set=entities, event_keys=keys,
                extractor_version=EXTRACTOR_VERSION if needs_anchors else None)
            prepared += 1
    return {"prepared": prepared, "failed": failed}


def cluster(store, models, cfg: Config, limit: int | None = None,
            until: "datetime | None" = None,
            per_agency: int | None = None) -> dict:
    window = ReplayWindow(cfg.dedupe_window_hours)
    replay = store
    if hasattr(store, "db"):  # real Store -> wrap window reads; fakes serve their own
        replay = ReplayStore(store.db, window)
    else:
        replay = _WindowedFake(store, window)

    storyline_engine = StorylineEngine(replay, models, cfg)
    card_engine = CardEngine(replay, models, cfg)
    episode_engine = EpisodeEngine(replay, models, cfg, storyline_engine.resolve)
    theme_engine = ThemeEngine(replay, models, cfg) if cfg.topics_enabled else None

    rows = store.prepared_unclustered(limit=limit, until=until,
                                      per_agency=per_agency)
    processed = closed_count = 0
    for row in rows:
        t = row["published_at"]
        window.advance(t)
        # emulate ingest-time anchor touching in event time: bench corpora
        # arrive via direct sync, so EMAs would otherwise stay empty all run
        replay.touch_entities(
            list(row["entity_set"]) + list(row["event_keys"]), t)
        for closed in episode_engine.close_due(t):
            card_engine.on_episode_closed(closed)
            if theme_engine is not None:
                theme_engine.sync(str(closed["storyline_id"]))
            closed_count += 1
        vec = unpack_fp16(row["embedding"])
        decision = episode_engine.process_entry(row, vec)
        window.add(row["id"], decision["episode_id"], row["content_hash"], t, vec)
        processed += 1

    # finalize: close every remaining open episode so the run is complete/comparable
    for episode in list(episode_engine._open_episodes()):
        if replay.close_episode(str(episode["id"])):
            card_engine.on_episode_closed(episode)
            if theme_engine is not None:
                theme_engine.sync(str(episode["storyline_id"]))
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
