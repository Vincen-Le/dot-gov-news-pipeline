from pipeline.config import Config
from pipeline.experiment import render_report

CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


def test_render_report_contains_config_stats_and_chains():
    summary = {
        "entries_clustered": 1000, "episodes": 420, "storylines": 380, "cards": 460,
        "entry_attach_mix": {"new_cluster": 380, "content_hash": 40},
        "episode_attach_mix": {"new_storyline": 380, "event_key": 25},
        "singleton_episode_rate": 0.62,
        "multi_episode_storylines": 31,
        "top_chains": [{"episodes": 4, "headline": "Valsatrex recall widens"}],
        "topics": {"themes": 12, "categories_seed": 23, "categories_llm": 1,
                   "theme_attach_mix": {"adjudicated_join": 8, "new_theme": 12},
                   "top_themes": [{"theme": "Valsatrex recall fallout",
                                   "category": "Food & Drug Safety",
                                   "storylines": 3}],
                   "singleton_theme_rate": 0.4},
        "llm_health": {"overview_fallback_rate": 0.02, "uncategorized_themes": 1,
                       "unthemed_storylines": 2,
                       "theme_creator_errors": 0,
                       "model_errors": {"theme_creator": 2}},
    }
    report = render_report(
        "baseline", CFG, {
            "processed": 1000,
            "episodes_closed": 420,
            "input_topology": {
                "label_set_id": "labels-1",
                "seed": "run-7",
                "requested_multi_episode_percent": 40,
                "requested_multi_entry_single_episode_percent": 20,
                "actual_entry_counts": {
                    "multi_episode_storyline": 400,
                    "multi_entry_single_episode": 200,
                    "singleton_episode_storyline": 400,
                },
                "actual_multi_entry_episode_entries": 230,
            },
        },
        summary, {"hits": 12, "misses": 3}, duration_s=42.5)
    assert "# Experiment: baseline" in report
    assert '"near_dup_threshold": 0.9' in report        # full config snapshot embedded
    assert "content_hash: 40" in report
    assert "Valsatrex recall widens" in report
    assert "cache 12 hits / 3 misses" in report
    assert "42.5s" in report
    assert "## Input topology curation" in report
    assert "requested multi-episode entry share: 40%" in report
    assert "labels-1" in report


def test_render_report_empty_run():
    report = render_report("empty", CFG, {"processed": 0, "episodes_closed": 0},
                           {"entries_clustered": 0, "episodes": 0, "storylines": 0,
                            "cards": 0, "entry_attach_mix": {}, "episode_attach_mix": {},
                            "singleton_episode_rate": None,
                            "multi_episode_storylines": 0, "top_chains": [],
                            "topics": {"themes": 0, "categories_seed": 23,
                                       "categories_llm": 0, "theme_attach_mix": {},
                                       "top_themes": [],
                                       "singleton_theme_rate": None},
                            "llm_health": {"overview_fallback_rate": None,
                                           "uncategorized_themes": 0,
                                           "unthemed_storylines": 0,
                                           "theme_creator_errors": 0}},
                           {"hits": 0, "misses": 0}, duration_s=0.1)
    assert "# Experiment: empty" in report


def test_record_run_inserts_redacted_config():
    from pipeline.experiment import record_run

    class RecordingConn:
        def __init__(self):
            self.executed = []
            class Info:  # local DSN so nothing guards against it
                dsn = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
            self.info = Info()

        def execute(self, sql, params=None):
            self.executed.append((" ".join(sql.split()), params))
            class Cursor:
                def fetchone(_self):
                    return {"id": "run-1"}
            return Cursor()

    class RecordingDb:
        def __init__(self):
            self.conn = RecordingConn()

    from datetime import datetime, timezone
    t = datetime(2026, 5, 14, tzinfo=timezone.utc)
    db = RecordingDb()
    run_id = record_run(db, "baseline", CFG, {"processed": 10, "episodes_closed": 4},
                        {"episodes": 4}, {"hits": 1, "misses": 2}, t, t)
    assert run_id == "run-1"
    sql, params = db.conn.executed[0]
    assert sql.startswith("insert into public.experiment_runs")
    assert "cf_api_token" not in params["config"]
    assert '"near_dup_threshold": 0.9' in params["config"]


def make_summary_db():
    class FakeSummaryDb:
        def one(self, sql):
            s = " ".join(sql.split())
            if "entries_clustered" in s:
                return {"entries_clustered": 0, "episodes": 0,
                        "storylines": 0, "cards": 0}
            if "categories_seed" in s:
                return {"themes": 0, "categories_seed": 23, "categories_llm": 0}
            if "avg((entry_count = 1)" in s:
                return {"rate": None}
            if "avg((storyline_count = 1)" in s:
                return {"rate": None}
            if "episode_count >= 2" in s:
                return {"n": 0}
            if "compressor_error" in s:
                return {"rate": None}
            if "theme_creator_error" in s:
                return {"n": 0}
            if "theme_id is null" in s:
                return {"n": 0}
            if "category_id is null" in s:
                return {"n": 0}
            raise AssertionError(f"unexpected db.one: {s}")

        def all(self, sql):
            return []

    return FakeSummaryDb()


def test_summary_includes_topics_section():
    from pipeline.experiment import summarize

    summary = summarize(make_summary_db())
    assert "topics" in summary
    for key in ("themes", "categories_seed", "categories_llm",
                "theme_attach_mix", "top_themes", "singleton_theme_rate"):
        assert key in summary["topics"]


def test_summary_reports_llm_health():
    from pipeline.experiment import summarize

    summary = summarize(make_summary_db())
    health = summary["llm_health"]
    for key in ("overview_fallback_rate", "uncategorized_themes",
                "unthemed_storylines", "theme_creator_errors"):
        assert key in health
