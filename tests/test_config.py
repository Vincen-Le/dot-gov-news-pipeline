from pipeline.config import Config, load_config


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


def test_topics_config_defaults_off():
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t")
    assert cfg.topics_enabled is False
    assert cfg.theme_sim_floor == 0.55
    assert cfg.theme_promotion_min_storylines == 4
    assert cfg.theme_promotion_min_active_days == 3
    assert cfg.theme_promotion_cohesion_floor == 0.55
    assert cfg.theme_promotion_cluster_floor == 0.60
    assert cfg.theme_demotion_cohesion_floor == 0.40
    assert cfg.theme_sweep_interval_hours == 24.0


def test_theme_promotion_overrides(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "tok")
    monkeypatch.setenv("THEME_PROMOTION_MIN_STORYLINES", "7")
    monkeypatch.setenv("THEME_PROMOTION_MIN_ACTIVE_DAYS", "5")
    monkeypatch.setenv("THEME_PROMOTION_COHESION_FLOOR", "0.61")
    monkeypatch.setenv("THEME_PROMOTION_CLUSTER_FLOOR", "0.67")
    monkeypatch.setenv("THEME_DEMOTION_COHESION_FLOOR", "0.35")
    monkeypatch.setenv("THEME_SWEEP_INTERVAL_HOURS", "12")
    cfg = load_config()
    assert cfg.theme_promotion_min_storylines == 7
    assert cfg.theme_promotion_min_active_days == 5
    assert cfg.theme_promotion_cohesion_floor == 0.61
    assert cfg.theme_promotion_cluster_floor == 0.67
    assert cfg.theme_demotion_cohesion_floor == 0.35
    assert cfg.theme_sweep_interval_hours == 12.0
