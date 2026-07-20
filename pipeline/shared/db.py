from __future__ import annotations

from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


class Db:
    """Thin Postgres access: raw reads + named-arg RPC calls. All writes go through RPCs."""

    def __init__(self, dsn: str) -> None:
        self.conn = psycopg.connect(dsn, row_factory=dict_row, autocommit=True)

    def rpc(self, fn: str, **kwargs: Any) -> Any:
        args = ", ".join(f"{k} => %({k})s" for k in kwargs)
        with self.conn.cursor() as cur:
            cur.execute(f"select public.{fn}({args}) as result", kwargs)
            row = cur.fetchone()
            return row["result"] if row else None

    def rpc_row(self, fn: str, **kwargs: Any) -> dict | None:
        args = ", ".join(f"{k} => %({k})s" for k in kwargs)
        with self.conn.cursor() as cur:
            cur.execute(f"select * from public.{fn}({args})", kwargs)
            return cur.fetchone()

    def all(self, sql: str, params: dict | tuple | None = None) -> list[dict]:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    def one(self, sql: str, params: dict | tuple | None = None) -> dict | None:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    @staticmethod
    def jsonb(value: Any) -> Jsonb:
        return Jsonb(value)
