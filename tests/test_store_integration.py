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
