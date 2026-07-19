"""Two-phase runner.

prepare: per-entry features (enrich concurrent, embed batched, extraction
backfill) persisted once — the expensive, experiment-invariant half.
cluster (Task 4): event-time replay over cached features — the cheap half
experiments iterate on.
"""

from __future__ import annotations

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from pipeline.categories import CategoryEngine
from pipeline.cards import CardEngine
from pipeline.config import Config
from pipeline.episodes import EpisodeEngine
from pipeline.extraction import EXTRACTOR_VERSION, extract
from pipeline.promotion import PromotionSweep
from pipeline.storylines import StorylineEngine
from pipeline.topics import ThemeEngine
from pipeline.vectors import pack_fp16, unpack_fp16
from pipeline.window import ReplayStore, ReplayWindow

# DB constraint news_entries_enriched_text_bounded caps enriched_text at this length.
_MAX_ENRICHED_LEN = 16384


def _semantic_content(row: dict) -> str | None:
    # summary first: it is a human-condensed description of the event, so
    # title+summary embeds nearer related events than full article body,
    # which drowns the signal in quotes and boilerplate
    return row.get("summary") or row.get("body_text")


def _fallback_text(row: dict) -> str:
    return f"{row['title']}. {_semantic_content(row) or ''}".strip()[:_MAX_ENRICHED_LEN]


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
            return models.enrich(row["title"], _semantic_content(row))[:_MAX_ENRICHED_LEN]
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
            entities, keys = (extract(row["title"], _semantic_content(row))
                              if needs_anchors else (None, None))
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
            per_agency: int | None = None,
            topology_label_set_id: str | None = None,
            multi_episode_percent: float | None = None,
            multi_entry_single_episode_percent: float = 0.0,
            topology_seed: str = "default") -> dict:
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
    category_engine = (CategoryEngine(replay, models, cfg)
                       if cfg.topics_enabled else None)
    promotion = (PromotionSweep(replay, models, cfg, theme_engine)
                 if cfg.topics_enabled else None)
    sweep_totals = {"mopped_up": 0, "promoted": 0,
                    "attached_existing": 0, "rejected": 0, "demoted": 0}
    sweep_runs = 0
    last_sweep_at = None

    rows = store.prepared_unclustered(limit=limit, until=until,
                                      per_agency=per_agency,
                                      topology_label_set_id=topology_label_set_id,
                                      multi_episode_percent=multi_episode_percent,
                                      multi_entry_single_episode_percent=(
                                          multi_entry_single_episode_percent),
                                      topology_seed=topology_seed)

    input_topology = None
    if topology_label_set_id is not None:
        expected_counts = Counter(
            row["expected_topology_class"] for row in rows)
        input_topology = {
            "label_set_id": topology_label_set_id,
            "seed": topology_seed,
            "requested_multi_episode_percent": multi_episode_percent,
            "requested_multi_entry_single_episode_percent": (
                multi_entry_single_episode_percent),
            "actual_entry_counts": dict(expected_counts),
            "actual_multi_entry_episode_entries": sum(
                bool(row["expected_multi_entry_episode"]) for row in rows),
        }
    processed = closed_count = 0
    for row in rows:
        t = row["published_at"]
        if last_sweep_at is None:
            last_sweep_at = t
        window.advance(t)
        # emulate ingest-time anchor touching in event time: bench corpora
        # arrive via direct sync, so EMAs would otherwise stay empty all run
        replay.touch_entities(
            list(row["entity_set"]) + list(row["event_keys"]), t)
        for closed in episode_engine.close_due(t):
            card_engine.on_episode_closed(closed)
            if theme_engine is not None:
                category_engine.classify(str(closed["storyline_id"]))
                theme_engine.sync(str(closed["storyline_id"]))
            closed_count += 1
        vec = unpack_fp16(row["embedding"])
        decision = episode_engine.process_entry(row, vec)
        window.add(row["id"], decision["episode_id"], row["content_hash"], t, vec)
        processed += 1
        if (promotion is not None and last_sweep_at is not None
                and t - last_sweep_at >= timedelta(
                    hours=cfg.theme_sweep_interval_hours)):
            for key, value in promotion.run(t).items():
                sweep_totals[key] += value
            sweep_runs += 1
            last_sweep_at = t

    # finalize: close every remaining open episode so the run is complete/comparable
    for episode in list(episode_engine._open_episodes()):
        if replay.close_episode(str(episode["id"])):
            card_engine.on_episode_closed(episode)
            if theme_engine is not None:
                category_engine.classify(str(episode["storyline_id"]))
                theme_engine.sync(str(episode["storyline_id"]))
            closed_count += 1
    episode_engine._open = []

    if theme_engine is not None:
        # Retry categories deferred by transient model failures, then run the
        # final promotion sweep so the run ends theme-complete/comparable.
        for storyline_id in replay.uncategorized_storyline_ids():
            category_engine.classify(storyline_id, method="retry")
        if rows:
            for key, value in promotion.run(rows[-1]["published_at"]).items():
                sweep_totals[key] += value
            sweep_runs += 1

    report = {"processed": processed, "episodes_closed": closed_count}
    if cfg.topics_enabled:
        report["theme_sweeps"] = sweep_runs
        report["theme_sweep_totals"] = sweep_totals
    if input_topology is not None:
        report["input_topology"] = input_topology
    return report


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
