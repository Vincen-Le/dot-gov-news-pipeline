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
    assert overview["overview_embedding"] is not None      # storyline centroid refresh
    assert set(overview["rubric"].keys()) >= {"urgency", "novelty"}
