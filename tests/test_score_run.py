import importlib.util
import json
from pathlib import Path

import pipeline.db

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "eval" / "score_run.py"
spec = importlib.util.spec_from_file_location("score_run", SCRIPT)
score_run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(score_run)


def write(path: Path, text: str) -> None:
    path.write_text(text.strip() + "\n")


def test_score_end_to_end_from_fixture_csvs(tmp_path):
    verdicts = tmp_path / "verdicts"
    artifacts = tmp_path / "artifacts"
    verdicts.mkdir()
    artifacts.mkdir()

    write(verdicts / "chain-verdicts.csv",
          "storyline_id,episode_id,related,attach_method,reason\n"
          "s1,e2,y,event_key,ok\ns1,e3,y,entity,ok")
    write(verdicts / "chain-summary.csv",
          "storyline_id,endpoints_related,chain_verdict,reason\n"
          "s1,n,drifted,wandered")
    write(verdicts / "theme-verdicts.csv",
          "theme_id,storyline_id,fits,reason\n"
          "t1,m1,y,ok\nt1,m2,y,ok\nt1,x1,n,intruder rejected")
    write(verdicts / "theme-granularity.csv",
          "theme_id,granularity,probe_label,members_gained,reason\n"
          "t1,right,,0,ok")
    write(verdicts / "category-verdicts.csv",
          "storyline_id,theme_id,filed_category,verdict,suggested_category,reason\n"
          "m1,t1,Health,correct,,ok")
    write(verdicts / "granularity-merge-verdicts.csv",
          "theme_a_id,theme_b_id,should_merge,reason\nt1,t2,n,distinct")
    write(verdicts / "entity-verdicts.csv",
          "entry_id,kind,token,valid,reason\n"
          "n1,entity,fda,y,salient\nn1,event_key,DOC-123,y,real")
    write(verdicts / "entity-stats-verdicts.csv",
          "entity,valid,reason\nhealth,n,generic")
    write(verdicts / "entity-misses.csv", "entry_id,missed_entity\nn1,valsatrex")
    write(verdicts / "episode-verdicts.csv",
          "episode_id,entry_id,same_event,reason\ne1,n2,y,mirror")
    write(verdicts / "overview-verdicts.csv",
          "storyline_id,coverage,faithful,current,representative,reason\n"
          "s1,y,y,y,y,ok")

    (artifacts / "intruder-truth.json").write_text(
        json.dumps([{"theme_id": "t1", "storyline_id": "x1"}]))
    (artifacts / "v4.json").write_text(
        json.dumps({"structural_stats": {"singleton_theme_rate": 0.0}}))
    (artifacts / "v5.json").write_text(json.dumps({"sampled_entries": [{}] * 10}))

    result = score_run.score(verdicts, artifacts)
    # drift charged the last link: (1 - 2) / 2
    assert result["v1_score"] == -0.5
    assert result["drift_rate"] == 1.0
    # 2 fits, intruder rejected: (2 - 0) / 3
    assert result["v2_score"] == 2 / 3
    assert result["v2_discrimination"] == 1.0
    assert result["v7_score"] == 1.0
    assert result["v5_entity_precision"] == 0.5
    assert result["v5_entity_stats_n"] == 1
    assert result["v4_merge_pairs"] == 0
    assert result["validity"]["v2_weak"] is False
    assert result["recall"]["note"] == "n/a (no gold labels)"
    expected = (-0.5 + 2 / 3 + 1.0 + 0.5 + 1.0 + 1.0) / 6
    assert abs(result["reward_v2"] - expected) < 1e-9


def test_write_reward_targets_selected_pipeline_namespace(monkeypatch):
    calls = {}

    class FakeConn:
        def commit(self):
            calls["committed"] = True

    class FakeDb:
        def __init__(self, dsn):
            calls["dsn"] = dsn
            self.conn = FakeConn()

        def one(self, sql, params):
            calls["sql"] = sql
            calls["params"] = params
            return {"id": "run-id"}

        def rpc(self, name, **kwargs):
            calls["rpc"] = name
            calls["rpc_args"] = kwargs

        @staticmethod
        def jsonb(value):
            return value

    monkeypatch.setattr(pipeline.db, "Db", FakeDb)
    monkeypatch.setenv("DATABASE_URL", "postgresql://local/test")
    result = {
        "reward_v2": 0.75,
        "validity": {"v2_weak": False},
        "v1_score": 1.0,
        "v2_score": 1.0,
        "v3_score": 1.0,
        "v5_entity_precision": 1.0,
        "v6_score": 1.0,
        "v7_score": 1.0,
        "v4_merge_pairs": 0,
    }

    score_run.write_reward("00000000-0000-4000-8000-000000000001", result,
                           True, "simple_v1")

    assert "public.simple_v1_experiment_runs" in calls["sql"]
    assert calls["params"] == {
        "id": "00000000-0000-4000-8000-000000000001"
    }
    assert calls["rpc"] == "simple_v1_annotate_experiment_cluster_snapshot"
    assert calls["rpc_args"]["p_run_id"] == "run-id"
    assert calls["committed"] is True
