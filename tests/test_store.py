import pytest

from pipeline.store import Store


class ReadDb:
    def __init__(self, rows):
        self.rows = rows
        self.sql = ""

    def all(self, sql, _params=None):
        self.sql = " ".join(sql.split())
        return self.rows


def test_unprocessed_entries_uses_curated_publisher_key_as_agency():
    db = ReadDb([{"id": "entry-1", "agency": "fda"}])

    rows = Store(db).unprocessed_entries()

    assert rows[0]["agency"] == "fda"
    assert "news_source_publishers" in db.sql
    assert "split_part" not in db.sql


def test_unprocessed_entries_rejects_missing_publisher_attribution():
    db = ReadDb([{"id": "entry-1", "agency": None}])

    with pytest.raises(RuntimeError, match="publisher attribution"):
        Store(db).unprocessed_entries()
