# pipeline/bench.py
"""Lab-bench tools: experiment resets and hosted->local corpus sync.

Direct SQL by design (the RPC-only rule protects the production write path;
these are local tooling) — therefore hard-guarded to localhost DSNs.
"""

from __future__ import annotations

import httpx
from psycopg.conninfo import conninfo_to_dict

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "", None}


def assert_local_dsn(dsn: str) -> None:
    # Db.conn.info.dsn comes back as libpq keyword=value ("host=127.0.0.1 ..."),
    # not a URI, so parse with psycopg's own conninfo parser (handles both forms)
    # rather than urlsplit, which mis-reads keyword=value strings as an opaque host.
    host = conninfo_to_dict(dsn).get("host")
    if host not in _LOCAL_HOSTS:
        raise RuntimeError(
            f"refusing to run bench tool against non-local database host: {host!r}")


def reset_clusters(db) -> None:
    """Wipe clustering decisions between experiments. Features survive."""
    assert_local_dsn(db.conn.info.dsn)
    db.conn.execute(
        "truncate public.event_cards, public.episode_entries, public.episodes, "
        "public.storylines, public.entity_stats cascade")
    db.conn.execute("update public.news_entries set episode_id = null "
                    "where episode_id is not null")


def reset_features(db) -> None:
    """Full wipe: decisions + per-entry features. Use when swapping models."""
    reset_clusters(db)
    db.conn.execute(
        "update public.news_entries set embedding = null, embedding_model = null, "
        "enriched_text = null, enricher_version = null, "
        "entity_set = '{}', event_keys = '{}', extractor_version = null")


_SOURCE_COLS = ("id", "canonical_url", "source_type", "title")
_ENTRY_COLS = ("id", "news_source_id", "url", "url_canonical", "title", "summary",
               "published_at", "fetched_at", "content_hash", "extractor_version")


def sync_corpus(db, supabase_url: str, secret_key: str, page: int = 1000,
                transport=None) -> dict:
    """Copy hosted corpus to local, preserving ids. Rerun-safe (conflict-skips)."""
    assert_local_dsn(db.conn.info.dsn)
    base = supabase_url.rstrip("/") + "/rest/v1"
    http = httpx.Client(
        headers={"apikey": secret_key, "Authorization": f"Bearer {secret_key}"},
        timeout=60, transport=transport)

    entries: list[dict] = []
    offset = 0
    while True:
        response = http.get(
            f"{base}/news_entries", params={
                "select": ",".join(_ENTRY_COLS),
                "order": "published_at.asc,id.asc",
                "offset": offset, "limit": page})
        response.raise_for_status()
        batch = response.json()
        entries.extend(batch)
        if len(batch) < page:
            break
        offset += page

    source_ids = sorted({e["news_source_id"] for e in entries})
    response = http.get(
        f"{base}/news_sources", params={
            "select": ",".join(_SOURCE_COLS),
            "id": f"in.({','.join(source_ids)})"})
    response.raise_for_status()
    sources = response.json()

    def insert(table: str, cols: tuple[str, ...], row: dict) -> None:
        placeholders = ", ".join(f"%({c})s" for c in cols)
        db.conn.execute(
            f"insert into public.{table} ({', '.join(cols)}) "
            f"values ({placeholders}) on conflict do nothing",
            {c: row.get(c) for c in cols})

    for source in sources:
        insert("news_sources", _SOURCE_COLS, source)
    skipped = 0
    for entry in entries:
        insert("news_entries", _ENTRY_COLS, entry)
    return {"sources": len(sources), "entries": len(entries), "skipped": skipped}
