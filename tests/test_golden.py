import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from pipeline.shared.config import Config
from pipeline.shared.db import Db
from pipeline.golden import (
    GoldenValidationError,
    _one_parent_errors,
    _required_label_errors,
    _resolve_source_run_id,
    apply_reviewed,
    approve_batch,
    export_jsonl,
    initialize,
    promote_clustered,
    run_batch,
    status,
    validate,
)
from pipeline.shared.stub import StubModels
from pipeline.shared.store import Store
from pipeline.shared.vectors import pack_fp16


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


class _SourceRunDb:
    def __init__(self, rows):
        self.rows = rows
        self.params = None

    def all(self, _sql, params):
        self.params = params
        return self.rows


def test_source_run_is_inferred_only_when_unique():
    db = _SourceRunDb([{"source_run_id": "run-1"}])

    assert _resolve_source_run_id(db) == "run-1"
    assert db.params == {"requested": None}


def test_requested_source_run_must_match_current_cards():
    db = _SourceRunDb([])

    with pytest.raises(GoldenValidationError, match="does not exactly match"):
        _resolve_source_run_id(db, "00000000-0000-4000-8000-000000000001")


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


@pytest.mark.integration
def test_promote_refreshes_derived_labels_of_reviewed_rows(monkeypatch):
    """A storyline evolves across slices: its overview headline changes and a
    theme is minted after slice 1 was reviewed. Promote must refresh the
    derived fields of reviewed rows from the live surface instead of failing
    one-parent validation against the stale labels."""
    import pipeline.golden as golden_mod

    db = Db(os.environ["DATABASE_URL"])
    run_id = uuid.uuid4()
    monkeypatch.setattr(golden_mod, "_resolve_source_run_id",
                        lambda db, requested=None: run_id)

    source_id = uuid.uuid4()
    storyline_id = uuid.uuid4()
    theme_id = uuid.uuid4()
    episode_ids = [uuid.uuid4(), uuid.uuid4()]
    entry_ids = [uuid.uuid4(), uuid.uuid4()]
    content_hash = hashlib.sha256(b"promote-refresh").hexdigest()
    start = datetime(2030, 2, 1, tzinfo=timezone.utc)

    with db.conn.transaction(force_rollback=True):
        db.conn.execute("delete from public.golden_news_entries")
        category_id = db.conn.execute(
            "select id from public.topic_categories where origin='seed' limit 1"
        ).fetchone()["id"]
        db.conn.execute(
            "insert into public.simple_v1_experiment_runs (id, name, started_at, "
            "finished_at, config, cluster_report, summary) "
            "values (%(id)s, 'promote-refresh-fixture', now(), now(), '{}', '{}', '{}')",
            {"id": run_id})
        db.conn.execute(
            "insert into public.news_sources (id, canonical_url, source_type, title) "
            "values (%(id)s, %(url)s, 'rss', 'Golden fixture')",
            {"id": source_id, "url": f"https://golden-{source_id}.gov/feed"})
        db.conn.execute(
            "insert into public.news_source_publishers (news_source_id, publisher_key) "
            "values (%(id)s, 'golden-fixture')", {"id": source_id})
        db.conn.execute(
            "insert into public.topic_themes (id, display_name, inclusion_criterion, category_id) "
            "values (%(id)s, 'Fixture Theme', 'fixture', %(cat)s)",
            {"id": theme_id, "cat": category_id})
        db.conn.execute(
            "insert into public.storylines (id, entry_count, episode_count, "
            "first_entry_at, newest_entry_at, theme_id, category_id, category_method) "
            "values (%(id)s, 2, 2, %(t)s, %(t)s, %(theme)s, %(cat)s, 'classified')",
            {"id": storyline_id, "t": start, "theme": theme_id, "cat": category_id})
        for index, (episode_id, entry_id) in enumerate(zip(episode_ids, entry_ids)):
            db.conn.execute(
                "insert into public.episodes (id, storyline_id, status, entry_count, "
                "first_entry_at, newest_entry_at, attach_method) "
                "values (%(id)s, %(sl)s, 'dormant', 1, %(t)s, %(t)s, 'new_storyline')",
                {"id": episode_id, "sl": storyline_id,
                 "t": start + timedelta(hours=index)})
            db.conn.execute(
                """
                insert into public.news_entries (
                    id, news_source_id, url, url_canonical, title, summary,
                    published_at, content_hash, embedding, embedding_model,
                    entity_set, event_keys, extractor_version, episode_id
                ) values (
                    %(id)s, %(source)s, %(url)s, %(url)s, %(title)s, %(title)s,
                    %(published)s, %(hash)s, %(embedding)s, 'stub-bow-256',
                    '{}', '{}', 1, %(episode)s
                )
                """,
                {"id": entry_id, "source": source_id,
                 "url": f"https://golden-{source_id}.gov/{index}",
                 "title": f"Fixture entry {index}",
                 "published": start + timedelta(hours=index),
                 "hash": content_hash, "embedding": b"vector",
                 "episode": episode_id})
        db.conn.execute(
            "insert into public.event_cards (id, storyline_id, kind, version, "
            "headline, summary, newest_entry_at, rank_key) "
            "values (%(id)s, %(sl)s, 'overview', 2, 'New overview headline', "
            "'sum', %(t)s, 0)",
            {"id": uuid.uuid4(), "sl": storyline_id, "t": start})
        # slice-1 row: reviewed with the stale label and no theme yet
        db.conn.execute(
            """
            insert into public.golden_news_entries (
                news_entry_id, content_hash_at_review, ordinal, batch_number,
                review_status, gold_episode_id, gold_episode_label,
                gold_storyline_id, gold_storyline_label, gold_category_id,
                reviewed_at
            ) values (
                %(entry)s, %(hash)s, 1, 1, 'reviewed', %(episode)s,
                'Fixture entry 0', %(sl)s, 'Stale overview headline',
                %(cat)s, now()
            )
            """,
            {"entry": entry_ids[0], "hash": content_hash,
             "episode": episode_ids[0], "sl": storyline_id, "cat": category_id})
        # slice-2 row: pending review
        db.conn.execute(
            "insert into public.golden_news_entries (news_entry_id, "
            "content_hash_at_review, ordinal, batch_number, review_status) "
            "values (%(entry)s, %(hash)s, 2, 1, 'pending')",
            {"entry": entry_ids[1], "hash": content_hash})

        out = promote_clustered(db)

        assert out["promoted"] >= 1
        rows = db.all(
            "select news_entry_id, review_status, gold_storyline_label, "
            "gold_theme_id, gold_theme_name from public.golden_news_entries "
            "where news_entry_id = any(%(ids)s) order by ordinal",
            {"ids": entry_ids})
        reviewed, promoted = rows
        assert reviewed["review_status"] == "reviewed"
        assert reviewed["gold_storyline_label"] == "New overview headline"
        assert reviewed["gold_theme_id"] == theme_id
        assert reviewed["gold_theme_name"] == "Fixture Theme"
        assert promoted["review_status"] == "reviewed"
        assert promoted["gold_storyline_label"] == "New overview headline"
