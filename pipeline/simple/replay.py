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

from pipeline.shared.cards import CardEngine
from pipeline.shared.categories import CategoryEngine
from pipeline.runner import _WindowedFake
from pipeline.shared.vectors import unpack_fp16
from pipeline.shared.window import ReplayStore, ReplayWindow
from pipeline.simple.storyline_linking import Linker, StorylineIndex
from pipeline.simple.theme_clustering import sweep


def _prime_index(db, index: StorylineIndex) -> int:
    """Restore live storylines into the in-memory index (anchored continue).

    After a reset this is a no-op; after a golden-anchored run it makes every
    existing storyline retrievable so new slices layer on top instead of
    re-clustering from nothing. Member order matches build order.
    """
    rows = db.all("""
        select e.storyline_id::text, ne.embedding, ne.entity_set,
               ne.published_at, s.episode_count
        from public.episode_entries ee
        join public.episodes e on e.id = ee.episode_id
        join public.storylines s on s.id = e.storyline_id
        join public.news_entries ne on ne.id = ee.entry_id
        where s.merged_into is null
        order by e.storyline_id, ne.published_at, ne.id
    """)
    by_story: dict[str, list[dict]] = {}
    for row in rows:
        by_story.setdefault(row["storyline_id"], []).append(row)
    for storyline_id, members in by_story.items():
        index.restore(
            storyline_id,
            member_vecs=[unpack_fp16(m["embedding"]) for m in members],
            entities={e for m in members for e in (m["entity_set"] or [])},
            newest_entry_at=max(m["published_at"] for m in members),
            episode_count=members[-1]["episode_count"])
    return len(by_story)


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
    primed = 0
    if hasattr(store, "db"):  # real Store; fakes replay from a clean slate
        primed = _prime_index(store.db, index)
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
    consecutive_judge_errors = 0
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
        # circuit breaker: the judge fallback is split-biased by design, so a
        # dead adjudicator silently shreds every chain (observed: 56 error
        # births in one run when a bad schema drew 403s). Persistent errors
        # mean the run is producing garbage — stop instead.
        if str(decision.get("reason") or "").startswith("adjudicator_error"):
            consecutive_judge_errors += 1
            if consecutive_judge_errors >= 10:
                raise RuntimeError(
                    "link judge failed 10 times in a row — aborting replay "
                    f"(last: {decision['reason'][:200]})")
        else:
            consecutive_judge_errors = 0
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

    # Categories assign in one concurrent end-of-run batch: linking never
    # depends on them, and pulling the LLM call out of the per-entry loop
    # roughly halves replay wall-clock. A second serial pass retries
    # transient failures (mirrors pipeline.runner.cluster()).
    category_engine.classify_many(replay.uncategorized_storyline_ids())
    for storyline_id in replay.uncategorized_storyline_ids():
        category_engine.classify(storyline_id, method="retry")

    if rows:
        _tally(sweep_totals, sweep(replay, models, cfg))
        sweep_runs += 1

    return {"engine": "spine", "processed": processed,
            "episodes_closed": closed_count, "storylines_primed": primed,
            "storylines_created": created, "attach_mix": attach_mix,
            "theme_sweeps": sweep_runs, "theme_sweep_totals": sweep_totals}
