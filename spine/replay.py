"""Spine engine event-time replay driver.

Mirrors pipeline.runner.cluster()'s shape: prime the dedupe window, replay
prepared rows in event-time order through the Linker (dup -> retrieve ->
judge -> act), close episodes as they go dormant, and finalize by closing
whatever is still open. CardEngine and the window-priming machinery are
reused verbatim from the classic engine (golden curation resumes depend on
ReplayWindow/ReplayStore behaving identically across engines).
"""

from __future__ import annotations

from datetime import timedelta

from pipeline.cards import CardEngine
from pipeline.categories import CategoryEngine
from pipeline.runner import _WindowedFake
from pipeline.vectors import unpack_fp16
from pipeline.window import ReplayStore, ReplayWindow
from spine.index import StorylineIndex
from spine.linker import Linker
from spine.themes import sweep


def _close(replay, card_engine: CardEngine, index: StorylineIndex, story) -> None:
    replay.close_episode(story.open_episode_id)
    card_engine.on_episode_closed(
        {"id": story.open_episode_id, "storyline_id": story.id})
    index.mark_closed(story.id)


def _tally(totals: dict, result: dict) -> None:
    for key, value in result.items():
        totals[key] += value


def run(store, models, cfg, limit=None, since=None, until=None,
        per_agency=None) -> dict:
    rows = store.prepared_unclustered(limit=limit, since=since, until=until,
                                      per_agency=per_agency)

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
        replay = ReplayStore(store.db, window)
    else:
        replay = _WindowedFake(store, window)

    index = StorylineIndex()
    card_engine = CardEngine(replay, models, cfg)
    if rows:
        # corpus dim (e.g. 1024 for real bge-m3 embeddings) guards
        # _regenerate_overview against writing a mismatched-dim vector into
        # storylines.centroid when models is a --stub run over a db seeded
        # with real embeddings.
        card_engine.corpus_dim = len(unpack_fp16(rows[0]["embedding"]))
    category_engine = CategoryEngine(replay, models, cfg)
    linker = Linker(replay, models, cfg, index, category_engine)

    attach_mix: dict[str, int] = {}
    processed = closed_count = created = 0
    last_sweep_at = None
    sweep_totals = {"themes_created": 0, "themes_kept": 0,
                    "themes_demoted": 0, "storylines_assigned": 0}
    sweep_runs = 0

    for row in rows:
        t = row["published_at"]
        if last_sweep_at is None:
            last_sweep_at = t
        window.advance(t)
        # emulate ingest-time anchor touching in event time: bench corpora
        # arrive via direct sync, so EMAs would otherwise stay empty all run
        replay.touch_entities(
            list(row["entity_set"]) + list(row["event_keys"]), t)
        for story in index.due_closes(t, cfg.spine_episode_gap_hours):
            _close(replay, card_engine, index, story)
            closed_count += 1
        vec = unpack_fp16(row["embedding"])
        decision = linker.process_entry(row, vec)
        replaced_episode_id = decision.get("replaced_episode_id")
        if replaced_episode_id is not None:
            # the judge opened a new episode on this storyline mid-window;
            # the episode it replaced never goes through due_closes (it was
            # still active), so it must be closed here or it lingers open
            # forever with no episode card and no overview regeneration.
            replay.close_episode(replaced_episode_id)
            card_engine.on_episode_closed(
                {"id": replaced_episode_id, "storyline_id": decision["storyline_id"]})
            closed_count += 1
        attach_mix[decision["method"]] = attach_mix.get(decision["method"], 0) + 1
        created += decision["method"].startswith("new_storyline")
        window.add(row["id"], decision["episode_id"], row["content_hash"], t, vec)
        processed += 1
        if t - last_sweep_at >= timedelta(
                hours=cfg.spine_theme_sweep_interval_hours):
            _tally(sweep_totals, sweep(replay, models, cfg))
            sweep_runs += 1
            last_sweep_at = t

    # finalize: close every remaining open episode so the run is complete/comparable
    for story in [s for s in index.all() if s.open_episode_id is not None]:
        _close(replay, card_engine, index, story)
        closed_count += 1

    # Retry categories deferred by transient model failures (mirrors
    # pipeline.runner.cluster()'s end-of-run retry loop), so uncategorized
    # counts stay comparable across engines.
    for storyline_id in replay.uncategorized_storyline_ids():
        category_engine.classify(storyline_id, method="retry")

    if rows:
        _tally(sweep_totals, sweep(replay, models, cfg))
        sweep_runs += 1

    return {"engine": "spine", "processed": processed,
            "episodes_closed": closed_count,
            "storylines_created": created, "attach_mix": attach_mix,
            "theme_sweeps": sweep_runs, "theme_sweep_totals": sweep_totals}
