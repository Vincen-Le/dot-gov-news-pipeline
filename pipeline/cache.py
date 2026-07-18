"""Content-keyed memo for adjudicator decisions.

Keys are sha256 over (model_tag, a, b, context) — pure content, never row ids
(ids regenerate on every experiment reset). Temperature-0 adjudication is
deterministic, so a cached verdict is exactly what the model would return;
repeat experiments only pay for decisions the config change actually altered.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from typing import Any


class DecisionCache:
    def __init__(self, path: str) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.execute(
            "create table if not exists adjudications ("
            "key text primary key, same integer not null, reason text not null)")
        self.conn.commit()

    def get(self, key: str) -> tuple[bool, str] | None:
        row = self.conn.execute(
            "select same, reason from adjudications where key = ?", (key,)).fetchone()
        return (bool(row[0]), row[1]) if row else None

    def put(self, key: str, same: bool, reason: str) -> None:
        self.conn.execute(
            "insert or replace into adjudications (key, same, reason) values (?, ?, ?)",
            (key, int(same), reason))
        self.conn.commit()


class CachedModels:
    """ModelClient wrapper: memoizes adjudicate_same_event, delegates the rest."""

    def __init__(self, inner: Any, cache: DecisionCache, model_tag: str) -> None:
        self.inner = inner
        self.cache = cache
        self.model_tag = model_tag
        self.hits = 0
        self.misses = 0

    def adjudicate_same_event(self, a: dict, b: dict, context: str) -> tuple[bool, str]:
        key = hashlib.sha256(
            json.dumps([self.model_tag, a, b, context], sort_keys=True, default=str)
            .encode()).hexdigest()
        cached = self.cache.get(key)
        if cached is not None:
            self.hits += 1
            return cached
        self.misses += 1
        same, reason = self.inner.adjudicate_same_event(a, b, context)
        if not reason.startswith("adjudicator_error"):  # never cache transient failures
            self.cache.put(key, same, reason)
        return same, reason

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)
