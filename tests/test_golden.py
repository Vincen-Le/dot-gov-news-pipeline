import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from pipeline.config import Config
from pipeline.db import Db
from pipeline.golden import (
    _one_parent_errors,
    _required_label_errors,
    apply_reviewed,
    approve_batch,
    export_jsonl,
    initialize,
    run_batch,
    status,
    validate,
)
from pipeline.stub import StubModels
from pipeline.store import Store
from pipeline.vectors import pack_fp16


def complete_row(**overrides):
    row = {
        "news_entry_id": "entry-1",
        "content_hash": "a" * 64,
        "content_hash_at_review": "a" * 64,
        "agency": "epa",
        "embedding": b"vector",
        "category_origin": "seed",
        "gold_episode_id": "episode-1",
        "gold_episode_label": "Episode one",
        "gold_storyline_id": "storyline-1",
        "gold_storyline_label": "Storyline one",
        "gold_theme_id": "theme-1",
        "gold_theme_name": "Theme one",
        "gold_category_id": "category-1",
    }
    row.update(overrides)
    return row


def test_required_labels_reject_stale_content_and_unseeded_category():
    errors = _required_label_errors([
        complete_row(
            content_hash="b" * 64,
            category_origin="llm",
            gold_theme_id=None,
        )
    ])

    assert any("gold_theme_id" in error for error in errors)
    assert any("content hash changed" in error for error in errors)
    assert any("seeded category" in error for error in errors)


def test_hierarchy_validation_requires_one_parent_per_group():
    errors = _one_parent_errors([
        complete_row(),
        complete_row(news_entry_id="entry-2", gold_storyline_id="storyline-2"),
    ])

    assert any("episode episode-1 maps to 2" in error for error in errors)


def test_validation_rejects_an_uninitialized_anchor(monkeypatch):
    monkeypatch.setattr(
        "pipeline.golden.status",
        lambda _db: {"total": 0, "reviewed": 0},
    )
    monkeypatch.setattr("pipeline.golden._labeled_rows", lambda _db: [])

    result = validate(None, complete=True)

    assert result["valid"] is False
    assert result["complete"] is False
    assert result["errors"] == ["golden dataset has not been initialized"]


@pytest.mark.integration
def test_golden_batches_rebuild_reviewed_state_and_restore_dedupe_window(tmp_path):
    db = Db(os.environ["DATABASE_URL"])
    store = Store(db)
    models = StubModels()
    cfg = Config(
        database_url=os.environ["DATABASE_URL"],
        cf_account_id="test",
        cf_api_token="test",
        topics_enabled=True,
    )
    start = datetime(2030, 1, 1, tzinfo=timezone.utc)
    source_id = uuid.uuid4()
    entry_ids = [uuid.uuid4() for _ in range(3)]
    urls = [f"https://golden-{source_id}.gov/{index}" for index in range(3)]
    titles = ["Alpha enforcement action", "Beta watershed grant", "Alpha follow-up"]
    entities = [["alpha-case"], ["beta-river"], ["different-surface-form"]]
    hashes = [hashlib.sha256(b"same-event").hexdigest(),
              hashlib.sha256(b"other-event").hexdigest(),
              hashlib.sha256(b"same-event").hexdigest()]
    vectors = models.embed(titles)

    with db.conn.transaction(force_rollback=True):
        db.conn.execute("delete from public.golden_news_entries")
        db.conn.execute(
            "insert into public.news_sources (id, canonical_url, source_type, title) "
            "values (%(id)s, %(url)s, 'rss', 'Golden fixture')",
            {"id": source_id, "url": f"https://golden-{source_id}.gov/feed"},
        )
        db.conn.execute(
            "insert into public.news_source_publishers (news_source_id, publisher_key) "
            "values (%(id)s, 'golden-fixture')",
            {"id": source_id},
        )
        for index, entry_id in enumerate(entry_ids):
            db.conn.execute(
                """
                insert into public.news_entries (
                    id, news_source_id, url, url_canonical, title, summary,
                    published_at, content_hash, embedding, embedding_model,
                    entity_set, event_keys, extractor_version
                ) values (
                    %(id)s, %(source)s, %(url)s, %(url)s, %(title)s, %(summary)s,
                    %(published)s, %(hash)s, %(embedding)s, 'stub-bow-256',
                    %(entities)s, '{}', 1
                )
                """,
                {"id": entry_id, "source": source_id, "url": urls[index],
                 "title": titles[index], "summary": titles[index],
                 "published": start + timedelta(hours=index),
                 "hash": hashes[index], "embedding": pack_fp16(vectors[index]),
                 "entities": entities[index]},
            )

        initialized = initialize(
            db, start=start, before=start + timedelta(days=1), batch_size=2)
        assert initialized["total"] == 3
        assert initialized["batches"] == 2

        first = run_batch(db, store, models, cfg, 1)
        assert first["proposal"]["captured"] == 2
        assert status(db)["proposed"] == 2
        preview = apply_reviewed(db, cfg, include_proposed=True)
        assert preview["materialized_entries"] == 2
        assert preview["included_proposed"] is True
        # Both fixture episodes are still open at the pause. Preview creates
        # storyline overview cards; immutable episode cards wait for close.
        assert db.one("select count(*)::integer as n from public.event_cards")["n"] == 2
        assert approve_batch(db, 1)["reviewed"] == 2

        applied = apply_reviewed(db, cfg)
        assert applied["materialized_entries"] == 2
        first_episode = db.one(
            "select gold_episode_id from public.golden_news_entries "
            "where news_entry_id = %(id)s",
            {"id": entry_ids[0]},
        )["gold_episode_id"]

        second = run_batch(db, store, models, cfg, 2)
        assert second["proposal"]["captured"] == 1
        third_episode = db.one(
            "select gold_episode_id from public.golden_news_entries "
            "where news_entry_id = %(id)s",
            {"id": entry_ids[2]},
        )["gold_episode_id"]
        assert third_episode == first_episode

        assert approve_batch(db, 2)["reviewed"] == 1
        result = validate(db, complete=True)
        assert result["valid"] is True
        assert result["complete"] is True

        exported = export_jsonl(db, str(tmp_path / "golden.jsonl"))
        assert exported["exported"] == 3
        assert len((tmp_path / "golden.jsonl").read_text().splitlines()) == 3
