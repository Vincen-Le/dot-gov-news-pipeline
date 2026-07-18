from pipeline.config import load_config


def test_defaults(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "tok")
    cfg = load_config()
    assert cfg.embedding_model == "@cf/baai/bge-m3"
    assert cfg.near_dup_threshold == 0.90
    assert cfg.episode_dormancy_hours == 4.0
    assert cfg.enrichment_enabled is True


def test_overrides(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "tok")
    monkeypatch.setenv("NEAR_DUP_THRESHOLD", "0.87")
    monkeypatch.setenv("ENRICHMENT_ENABLED", "false")
    cfg = load_config()
    assert cfg.near_dup_threshold == 0.87
    assert cfg.enrichment_enabled is False
