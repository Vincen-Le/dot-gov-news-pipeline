"""Integration: spine engine runs end-to-end through the real experiment CLI path.

Targets the dedicated simple_v1 pipeline database (SPINE_DB, defaulting to the
local simple_v1_db on port 57422) rather than the shared DATABASE_URL default,
so this test can run alongside other local pipeline databases without
clobbering their state.
"""

import os

import pytest

pytestmark = pytest.mark.integration

SPINE_DB = os.environ.get(
    "SPINE_DB", "postgresql://postgres:postgres@127.0.0.1:57422/simple_v1_db")


def test_spine_experiment_records_run(monkeypatch):
    monkeypatch.setenv("LAB_ENGINE", "spine")
    monkeypatch.setenv("DATABASE_URL", SPINE_DB)
    from pipeline.bench import assert_local_dsn
    from pipeline.cache import CachedModels, DecisionCache
    from pipeline.config import load_config
    from pipeline.db import Db
    from pipeline.experiment import run_experiment
    from pipeline.store import Store
    from pipeline.stub import StubModels

    cfg = load_config()
    assert cfg.engine == "spine"
    db = Db(cfg.database_url)
    assert_local_dsn(cfg.database_url)
    models = CachedModels(StubModels(), DecisionCache(".cache/test.sqlite"),
                          model_tag="stub")
    out = run_experiment(db, Store(db), models, cfg, "spine-smoke-stub",
                         limit=50)
    assert out["run_id"]
    row = db.one("select cluster_report from public.simple_v1_experiment_runs "
                 "where id = %(id)s::uuid", {"id": out["run_id"]})
    assert row["cluster_report"]["engine"] == "spine"
