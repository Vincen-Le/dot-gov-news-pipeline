# tests/test_bench.py
import json
import os

import httpx
import pytest

from pipeline.shared.bench import assert_local_dsn, reset_clusters, sync_corpus


class FakeConnInfo:
    def __init__(self, dsn):
        self.dsn = dsn


class FakeConn:
    def __init__(self, dsn="postgresql://postgres:postgres@127.0.0.1:54322/postgres"):
        self.info = FakeConnInfo(dsn)
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((" ".join(sql.split()), params))


class FakeDb:
    def __init__(self, dsn="postgresql://postgres:postgres@127.0.0.1:54322/postgres"):
        self.conn = FakeConn(dsn)


def test_local_dsn_guard():
    assert_local_dsn("postgresql://postgres:pw@127.0.0.1:54322/postgres")
    assert_local_dsn("postgresql://postgres:pw@localhost/postgres")
    with pytest.raises(RuntimeError):
        assert_local_dsn("postgresql://postgres.ref@aws-1-us-east-2.pooler.supabase.com:5432/postgres")


def test_local_dsn_guard_keyword_value_form():
    # Db.conn.info.dsn comes back in this form, not as a URI.
    assert_local_dsn("user=postgres dbname=postgres host=127.0.0.1 port=54322")


def test_local_dsn_guard_rejects_hostaddr():
    # libpq connects via hostaddr when present, even if host looks local —
    # the guard must not be bypassable by setting hostaddr alone or alongside
    # a spoofed local host.
    with pytest.raises(RuntimeError):
        assert_local_dsn("hostaddr=203.0.113.5 dbname=postgres")
    with pytest.raises(RuntimeError):
        assert_local_dsn("host=localhost hostaddr=203.0.113.5 dbname=postgres")
    with pytest.raises(RuntimeError):
        assert_local_dsn("postgresql://postgres@localhost/postgres?hostaddr=203.0.113.9")


def test_reset_clusters_wipes_decisions_not_features():
    db = FakeDb()
    reset_clusters(db)
    statements = [s for s, _ in db.conn.executed]
    sql = " ; ".join(statements)
    assert not any("truncate" in s for s in statements)
    assert not any("cascade" in s for s in statements)
    assert "news_entries" in sql and "set episode_id = null" in sql
    assert "storylines" in sql and "set latest_card_id = null" in sql
    for table in ("episode_entries", "event_cards", "episodes", "storylines",
                  "entity_stats"):
        assert any(s.startswith(f"delete from public.{table}") for s in statements)
    assert "embedding" not in sql          # features untouched


def test_reset_refuses_remote_dsn():
    with pytest.raises(RuntimeError):
        reset_clusters(FakeDb("postgresql://u:p@db.example.supabase.co/postgres"))


@pytest.mark.integration
def test_reset_clusters_preserves_news_entries_against_real_db():
    from pipeline.shared.db import Db

    db = Db(os.environ["DATABASE_URL"])
    before = db.one("select count(*) as n from public.news_entries")["n"]
    if before == 0:
        pytest.skip("no news_entries corpus present in local db")

    reset_clusters(db)

    after = db.one("select count(*) as n from public.news_entries")["n"]
    assert after == before
    for table in ("episodes", "storylines", "episode_entries", "event_cards",
                  "entity_stats"):
        remaining = db.one(f"select count(*) as n from public.{table}")["n"]
        assert remaining == 0, f"{table} not empty after reset_clusters"


def test_sync_copies_pages_and_preserves_ids():
    sources = [{"id": "s-1", "canonical_url": "https://fda.gov/f.xml",
                "source_type": "rss", "title": None}]
    publishers = [{"news_source_id": "s-1", "publisher_key": "fda"}]
    page1 = [{"id": f"e-{i}", "news_source_id": "s-1", "url": f"https://fda.gov/{i}",
              "url_canonical": f"https://fda.gov/{i}", "title": f"t{i}", "summary": "s",
              "published_at": "2026-05-14T14:00:00+00:00",
              "fetched_at": "2026-05-14T14:00:00+00:00",
              "content_hash": "ab" * 32, "extractor_version": 1} for i in range(2)]

    def handler(request):
        if "news_source_publishers" in str(request.url):
            return httpx.Response(200, json=publishers)
        if "news_sources" in str(request.url):
            return httpx.Response(200, json=sources)
        offset = int(dict(request.url.params)["offset"])
        return httpx.Response(200, json=page1 if offset == 0 else [])

    db = FakeDb()
    report = sync_corpus(db, "https://x.supabase.co", "key",
                         page=1000, transport=httpx.MockTransport(handler))
    assert report["sources"] == 1 and report["publishers"] == 1
    assert report["entries"] == 2
    inserts = [s for s, _ in db.conn.executed if s.startswith("insert")]
    assert any("news_sources" in s for s in inserts)
    publisher_insert = next(p for s, p in db.conn.executed
                            if s.startswith("insert into public.news_source_publishers"))
    assert publisher_insert["publisher_key"] == "fda"
    entry_insert = next(p for s, p in db.conn.executed
                        if s.startswith("insert into public.news_entries"))
    assert entry_insert["id"] == "e-0"     # hosted id preserved
    entry_sql = next(s for s, _ in db.conn.executed
                     if s.startswith("insert into public.news_entries"))
    assert "on conflict (id) do update" in entry_sql
    assert "enriched_text = case when" in entry_sql


def test_reset_clusters_wipes_topics_but_keeps_seed_categories():
    db = FakeDb()
    reset_clusters(db)
    statements = [s for s, _ in db.conn.executed]
    executed = " ; ".join(statements)
    assert "delete from public.topic_themes" in executed
    assert "delete from public.topic_categories where origin = 'llm'" in executed
    # FK: theme deletes must run after the storylines delete
    assert statements.index("delete from public.topic_themes") > \
        statements.index("delete from public.storylines")
