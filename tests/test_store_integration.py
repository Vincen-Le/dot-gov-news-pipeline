# tests/test_store_integration.py
"""Integration regression test for RPC float-param typing.

`attach_entry_to_episode` and `create_episode_with_storyline` declare their
similarity/threshold params as Postgres `real`. psycopg adapts a bare Python
float as `float8`, and Postgres won't implicitly cast float8 -> real during
function resolution, so any call with a non-None similarity raised
UndefinedFunction. Calls with None slipped through as untyped NULLs, which is
why the unit suite (which uses FakeStore) never caught it.
"""
import hashlib
import os
import uuid
from datetime import datetime, timezone

import pytest

from pipeline.db import Db
from pipeline.store import Store


@pytest.mark.integration
def test_attach_entry_and_create_episode_accept_non_none_similarity():
    db = Db(os.environ["DATABASE_URL"])
    store = Store(db)

    ts = datetime.now(timezone.utc)
    unique = uuid.uuid4().hex
    source_url = f"https://test.gov/{unique}/feed.xml"
    entry_url = f"https://test.gov/{unique}/article"

    source_id = None
    entry_id = None
    episode_id = None
    storyline_id = None
    try:
        source_id = store.upsert_news_source(source_url, "rss", None)
        entry_id = store.ingest_entry(
            source_id, entry_url, entry_url, "title", "summary", ts,
            hashlib.sha256(unique.encode()).hexdigest(), [], [], 1,
        )
        assert entry_id is not None

        episode_id, storyline_id = store.create_episode(
            None, "new_storyline", 0.87, "test", "stub", ts,
        )
        assert episode_id is not None

        store.attach_entry(
            entry_id, episode_id, "test.gov", False, "new_cluster",
            0.91, None, 0.78, "stub", None, ts,
        )

        row = db.one(
            "select similarity from public.episode_entries "
            "where episode_id = %(e)s and entry_id = %(n)s",
            {"e": episode_id, "n": entry_id},
        )
        assert row is not None
        assert row["similarity"] == pytest.approx(0.91, abs=1e-3)
    finally:
        if entry_id is not None:
            db.conn.execute(
                "update public.news_entries set episode_id = null where id = %(n)s",
                {"n": entry_id},
            )
        if episode_id is not None:
            db.conn.execute(
                "delete from public.episode_entries where episode_id = %(e)s",
                {"e": episode_id},
            )
            db.conn.execute(
                "delete from public.episodes where id = %(e)s", {"e": episode_id},
            )
        if storyline_id is not None:
            db.conn.execute(
                "delete from public.storylines where id = %(s)s", {"s": storyline_id},
            )
        if entry_id is not None:
            db.conn.execute(
                "delete from public.news_entries where id = %(n)s", {"n": entry_id},
            )
        if source_id is not None:
            db.conn.execute(
                "delete from public.news_sources where id = %(s)s", {"s": source_id},
            )


@pytest.mark.integration
def test_entries_needing_features_per_agency_caps_each_agency():
    db = Db(os.environ["DATABASE_URL"])
    store = Store(db)

    ts = datetime.now(timezone.utc)
    unique = uuid.uuid4().hex
    source_ids = []
    entry_ids = []
    try:
        # two agencies, 3 and 1 unprepared entries respectively
        for agency, count in (("alpha", 3), ("beta", 1)):
            source_id = store.upsert_news_source(
                f"https://{agency}-{unique}.gov/feed.xml", "rss", None)
            source_ids.append(source_id)
            db.conn.execute(
                "insert into public.news_source_publishers "
                "(news_source_id, publisher_key) values (%(source)s, %(agency)s)",
                {"source": source_id, "agency": agency},
            )
            for i in range(count):
                url = f"https://{agency}-{unique}.gov/article-{i}"
                entry_id = store.ingest_entry(
                    source_id, url, url, f"{agency} title {i}", None, ts,
                    hashlib.sha256(f"{agency}{unique}{i}".encode()).hexdigest(),
                    [], [], 1)
                assert entry_id is not None
                entry_ids.append(entry_id)

        rows = store.entries_needing_features(per_agency=2)
        mine = [r for r in rows if str(r["id"]) in {str(e) for e in entry_ids}]
        # capped at 2 for alpha, beta keeps its single entry
        assert len(mine) == 3
    finally:
        for entry_id in entry_ids:
            db.conn.execute(
                "delete from public.news_entries where id = %(n)s", {"n": entry_id})
        for source_id in source_ids:
            db.conn.execute(
                "delete from public.news_source_publishers "
                "where news_source_id = %(s)s", {"s": source_id})
            db.conn.execute(
                "delete from public.news_sources where id = %(s)s", {"s": source_id})


@pytest.mark.integration
def test_attach_recomputes_source_weight_from_publisher_tier():
    db = Db(os.environ["DATABASE_URL"])
    store = Store(db)

    ts = datetime.now(timezone.utc)
    unique = uuid.uuid4().hex
    source_url = f"https://pwtest.gov/{unique}/feed.xml"
    entry_url = f"https://pwtest.gov/{unique}/article"

    source_id = entry_id = episode_id = storyline_id = None
    try:
        source_id = store.upsert_news_source(source_url, "rss", None)
        db.conn.execute(
            "insert into public.news_source_publishers (news_source_id, publisher_key) "
            "values (%(s)s, 'fda') "
            "on conflict (news_source_id) do update set publisher_key = 'fda'",
            {"s": source_id})
        entry_id = store.ingest_entry(
            source_id, entry_url, entry_url, "pw title", "pw summary", ts,
            hashlib.sha256(unique.encode()).hexdigest(), [], [], 1,
        )
        episode_id, storyline_id = store.create_episode(
            None, "new_storyline", None, "pw test", None, ts,
        )
        store.attach_entry(
            entry_id, episode_id, "fda", False, "new_cluster",
            None, None, None, "stub", None, ts,
            publisher_weight_version=1,
        )
        row = db.one(
            "select source_weight_max from public.storylines where id = %(s)s",
            {"s": storyline_id})
        assert row["source_weight_max"] == pytest.approx(2.0, abs=1e-6)
    finally:
        if entry_id is not None:
            db.conn.execute(
                "update public.news_entries set episode_id = null where id = %(n)s",
                {"n": entry_id})
        if episode_id is not None:
            db.conn.execute(
                "delete from public.episode_entries where episode_id = %(e)s",
                {"e": episode_id})
            db.conn.execute(
                "delete from public.episodes where id = %(e)s", {"e": episode_id})
        if storyline_id is not None:
            db.conn.execute(
                "delete from public.storylines where id = %(s)s", {"s": storyline_id})
        if entry_id is not None:
            db.conn.execute(
                "delete from public.news_entries where id = %(n)s", {"n": entry_id})
        if source_id is not None:
            db.conn.execute(
                "delete from public.news_source_publishers "
                "where news_source_id = %(s)s", {"s": source_id})
            db.conn.execute(
                "delete from public.news_sources where id = %(s)s", {"s": source_id})
