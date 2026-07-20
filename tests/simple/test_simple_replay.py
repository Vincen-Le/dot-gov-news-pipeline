from datetime import datetime, timedelta, timezone

from pipeline.shared.categories import CategoryEngine
from pipeline.shared.config import Config
from pipeline.shared.stub import StubModels
from pipeline.shared.vectors import pack_fp16
from pipeline.simple.replay import run
from tests.fakes import FakeStore

CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             engine="spine")
T0 = datetime(2025, 7, 1, tzinfo=timezone.utc)


class SpineFakeStore(FakeStore):
    """FakeStore + the CardEngine read the spine driver needs beyond the
    Linker/CategoryEngine surface (mirrors ClusterFakeStore in
    tests/test_cluster_phase.py)."""

    def episode_cards_for(self, storyline_id):
        return [
            {"episode_id": c["episode_id"], "headline": c["headline"],
             "summary": c["summary"], "date": "2025-07-01"}
            for c in self.cards if c["kind"] == "episode"
            and c["storyline_id"] == storyline_id
        ]


def _entry(i, title, t):
    return {"id": f"entry-{i}", "title": title, "summary": f"{title} summary.",
            "enriched_text": None, "published_at": t, "content_hash": f"h{i}",
            "embedding": None, "entity_set": ["ftc"], "event_keys": [],
            "agency": "ftc"}


def test_replay_end_to_end_with_stub(monkeypatch):
    store = SpineFakeStore()
    stub = StubModels()
    entries = [
        _entry(1, "FTC sues Acme Corp over merger", T0),
        _entry(2, "FTC sues Acme Corp over merger update", T0 + timedelta(hours=3)),
        _entry(3, "NASA launches lunar probe mission", T0 + timedelta(hours=5)),
    ]
    for e in entries:  # pre-pack stub embeddings for the titles
        e["embedding"] = pack_fp16(stub.embed([e["title"]])[0])
    for e in entries:  # seed FakeStore.entries so episode_members has titles
        store.add_entry(**e)
    monkeypatch.setattr(store, "prepared_unclustered",
                        lambda **kw: entries, raising=False)
    report = run(store, stub, CFG)
    assert report["engine"] == "spine"
    assert report["processed"] == 3
    # 2 storylines: the FTC pair joined, NASA spun off
    assert report["storylines_created"] == 2
    assert report["episodes_closed"] == 2          # finalize closes both
    assert report["attach_mix"]["judge_same_dev"] == 1


class _AlwaysNewDevelopment:
    """Judge that reports a new development on the sole candidate regardless
    of gap — exercises the orphaned-open-episode fix in Linker.process_entry's
    judge_new_episode branch (the old episode must be closed, not left open
    forever, when the judge opens a new one mid-window)."""

    def __init__(self, inner) -> None:
        self._inner = inner

    def link_storyline(self, entry, candidates):
        return {"match": 0, "same_development": False, "reason": "new development"}

    def __getattr__(self, name):
        return getattr(self._inner, name)


def test_new_development_within_gap_closes_replaced_episode(monkeypatch):
    store = SpineFakeStore()
    stub = StubModels()
    model = _AlwaysNewDevelopment(stub)
    entries = [
        _entry(1, "FTC sues Acme Corp over merger", T0),
        _entry(2, "FTC sues Acme Corp over merger update", T0 + timedelta(hours=3)),
    ]
    for e in entries:
        e["embedding"] = pack_fp16(stub.embed([e["title"]])[0])
    for e in entries:
        store.add_entry(**e)
    monkeypatch.setattr(store, "prepared_unclustered",
                        lambda **kw: entries, raising=False)
    report = run(store, model, CFG)
    assert report["storylines_created"] == 1
    assert report["attach_mix"]["judge_new_episode"] == 1
    assert len(store.episodes) == 2
    first_id, second_id = list(store.episodes.keys())
    # the episode the judge replaced must be closed, not orphaned open forever
    assert store.episodes[first_id]["status"] == "dormant"
    episode_cards = [c for c in store.cards
                     if c["kind"] == "episode" and c["episode_id"] == first_id]
    assert len(episode_cards) == 1
    # finalize closes the still-open second (new) episode
    assert store.episodes[second_id]["status"] == "dormant"
    assert report["episodes_closed"] == 2   # replaced-episode close + finalize close


def test_due_close_fires_mid_loop_for_dormant_episode(monkeypatch):
    store = SpineFakeStore()
    stub = StubModels()
    gap = CFG.spine_episode_gap_hours
    entries = [
        _entry(1, "FTC sues Acme Corp over merger", T0),
        _entry(2, "FTC sues Acme Corp over merger update",
               T0 + timedelta(hours=gap + 1)),
        _entry(3, "FTC sues Acme Corp over merger detail",
               T0 + timedelta(hours=gap + 2)),
    ]
    for e in entries:
        e["embedding"] = pack_fp16(stub.embed([e["title"]])[0])
    for e in entries:
        store.add_entry(**e)
    monkeypatch.setattr(store, "prepared_unclustered",
                        lambda **kw: entries, raising=False)
    report = run(store, stub, CFG)
    assert report["storylines_created"] == 1
    # entry 2 lands >gap hours after entry 1: due_closes must fire mid-loop
    # (before entry 2 is judged), so the same-storyline match becomes a new
    # episode rather than an attach to what would otherwise still look open.
    assert report["attach_mix"].get("judge_new_episode") == 1
    assert report["attach_mix"].get("judge_same_dev") == 1  # entry 3 joins episode 2
    assert len(store.episodes) == 2
    assert report["episodes_closed"] == 2   # mid-loop due-close + finalize close
    assert all(ep["status"] == "dormant" for ep in store.episodes.values())


def test_finalize_retries_uncategorized_storylines(monkeypatch):
    """Mirrors pipeline.runner.cluster()'s end-of-run retry: storylines left
    without a category by a transient classify failure must not stay null
    forever — the driver retries them once after finalize-close."""
    store = SpineFakeStore()
    stub = StubModels()
    entries = [_entry(1, "FTC sues Acme Corp over merger", T0)]
    entries[0]["embedding"] = pack_fp16(stub.embed([entries[0]["title"]])[0])
    store.add_entry(**entries[0])
    monkeypatch.setattr(store, "prepared_unclustered",
                        lambda **kw: entries, raising=False)
    # simulate a storyline still uncategorized after the run (transient
    # classify failure earlier) — the id need not exist in the fake store
    # since the spy below short-circuits before touching it.
    monkeypatch.setattr(store, "uncategorized_storyline_ids",
                        lambda: ["needs-retry"])

    calls: list[tuple[str, str]] = []
    real_classify = CategoryEngine.classify

    def spy_classify(self, storyline_id, method="classified"):
        calls.append((storyline_id, method))
        if storyline_id == "needs-retry":
            return
        return real_classify(self, storyline_id, method=method)

    monkeypatch.setattr(CategoryEngine, "classify", spy_classify)

    run(store, stub, CFG)
    assert ("needs-retry", "retry") in calls
