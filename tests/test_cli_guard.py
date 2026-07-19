# tests/test_cli_guard.py
import sys

import pytest

from pipeline import cli


def _base_env(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "token")


def test_cli_refuses_remote_database_url(monkeypatch):
    _base_env(monkeypatch)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://corpus_reader:pw@aws-1-us-east-2.pooler.supabase.com:5432/postgres")
    monkeypatch.setattr(sys, "argv", ["pipeline", "reset", "--clusters"])
    with pytest.raises(RuntimeError, match="non-local database"):
        cli.main()


def test_cli_guard_runs_before_any_connection(monkeypatch):
    # The guard must fire before Db() attempts a connection: with a remote
    # DSN and no reachable database anywhere, the error is the guard's
    # RuntimeError, not a psycopg connection failure.
    _base_env(monkeypatch)
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql://u:p@db.example.supabase.co:5432/postgres")
    monkeypatch.setattr(sys, "argv", ["pipeline", "sync"])
    with pytest.raises(RuntimeError, match="non-local database"):
        cli.main()
