# tests/test_hosted.py
import json

import pytest

from pipeline.hosted import load_hosted


def _write(tmp_path, url="https://x.supabase.co", key="sb_publishable_abc"):
    path = tmp_path / "hosted.json"
    path.write_text(json.dumps({"supabaseUrl": url, "publishableKey": key}))
    return path


def test_load_hosted_reads_checked_in_config(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_PUBLISHABLE_KEY", raising=False)
    url, key = load_hosted(_write(tmp_path))
    assert url == "https://x.supabase.co"
    assert key == "sb_publishable_abc"


def test_env_overrides_win(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://other.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_env")
    url, key = load_hosted(_write(tmp_path))
    assert url == "https://other.supabase.co"
    assert key == "sb_publishable_env"


def test_placeholder_key_rejected(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_PUBLISHABLE_KEY", raising=False)
    with pytest.raises(RuntimeError, match="publishable key not configured"):
        load_hosted(_write(tmp_path, key="REPLACE_WITH_SB_PUBLISHABLE_KEY"))


def test_default_path_points_at_repo_config():
    from pipeline.hosted import _DEFAULT_PATH
    assert _DEFAULT_PATH.name == "hosted.json"
    assert _DEFAULT_PATH.parent.name == "config"
    assert _DEFAULT_PATH.exists()
