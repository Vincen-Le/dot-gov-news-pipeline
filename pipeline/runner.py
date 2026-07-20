"""Event-time replay orchestration for the retained complex pipeline."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta

from pipeline.shared.categories import CategoryEngine
from pipeline.shared.cards import CardEngine
from pipeline.complex.episodes import EpisodeEngine
from pipeline.complex.promotion import PromotionSweep
from pipeline.complex.storylines import StorylineEngine
from pipeline.complex.topics import ThemeEngine
from pipeline.shared.config import Config
from pipeline.shared.vectors import unpack_fp16
from pipeline.shared.window import ReplayStore, ReplayWindow


def cluster(store, models, cfg: Config, limit: int | None = None,
            since: "datetime | None" = None,
            until: "datetime | None" = None,
            per_agency: int | None = None,
            topology_label_set_id: str | None = None,
            multi_episode_percent: float | None = None,
            multi_entry_single_episode_percent: float = 0.0,
            topology_seed: str = "default",
            golden_batch: int | None = None) -> dict:
    rows = store.prepared_unclustered(limit=limit, since=since, until=until,
                                      per_agency=per_agency,
                                      topology_label_set_id=topology_label_set_id,
                                      multi_episode_percent=multi_episode_percent,
                                      multi_entry_single_episode_percent=(
                                          multi_entry_single_episode_percent),
                                      topology_seed=topology_seed,
                                      golden_batch=golden_batch)
    window = ReplayWindow(cfg.dedupe_window_hours)
    replay = store
    if hasattr(store, "db"):  # real Store -> wrap window reads; fakes serve their own
        if rows:
            first = rows[0]
            for prior in store.clustered_window_before(
                    first["published_at"], str(first["id"]),
                    cfg.dedupe_window_hours):
                window.add(
                    str(prior["id"]), str(prior["episode_id"]),
                    prior["content_hash"], prior["published_at"],
                    prior["embedding"])
            window.advance(first["published_at"])
        replay = ReplayStore(
            store.db,
            window,
            source_run_id=store.source_run_id,
            publisher_weight_version=store.publisher_weight_version,
        )
    else:
        replay = _WindowedFake(store, window)

    storyline_engine = StorylineEngine(replay, models, cfg)
    card_engine = CardEngine(replay, models, cfg)
    if rows:
        # corpus dim (e.g. 1024 for real bge-m3 embeddings) guards
        # _regenerate_overview against writing a mismatched-dim vector into
        # storylines.centroid when models is a --stub run over a db seeded
        # with real embeddings.
        card_engine.corpus_dim = len(unpack_fp16(rows[0]["embedding"]))
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
    if golden_batch is not None:
        report["golden_batch"] = golden_batch
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
