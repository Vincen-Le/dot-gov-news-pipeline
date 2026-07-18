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
    }
    report = render_report(
        "baseline", CFG, {"processed": 1000, "episodes_closed": 420},
        summary, {"hits": 12, "misses": 3}, duration_s=42.5)
    assert "# Experiment: baseline" in report
    assert '"near_dup_threshold": 0.9' in report        # full config snapshot embedded
    assert "content_hash: 40" in report
    assert "Valsatrex recall widens" in report
    assert "cache 12 hits / 3 misses" in report
    assert "42.5s" in report


def test_render_report_empty_run():
    report = render_report("empty", CFG, {"processed": 0, "episodes_closed": 0},
                           {"entries_clustered": 0, "episodes": 0, "storylines": 0,
                            "cards": 0, "entry_attach_mix": {}, "episode_attach_mix": {},
                            "singleton_episode_rate": None,
                            "multi_episode_storylines": 0, "top_chains": []},
                           {"hits": 0, "misses": 0}, duration_s=0.1)
    assert "# Experiment: empty" in report
