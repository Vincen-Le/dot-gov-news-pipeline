"""Unit: audit pairing, swap-consistency handling, metrics. Fake db, stub models."""

from datetime import datetime, timezone

from pipeline.shared.config import Config
from pipeline.rank import audit_run
from pipeline.shared.stub import StubModels

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             rank_audit_top_k=10, rank_audit_window=2, rank_audit_facets="global")


def _row(position, headline, agencies):
    return {"facet_type": "global", "facet_key": "", "position": position,
            "storyline_id": f"00000000-0000-4000-8000-00000000000{position}",
            "headline": headline, "summary": "s", "agencies": agencies,
            "feeds": agencies, "entry_count": agencies, "newest_entry_at": T0,
            "terms": {"rubric_points": 4.0, "agency_term": 0.5, "feed_term": 0.5,
                      "source_term": 0.0, "freshness_term": 14000.0}}


class FakeDb:
    def __init__(self, rows):
        self.rows = rows
        self.executed = []

    def all(self, sql, params=None):
        return self.rows

    class _Cursor:
        rowcount = 1

        def fetchone(self):
            return {"id": "33333333-3333-4333-8333-333333333301"}

    @property
    def conn(self):
        outer = self

        class Conn:
            def execute(self, sql, params=None):
                outer.executed.append((sql, params))
                return FakeDb._Cursor()
        return Conn()


def test_audit_disagreement_detected_and_metrics_written():
    # formula order: position 1 has FEWER agencies than position 2 — the
    # stub (corroboration order) will prefer 'b', a disagreement.
    rows = [_row(1, "Weak story", agencies=1), _row(2, "Strong story", agencies=5)]
    db = FakeDb(rows)
    metrics = audit_run(db, StubModels(), CFG, "44444444-4444-4444-8444-444444444401")
    assert metrics["pairs"] == 1
    assert metrics["agreement_rate"] == 0.0
    assert metrics["kendall_tau_sampled"] == -1.0
    inserted_pair_sql = [s for s, _ in db.executed if "rank_audit_pairs" in s]
    assert inserted_pair_sql, "audit pair row inserted"
    audit_run_sql = [s for s, _ in db.executed if "rank_audit_runs" in s]
    assert audit_run_sql, "audit metrics row inserted"
    assert metrics["disagreement_term_deltas"]["agency_term"] == 0.0


def test_audit_agreement():
    rows = [_row(1, "Strong story", agencies=5), _row(2, "Weak story", agencies=1)]
    metrics = audit_run(FakeDb(rows), StubModels(), CFG,
                        "44444444-4444-4444-8444-444444444402")
    assert metrics["pairs"] == 1
    assert metrics["agreement_rate"] == 1.0
    assert metrics["per_facet"]["global"]["agree"] == 1


def test_audit_window_bounds_pair_count():
    rows = [_row(i, f"story {i}", agencies=6 - i) for i in range(1, 5)]
    metrics = audit_run(FakeDb(rows), StubModels(), CFG,
                        "44444444-4444-4444-8444-444444444403")
    # window=2 over 4 rows: (1,2),(1,3),(2,3),(2,4),(3,4) = 5 pairs
    assert metrics["pairs"] == 5
    assert metrics["agreement_rate"] == 1.0
