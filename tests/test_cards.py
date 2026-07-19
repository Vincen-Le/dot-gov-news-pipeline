from datetime import datetime, timezone

from pipeline.cards import CardEngine
from pipeline.config import Config
from pipeline.stub import StubModels

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


class CardFakeStore:
    def __init__(self):
        self.cards = []

    def episode_members(self, episode_id):
        return [{"id": "n1", "title": "FDA recalls Valsatrex", "summary": "Contamination.",
                 "published_at": T0, "is_syndicated": False}]

    def episode_cards_for(self, storyline_id):
        return [{"episode_id": "e1", "headline": "FDA recalls Valsatrex",
                 "summary": "Contamination.", "date": "2026-05-14"}]

    def insert_card(self, **kw):
        self.cards.append(kw)
        return f"card-{len(self.cards)}"


def episode():
    return {"id": "e1", "storyline_id": "s1", "entity_set": ["valsatrex"],
            "newest_entry_at": T0, "first_entry_at": T0, "entry_count": 1}


def test_single_episode_close_also_writes_overview():
    store = CardFakeStore()
    CardEngine(store, StubModels(), CFG).on_episode_closed(episode())
    kinds = [c["kind"] for c in store.cards]
    assert kinds == ["episode", "overview"]  # overview at birth: themes need a centroid
    overview = store.cards[1]
    assert overview["overview_embedding"] is not None


def test_overview_regenerated_on_multi_episode_storyline():
    store = CardFakeStore()
    CardEngine(store, StubModels(), CFG).on_episode_closed(episode())
    kinds = [c["kind"] for c in store.cards]
    assert kinds == ["episode", "overview"]
    overview = store.cards[1]
    assert overview["timeline"][0]["episode_id"] == "e1"  # cited bullets survive validation
    assert overview["overview_embedding"] is not None      # storyline centroid refresh
    assert set(overview["rubric"].keys()) >= {"urgency", "novelty"}


class TwoEpisodeFakeStore(CardFakeStore):
    def episode_cards_for(self, storyline_id):
        return [
            {"episode_id": "e1", "headline": "FDA recalls Valsatrex",
             "summary": "Contamination.", "date": "2026-05-14"},
            {"episode_id": "e2", "headline": "FDA expands Valsatrex recall",
             "summary": "More lots.", "date": "2026-05-20"},
        ]


def test_overview_timeline_ordered_newest_first():
    store = TwoEpisodeFakeStore()
    CardEngine(store, StubModels(), CFG).on_episode_closed(episode())
    timeline = store.cards[1]["timeline"]
    assert [item["episode_id"] for item in timeline] == ["e2", "e1"]


def test_fallback_timeline_ordered_newest_first():
    store = TwoEpisodeFakeStore()
    CardEngine(store, ExplodingCompressorModels(), CFG).on_episode_closed(episode())
    timeline = store.cards[1]["timeline"]
    assert [item["episode_id"] for item in timeline] == ["e2", "e1"]


class MixedTimelineDateModels(StubModels):
    def compress_overview(self, storyline_summary, episode_cards):
        card = super().compress_overview(storyline_summary, episode_cards)
        card["timeline"] = [
            {"episode_id": "e1", "date": 20260514, "text": "first"},
            {"episode_id": "e2", "date": "2026-05-20", "text": "second"},
        ]
        return card


def test_overview_timeline_tolerates_mixed_model_date_types():
    store = TwoEpisodeFakeStore()
    CardEngine(store, MixedTimelineDateModels(), CFG).on_episode_closed(episode())
    assert len(store.cards[1]["timeline"]) == 2


class OversizedCardFakeStore(CardFakeStore):
    def episode_members(self, episode_id):
        return [{"id": "n1", "title": "F" * 600, "summary": "C" * 16000,
                 "published_at": T0, "is_syndicated": True}]


class OversizedOverviewModels(StubModels):
    def compress_overview(self, storyline_summary, episode_cards):
        card = super().compress_overview(storyline_summary, episode_cards)
        card["summary"] = "S" * 9000
        return card


def test_episode_card_headline_and_summary_clamped_to_db_bounds():
    store = OversizedCardFakeStore()
    CardEngine(store, StubModels(), CFG).on_episode_closed(episode())
    card = store.cards[0]
    assert card["kind"] == "episode"
    assert len(card["headline"]) <= 512
    assert len(card["summary"]) <= 8192
    assert card["summary"].endswith("(+1 republications)")


def test_overview_card_summary_clamped_to_db_bounds():
    store = CardFakeStore()
    CardEngine(store, OversizedOverviewModels(), CFG).on_episode_closed(episode())
    overview = store.cards[1]
    assert overview["kind"] == "overview"
    assert len(overview["headline"]) <= 512
    assert len(overview["summary"]) <= 8192


class ExplodingCompressorModels(StubModels):
    def compress_overview(self, storyline_summary, episode_cards):
        raise ValueError("no json object in model output: garbage")


def test_compressor_failure_falls_back_to_deterministic_overview():
    store = CardFakeStore()
    CardEngine(store, ExplodingCompressorModels(), CFG).on_episode_closed(episode())
    kinds = [c["kind"] for c in store.cards]
    assert kinds == ["episode", "overview"]          # close never blocks on the LLM
    overview = store.cards[1]
    assert overview["rubric"] is None                # unjudged -> prior points, per spec
    assert overview["interest_reason"].startswith("compressor_error")
    assert overview["timeline"][0]["episode_id"] == "e1"   # deterministic cited timeline
    assert len(overview["summary"]) <= 8192
    assert overview["overview_embedding"] is not None
