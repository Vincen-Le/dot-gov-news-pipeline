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

    def prepared_unclustered(
        self, limit=None, until=None, per_agency=None,
        topology_label_set_id=None, multi_episode_percent=None,
        multi_entry_single_episode_percent=0.0, topology_seed="default",
    ):
        if topology_label_set_id is not None:
            raise AssertionError("topology curation is covered by Store tests")
        rows = sorted(
            (e for e in self.entries.values() if e["embedding"] is not None),
            key=lambda e: e["published_at"])
        if until:
            rows = [r for r in rows if r["published_at"] <= until]
        if per_agency is not None:
            # mirror prepared_unclustered's balanced mode: walk newest->oldest
            # capping each agency, stop at limit, replay order stays asc
            picked, seen = [], {}
            for r in reversed(rows):
                seen[r["agency"]] = seen.get(r["agency"], 0) + 1
                if seen[r["agency"]] <= per_agency:
                    picked.append(r)
                if limit and len(picked) >= limit:
                    break
            return sorted(picked, key=lambda e: e["published_at"])
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


def test_cluster_with_topics_enabled_never_spawns_themes_on_stream():
    store, models, cfg = make_harness(topics_enabled=True)
    add(store, 1, 0, 0)
    add(store, 2, 30, 3, entities=("oxprenol",))
    cluster(store, models, cfg)
    assert store.themes == {}


def test_cluster_with_topics_disabled_never_touches_themes():
    store, models, cfg = make_harness(topics_enabled=False)
    add(store, 1, 0, 0)
    add(store, 2, 30, 3, entities=("oxprenol",))
    cluster(store, models, cfg)
    assert store.themes == {}
    assert all(s.get("theme_id") is None for s in store.storylines.values())


def test_cluster_touches_entity_stats_per_entry_in_event_time():
    store = ClusterFakeStore()
    add(store, 0, hours=0, axis=0)
    add(store, 1, hours=1, axis=1)
    cluster(store, NoModels(), CFG)
    assert len(store.touches) == 2
    for tokens, t in store.touches:
        assert isinstance(tokens, list)
        assert "valsatrex" in tokens
    # EMA table is no longer empty during replay
    assert store.emas.get("valsatrex", 0.0) >= 2.0


def test_balanced_sample_takes_newest_capped_per_agency_until_limit():
    store = ClusterFakeStore()
    # agency defaults to "x.gov"; three entries, newest last
    add(store, 1, hours=0, axis=0)
    add(store, 2, hours=1, axis=1)
    add(store, 3, hours=2, axis=2)
    rows = store.prepared_unclustered(limit=2, per_agency=2)
    # newest two picked (items 2 and 3), replayed in ascending time
    assert [r["title"] for r in rows] == ["item 2", "item 3"]


class SweepClusterFakeStore(TopicClusterFakeStore):
    """Add storyline timestamps maintained by the real episode RPCs."""

    def attach_entry(self, entry_id, episode_id, *args, **kw):
        result = super().attach_entry(entry_id, episode_id, *args, **kw)
        story_id = self.episodes[episode_id]["storyline_id"]
        t = self.entries[entry_id]["published_at"]
        story = self.storylines[story_id]
        story["first_entry_at"] = min(story.get("first_entry_at") or t, t)
        story["newest_entry_at"] = max(story.get("newest_entry_at") or t, t)
        return result


class PromoteJudgeModels(StubModels):
    def judge_promotion(self, dossier):
        return {"verdict": "promote", "theme_name": "Recurring Item Updates",
                "inclusion_criterion": "storylines about recurring item updates",
                "theme_id": None, "reason": "test: always promote"}


def test_cluster_categorizes_storylines_and_final_sweep_promotes():
    store = SweepClusterFakeStore()
    store.categories["c-health"] = {
        "id": "c-health", "display_name": "Public Health", "origin": "seed"}
    for i, hours in enumerate((0, 26, 52, 78)):
        add(store, i, hours, i, entities=(f"uniq{i}",))
    cfg = Config(
        database_url="x", cf_account_id="a", cf_api_token="t",
        topics_enabled=True, theme_promotion_min_storylines=2,
        theme_promotion_min_active_days=2,
        theme_promotion_cohesion_floor=0.0,
        theme_promotion_cluster_floor=0.05,
        theme_sweep_interval_hours=24.0)
    report = cluster(store, PromoteJudgeModels(), cfg)

    assert all(s.get("category_id") == "c-health"
               for s in store.storylines.values())
    assert report["theme_sweeps"] >= 2
    assert report["theme_sweep_totals"]["promoted"] >= 1
    themed = [s for s in store.storylines.values() if s.get("theme_id")]
    assert themed
    theme = next(iter(store.all_themes()))
    assert theme["inclusion_criterion"] == \
        "storylines about recurring item updates"
