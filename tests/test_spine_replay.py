from datetime import datetime, timedelta, timezone

from pipeline.config import Config
from pipeline.stub import StubModels
from pipeline.vectors import pack_fp16
from spine.replay import run
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
