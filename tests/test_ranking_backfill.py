import pytest

from pipeline.ranking.backfill import backfill_event_card_contexts
from pipeline.shared.config import Config


CFG = Config(
    database_url="postgresql://postgres:postgres@127.0.0.1:57422/postgres",
    cf_account_id="test",
    cf_api_token="test",
    publisher_weight_version=2,
    tau_seconds=123.0,
)


class FakeDb:
    class Conn:
        class Info:
            dsn = "postgresql://postgres:postgres@127.0.0.1:57422/postgres"

        info = Info()

    conn = Conn()

    def __init__(self, *, candidates, receipt):
        self.candidates = candidates
        self.receipt = receipt
        self.calls = []

    def all(self, sql, params=None):
        if "left join public.event_card_contexts" in sql:
            return [{
                "id": "00000000-0000-4000-8000-000000000101",
                "headline": "Historical card",
            }]
        return self.candidates

    def rpc(self, fn, **kwargs):
        self.calls.append((fn, kwargs))
        return self.receipt


def test_backfill_is_dry_run_by_default_and_uses_frozen_run_config():
    db = FakeDb(
        candidates=[{
            "pipeline_namespace": "simple_v1",
            "run_id": "00000000-0000-4000-8000-000000000201",
            "config": {"publisher_weight_version": 4, "tau_seconds": 456.0},
        }],
        receipt={"card_id": "00000000-0000-4000-8000-000000000101",
                 "status": "exact", "exact": True, "written": False},
    )

    report = backfill_event_card_contexts(db, CFG)

    assert report["mode"] == "dry_run"
    assert report["statuses"] == {"exact": 1}
    fn, params = db.calls[0]
    assert fn == "backfill_event_card_context"
    assert params["p_source_run_id"].endswith("0201")
    assert params["p_publisher_weight_version"] == 4
    assert params["p_tau"] == 456.0
    assert params["p_write"] is False
    assert params["p_allow_fallback"] is False


def test_backfill_skips_ambiguous_source_runs_without_calling_rpc():
    db = FakeDb(
        candidates=[
            {"pipeline_namespace": "simple_v1", "run_id": "run-1", "config": {}},
            {"pipeline_namespace": "complex_v1", "run_id": "run-2", "config": {}},
        ],
        receipt={},
    )

    report = backfill_event_card_contexts(db, CFG, write=True)

    assert report["written"] == 0
    assert report["statuses"] == {"ambiguous_source_run": 1}
    assert db.calls == []


def test_fallback_writes_are_always_rejected():
    db = FakeDb(
        candidates=[
            {"pipeline_namespace": "simple_v1", "run_id": "run-1", "config": {}},
            {"pipeline_namespace": "simple_v1", "run_id": "run-2", "config": {}},
        ],
        receipt={"card_id": "card-1", "status": "fallback",
                 "exact": False, "written": True},
    )

    with pytest.raises(ValueError, match="fallback context writes are unsafe"):
        backfill_event_card_contexts(
            db, CFG, write=True, allow_fallback=True, source_run_id="run-2")

    assert db.calls == []


def test_requested_source_run_must_be_recorded_on_the_card_context():
    db = FakeDb(
        candidates=[{
            "pipeline_namespace": "simple_v1", "run_id": "run-1", "config": {}
        }],
        receipt={},
    )

    report = backfill_event_card_contexts(
        db, CFG, write=True, source_run_id="run-2")

    assert report["statuses"] == {"requested_source_run_not_recorded": 1}
    assert db.calls == []
