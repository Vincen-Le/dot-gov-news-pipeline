# tests/test_bench.py
import json

import httpx
import pytest

from pipeline.bench import assert_local_dsn, reset_clusters, sync_corpus


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
    sql = " ; ".join(s for s, _ in db.conn.executed)
    assert "truncate" in sql and "episode_entries" in sql and "entity_stats" in sql
    assert "set episode_id = null" in sql
    assert "embedding" not in sql          # features untouched


def test_reset_refuses_remote_dsn():
    with pytest.raises(RuntimeError):
        reset_clusters(FakeDb("postgresql://u:p@db.example.supabase.co/postgres"))


def test_sync_copies_pages_and_preserves_ids():
    sources = [{"id": "s-1", "canonical_url": "https://fda.gov/f.xml",
                "source_type": "rss", "title": None}]
    page1 = [{"id": f"e-{i}", "news_source_id": "s-1", "url": f"https://fda.gov/{i}",
              "url_canonical": f"https://fda.gov/{i}", "title": f"t{i}", "summary": "s",
              "published_at": "2026-05-14T14:00:00+00:00",
              "fetched_at": "2026-05-14T14:00:00+00:00",
              "content_hash": "ab" * 32, "extractor_version": 1} for i in range(2)]

    def handler(request):
        if "news_sources" in str(request.url):
            return httpx.Response(200, json=sources)
        offset = int(dict(request.url.params)["offset"])
        return httpx.Response(200, json=page1 if offset == 0 else [])

    db = FakeDb()
    report = sync_corpus(db, "https://x.supabase.co", "key",
                         page=1000, transport=httpx.MockTransport(handler))
    assert report["sources"] == 1 and report["entries"] == 2
    inserts = [s for s, _ in db.conn.executed if s.startswith("insert")]
    assert any("news_sources" in s for s in inserts)
    entry_insert = next(p for s, p in db.conn.executed
                        if s.startswith("insert into public.news_entries"))
    assert entry_insert["id"] == "e-0"     # hosted id preserved
