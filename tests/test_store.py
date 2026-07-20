import pytest

from pipeline.shared.store import Store


class ReadDb:
    def __init__(self, rows):
        self.rows = rows
        self.sql = ""
        self.params = None

    def all(self, sql, params=None):
        self.sql = " ".join(sql.split())
        self.params = params
        return self.rows


def test_unprocessed_entries_uses_curated_publisher_key_as_agency():
    db = ReadDb([{"id": "entry-1", "agency": "fda"}])

    rows = Store(db).unprocessed_entries()

    assert rows[0]["agency"] == "fda"
    assert "news_source_publishers" in db.sql
    assert "split_part" not in db.sql


def test_unprocessed_entries_rejects_missing_publisher_attribution():
    db = ReadDb([{"id": "entry-1", "agency": None}])

    with pytest.raises(RuntimeError, match="publisher attribution"):
        Store(db).unprocessed_entries()


def test_insert_card_carries_preallocated_run_and_weight_provenance():
    class RpcDb:
        def __init__(self):
            self.call = None

        def rpc(self, fn, **kwargs):
            self.call = (fn, kwargs)
            return "card-1"

        @staticmethod
        def jsonb(value):
            return value

    db = RpcDb()
    store = Store(db)
    store.bind_experiment("00000000-0000-4000-8000-000000000123", 4)

    card_id = store.insert_card(
        storyline_id="story-1", episode_id=None, kind="overview",
        headline="Headline", summary="Summary", timeline=[], rubric=None,
        rubric_version=None, interest_reason=None,
        representative_entry_id=None, judge_model=None, prompt_version=1,
        overview_embedding=None, tau=124600.0)

    assert card_id == "card-1"
    assert db.call[0] == "insert_event_card"
    assert db.call[1]["p_source_run_id"] == "00000000-0000-4000-8000-000000000123"
    assert db.call[1]["p_publisher_weight_version"] == 4


def test_entries_needing_features_filters_by_curated_publisher_key():
    db = ReadDb([])

    Store(db).entries_needing_features(agencies=["csb", "ntsb"])

    assert "news_source_publishers" in db.sql
    assert "publisher_key = any" in db.sql


def test_prepared_unclustered_uses_topology_curator_with_requested_mix():
    db = ReadDb([{"id": "entry-1", "agency": "fema"}])

    rows = Store(db).prepared_unclustered(
        limit=100,
        topology_label_set_id="00000000-0000-4000-8000-000000000001",
        multi_episode_percent=40,
        multi_entry_single_episode_percent=20,
        topology_seed="run-7",
    )

    assert rows[0]["agency"] == "fema"
    assert "curate_news_entry_dataset_by_storyline_topology" in db.sql
    assert "expected_topology_class" in db.sql
    assert db.params["limit"] == 100
    assert db.params["multi_episode_percent"] == 40
    assert db.params["multi_entry_percent"] == 20
    assert db.params["seed"] == "run-7"


def test_prepared_unclustered_topology_curation_requires_limit_and_mix():
    store = Store(ReadDb([]))

    with pytest.raises(ValueError, match="finite limit"):
        store.prepared_unclustered(
            topology_label_set_id="00000000-0000-4000-8000-000000000001",
            multi_episode_percent=40,
        )
    with pytest.raises(ValueError, match="multi_episode_percent"):
        store.prepared_unclustered(
            limit=100,
            topology_label_set_id="00000000-0000-4000-8000-000000000001",
        )
    with pytest.raises(ValueError, match="cannot be combined"):
        store.prepared_unclustered(
            limit=100,
            per_agency=10,
            topology_label_set_id="00000000-0000-4000-8000-000000000001",
            multi_episode_percent=40,
        )
    with pytest.raises(ValueError, match="since cannot be combined"):
        store.prepared_unclustered(
            limit=100,
            since="2025-09-01",
            topology_label_set_id="00000000-0000-4000-8000-000000000001",
            multi_episode_percent=40,
        )


def test_prepared_unclustered_selects_exact_golden_batch():
    db = ReadDb([{"id": "entry-1", "agency": "fema"}])

    rows = Store(db).prepared_unclustered(golden_batch=7)

    assert rows[0]["agency"] == "fema"
    assert "golden_news_entries" in db.sql
    assert "golden.review_status in ('pending', 'proposed')" in db.sql
    assert db.params["batch"] == 7


def test_prepared_unclustered_golden_batch_rejects_other_filters():
    store = Store(ReadDb([]))

    with pytest.raises(ValueError, match="cannot be combined"):
        store.prepared_unclustered(golden_batch=1, limit=50)


def test_prepared_unclustered_applies_inclusive_since():
    db = ReadDb([])

    Store(db).prepared_unclustered(since="2025-09-01")

    assert "ne.published_at >= %(since)s" in db.sql
    assert db.params["since"] == "2025-09-01"
