# pipeline/shared/bench.py
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
    info = conninfo_to_dict(dsn)
    # libpq connects via hostaddr when present, even if host looks local, so
    # both keys must be checked or a spoofed local host + remote hostaddr
    # bypasses the guard.
    for key in ("host", "hostaddr"):
        value = info.get(key)
        if value not in _LOCAL_HOSTS:
            raise RuntimeError(
                f"refusing to run bench tool against non-local database {key}: {value!r}")


def reset_clusters(db) -> None:
    """Wipe clustering decisions between experiments. Features and corpus survive."""
    assert_local_dsn(db.conn.info.dsn)
    db.conn.execute("update public.news_entries set episode_id = null "
                    "where episode_id is not null")
    db.conn.execute("update public.storylines set latest_card_id = null, merged_into = null")
    db.conn.execute("delete from public.episode_entries")
    db.conn.execute("delete from public.event_cards")
    db.conn.execute("delete from public.episodes")
    db.conn.execute("delete from public.storylines")
    db.conn.execute("delete from public.entity_stats")
    db.conn.execute("delete from public.topic_themes")
    db.conn.execute("delete from public.topic_categories where origin = 'llm'")


def reset_features(db) -> None:
    """Full wipe: decisions + per-entry features. Use when swapping models."""
    reset_clusters(db)
    db.conn.execute(
        "update public.news_entries set embedding = null, embedding_model = null, "
        "enriched_text = null, enricher_version = null, "
        "entity_set = '{}', event_keys = '{}', extractor_version = null")


_SOURCE_COLS = ("id", "canonical_url", "source_type", "title")
_PUBLISHER_COLS = ("news_source_id", "publisher_key")
_ENTRY_COLS = ("id", "news_source_id", "url", "url_canonical", "title", "summary",
               "body_text", "published_at", "fetched_at", "content_hash",
               "extractor_version")


def sync_corpus(db, supabase_url: str, secret_key: str, page: int = 1000,
                transport=None) -> dict:
    """Copy hosted corpus to local, preserving ids and refreshing changed rows."""
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

    response = http.get(
        f"{base}/news_source_publishers", params={
            "select": ",".join(_PUBLISHER_COLS),
            "news_source_id": f"in.({','.join(source_ids)})"})
    response.raise_for_status()
    publishers = response.json()

    def upsert(table: str, cols: tuple[str, ...], conflict_col: str,
               row: dict) -> None:
        placeholders = ", ".join(f"%({c})s" for c in cols)
        assignments = ", ".join(
            f"{c} = excluded.{c}" for c in cols if c != conflict_col)
        if table == "news_entries":
            content_changed = (
                "news_entries.content_hash is distinct from excluded.content_hash")
            assignments += (
                f", enriched_text = case when {content_changed} then null "
                "else news_entries.enriched_text end"
                f", enricher_version = case when {content_changed} then null "
                "else news_entries.enricher_version end"
                f", embedding = case when {content_changed} then null "
                "else news_entries.embedding end"
                f", embedding_model = case when {content_changed} then null "
                "else news_entries.embedding_model end"
                f", entity_set = case when {content_changed} then '{{}}'::text[] "
                "else news_entries.entity_set end"
                f", event_keys = case when {content_changed} then '{{}}'::text[] "
                "else news_entries.event_keys end")
        db.conn.execute(
            f"insert into public.{table} ({', '.join(cols)}) "
            f"values ({placeholders}) on conflict ({conflict_col}) do update set "
            f"{assignments}",
            {c: row.get(c) for c in cols})

    for source in sources:
        upsert("news_sources", _SOURCE_COLS, "id", source)
    for publisher in publishers:
        upsert("news_source_publishers", _PUBLISHER_COLS,
               "news_source_id", publisher)
    for entry in entries:
        upsert("news_entries", _ENTRY_COLS, "id", entry)
    return {
        "sources": len(sources),
        "publishers": len(publishers),
        "entries": len(entries),
    }
