"""Integration: snapshot freezes per-facet ranking with term decomposition.

Fixtures are inserted inline (superuser connection) so the test does not
depend on corpus state; everything is cleaned up in finally blocks.
"""

import os
import uuid
from datetime import datetime, timezone

import pytest

from pipeline.config import Config
from pipeline.db import Db
from pipeline.rank import snapshot_run

pytestmark = pytest.mark.integration

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="unused", cf_account_id="a", cf_api_token="t")


def _mk_run(db) -> str:
    row = db.conn.execute(
        "insert into public.complex_v1_experiment_runs (name, started_at, finished_at) "
        "values ('rank snapshot test', %(t)s, %(t)s) returning id",
        {"t": T0}).fetchone()
    return str(row["id"])


def _mk_storyline_with_card(db, headline: str, rubric, agencies: list[str]) -> tuple[str, str]:
    storyline = db.conn.execute(
        "insert into public.storylines "
        "(agency_ids, distinct_feeds, entry_count, episode_count, "
        " source_weight_max, first_entry_at, newest_entry_at) "
        "values (%(a)s, 1, 1, 1, 1.0, %(t)s, %(t)s) returning id",
        {"a": agencies, "t": T0}).fetchone()
    storyline_id = str(storyline["id"])
    card = db.conn.execute(
        "insert into public.event_cards "
        "(storyline_id, kind, version, headline, summary, rubric, rubric_version, "
        " newest_entry_at, rank_key) "
        "values (%(s)s, 'overview', 1, %(h)s, 'summary', %(r)s::jsonb, "
        "        case when %(r)s is null then null else 1 end, %(t)s, "
        "        public.compute_rank_key(%(r)s::jsonb, 1, %(n)s, 1, 1.0, %(t)s)) "
        "returning id",
        {"s": storyline_id, "h": headline, "r": rubric, "t": T0,
         "n": len(agencies)}).fetchone()
    card_id = str(card["id"])
    db.conn.execute(
        "update public.storylines set latest_card_id = %(c)s where id = %(s)s",
        {"c": card_id, "s": storyline_id})
    return storyline_id, card_id


def test_snapshot_orders_by_rank_key_and_terms_sum():
    db = Db(os.environ["DATABASE_URL"])
    run_id = None
    storylines = []
    try:
        run_id = _mk_run(db)
        # judged, two agencies -> outranks unjudged single-agency at same time
        storylines.append(_mk_storyline_with_card(
            db, f"judged {uuid.uuid4().hex[:8]}",
            '{"mass_impact":1,"health_safety":1,"urgency":1,"novelty":1,'
            '"economic":1,"policy_change":1,"rights_legal":1,"national_scope":1}',
            ["fda", "cdc"]))
        storylines.append(_mk_storyline_with_card(
            db, f"unjudged {uuid.uuid4().hex[:8]}", None, ["nps"]))

        out = snapshot_run(db, CFG, run_id)
        # 2 global + 3 agency rows (fda, cdc, nps); no themes assigned
        assert out["snapshot_rows"] == 5

        rows = db.all(
            "select position, rank_key, terms, judged, headline "
            "from public.rank_snapshots "
            "where run_id = %(r)s and facet_type = 'global' order by position",
            {"r": run_id})
        assert len(rows) == 2
        keys = [r["rank_key"] for r in rows]
        assert keys == sorted(keys, reverse=True)
        assert rows[0]["judged"] and rows[0]["headline"].startswith("judged")
        for row in rows:
            t = row["terms"]
            total = (t["rubric_points"] + t["agency_term"] + t["feed_term"]
                     + t["source_term"] + t["freshness_term"])
            # terms recompute from current aggregates; stored key was computed
            # at card birth with the same aggregates here, so they agree
            assert abs(total - row["rank_key"]) < 1e-6

        agency_rows = db.all(
            "select facet_key from public.rank_snapshots "
            "where run_id = %(r)s and facet_type = 'agency' order by facet_key",
            {"r": run_id})
        assert [r["facet_key"] for r in agency_rows] == ["cdc", "fda", "nps"]
    finally:
        if run_id is not None:
            db.conn.execute(
                "delete from public.complex_v1_experiment_runs where id = %(r)s", {"r": run_id})
        for storyline_id, card_id in storylines:
            db.conn.execute(
                "update public.storylines set latest_card_id = null where id = %(s)s",
                {"s": storyline_id})
            db.conn.execute(
                "delete from public.event_cards where id = %(c)s", {"c": card_id})
            db.conn.execute(
                "delete from public.storylines where id = %(s)s", {"s": storyline_id})
