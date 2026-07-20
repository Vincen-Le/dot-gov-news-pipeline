import os
from unittest import mock

import pytest

from pipeline.config import Config, load_config
from pipeline.experiment import _validate_engine


_REQUIRED = {"CLOUDFLARE_ACCOUNT_ID": "acct", "CLOUDFLARE_API_TOKEN": "tok"}


def test_spine_defaults():
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t")
    assert cfg.engine == "classic"
    assert cfg.spine_sim_floor == 0.60
    assert cfg.spine_top_k == 3
    assert cfg.spine_episode_gap_hours == 48.0
    assert cfg.spine_embed_source == "enriched"
    assert cfg.spine_theme_min_size == 4
    assert cfg.spine_theme_link_sim == 0.55
    assert cfg.spine_theme_sweep_interval_hours == 168.0
    assert cfg.spine_theme_keep_overlap == 0.5


def test_env_overrides():
    env = {**_REQUIRED, "LAB_ENGINE": "spine", "SPINE_TOP_K": "5",
           "SPINE_SIM_FLOOR": "0.7"}
    with mock.patch.dict(os.environ, env):
        cfg = load_config()
    assert cfg.engine == "spine"
    assert cfg.spine_top_k == 5
    assert cfg.spine_sim_floor == 0.7


def test_validate_engine_accepts_known_engines():
    _validate_engine(Config(database_url="x", cf_account_id="a", cf_api_token="t",
                            engine="classic"))
    _validate_engine(Config(database_url="x", cf_account_id="a", cf_api_token="t",
                            engine="spine"))


def test_validate_engine_rejects_unknown_engine():
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t",
                engine="spien")
    with pytest.raises(ValueError, match="unknown engine: 'spien'"):
        _validate_engine(cfg)
