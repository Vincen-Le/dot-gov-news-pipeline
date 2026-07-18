from datetime import datetime, timedelta, timezone

import numpy as np

from pipeline.config import Config
from pipeline.runner import cluster
from pipeline.stub import StubModels
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


class TopicClusterFakeStore(ClusterFakeStore):
    """Mirror insert_event_card's storyline refresh: overview cards set the
    storyline centroid/headline the ThemeEngine reads."""

    def insert_card(self, **kw):
        card_id = super().insert_card(**kw)
        if kw["kind"] == "overview":
            story = self.storylines[kw["storyline_id"]]
            story["centroid"] = kw["overview_embedding"]
            story["headline"] = kw["headline"]
            story["summary"] = kw["summary"]
        return card_id


def make_harness(topics_enabled):
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t",
                 topics_enabled=topics_enabled)
    return TopicClusterFakeStore(), StubModels(), cfg


def test_cluster_with_topics_enabled_assigns_every_storyline_a_theme():
    store, models, cfg = make_harness(topics_enabled=True)
    add(store, 1, 0, 0)
    add(store, 2, 30, 3, entities=("oxprenol",))
    cluster(store, models, cfg)
    themed = [s for s in store.storylines.values() if s.get("theme_id")]
    assert len(themed) == len(store.storylines)
    assert len(store.themes) >= 1


def test_cluster_with_topics_disabled_never_touches_themes():
    store, models, cfg = make_harness(topics_enabled=False)
    add(store, 1, 0, 0)
    add(store, 2, 30, 3, entities=("oxprenol",))
    cluster(store, models, cfg)
    assert store.themes == {}
    assert all(s.get("theme_id") is None for s in store.storylines.values())
