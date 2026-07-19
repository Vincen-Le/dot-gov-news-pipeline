"""One-command experiment: reset -> cluster -> summarize -> report.

Reports are the lab notebook: every run embeds its full resolved Config,
so two reports diff cleanly and no result is ambiguous about its settings.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict
from datetime import datetime, timezone

from pipeline.bench import reset_clusters
from pipeline.config import Config
from pipeline.runner import cluster


def _dsn_label(database_url: str) -> str:
    """host:port/dbname only — never credentials."""
    from urllib.parse import urlsplit
    parts = urlsplit(database_url)
    return f"{parts.hostname}:{parts.port}{parts.path}"


def _anchored_replay_since(since):
    """Return an inclusive lower bound that cannot overlap the gold prefix."""
    from pipeline.golden import GOLDEN_BEFORE, GoldenValidationError

    if since is None:
        return GOLDEN_BEFORE
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    if since < GOLDEN_BEFORE:
        raise GoldenValidationError(
            "golden-backed experiments cannot replay entries before "
            "2025-09-01T00:00:00Z")
    return since


def summarize(db) -> dict:
    def mix(sql: str) -> dict:
        return {r["attach_method"]: r["n"] for r in db.all(sql)}

    totals = db.one("""
        select
          (select count(*) from public.news_entries where episode_id is not null) as entries_clustered,
          (select count(*) from public.episodes) as episodes,
          (select count(*) from public.storylines) as storylines,
          (select count(*) from public.event_cards) as cards
    """)
    singleton = db.one(
        "select round(avg((entry_count = 1)::int)::numeric, 3) as rate from public.episodes")
    multi = db.one("""
        select count(*) as n from public.storylines
        where episode_count >= 2 and merged_into is null
    """)
    chains = db.all("""
        select s.episode_count as episodes, coalesce(c.headline, '(no card)') as headline
        from public.storylines s
        left join public.event_cards c on c.id = s.latest_card_id
        where s.merged_into is null
        order by s.episode_count desc, s.entry_count desc,
                 coalesce(c.headline, ''), s.first_entry_at
        limit 10
    """)
    topics_totals = db.one("""
        select
          (select count(*) from public.topic_themes where merged_into is null) as themes,
          (select count(*) from public.topic_categories where origin = 'seed') as categories_seed,
          (select count(*) from public.topic_categories where origin = 'llm') as categories_llm
    """)
    singleton_theme = db.one("""
        select round(avg((storyline_count = 1)::int)::numeric, 3) as rate
        from public.topic_themes where merged_into is null
    """)
    top_themes = db.all("""
        select t.display_name as theme, coalesce(c.display_name, '(uncategorized)') as category,
               t.storyline_count as storylines
        from public.topic_themes t
        left join public.topic_categories c on c.id = t.category_id
        where t.merged_into is null
        order by t.storyline_count desc, t.display_name limit 10
    """)
    topics = {
        "themes": topics_totals["themes"],
        "categories_seed": topics_totals["categories_seed"],
        "categories_llm": topics_totals["categories_llm"],
        "theme_attach_mix": mix(
            "select theme_attach_method as attach_method, count(*) as n "
            "from public.storylines where theme_attach_method is not null "
            "group by 1 order by n desc"),
        "top_themes": top_themes,
        "singleton_theme_rate": (
            float(singleton_theme["rate"]) if singleton_theme["rate"] is not None else None),
    }
    fallback = db.one("""
        select round(avg((interest_reason like 'compressor_error%')::int)::numeric, 3) as rate
        from public.event_cards where kind = 'overview'
    """)
    theme_creator_errors = db.one("""
        select count(*) as n from public.storylines
        where theme_reason like '%theme_creator_error%'
    """)
    uncategorized = db.one("""
        select count(*) as n from public.topic_themes
        where merged_into is null and category_id is null
    """)
    unthemed = db.one("""
        select count(*) as n from public.storylines
        where merged_into is null and theme_id is null
    """)
    llm_health = {
        "overview_fallback_rate": (
            float(fallback["rate"]) if fallback["rate"] is not None else None),
        "uncategorized_themes": uncategorized["n"],
        "unthemed_storylines": unthemed["n"],
        "theme_creator_errors": theme_creator_errors["n"],
    }
    return {
        **totals,
        "llm_health": llm_health,
        "entry_attach_mix": mix(
            "select attach_method, count(*) as n from public.episode_entries "
            "group by 1 order by n desc"),
        "episode_attach_mix": mix(
            "select attach_method, count(*) as n from public.episodes "
            "group by 1 order by n desc"),
        "singleton_episode_rate": float(singleton["rate"]) if singleton["rate"] is not None else None,
        "multi_episode_storylines": multi["n"],
        "top_chains": chains,
        "topics": topics,
    }


def _validate_engine(cfg: Config) -> None:
    if cfg.engine not in ("classic", "spine"):
        raise ValueError(
            f"unknown engine: {cfg.engine!r} (expected 'classic' or 'spine')")


def _redacted_config(cfg: Config) -> dict:
    return {k: v for k, v in asdict(cfg).items()
            if k not in ("database_url", "cf_account_id", "cf_api_token")}


def render_report(name: str, cfg: Config, cluster_report: dict, summary: dict,
                  cache_stats: dict, duration_s: float) -> str:
    redacted = _redacted_config(cfg)
    input_topology = cluster_report.get("input_topology")
    curation_lines = []
    if input_topology is not None:
        curation_lines = [
            "## Input topology curation", "",
            f"- label set: {input_topology['label_set_id']}",
            f"- deterministic seed: {input_topology['seed']}",
            "- requested multi-episode entry share: "
            f"{input_topology['requested_multi_episode_percent']}%",
            "- requested multi-entry single-episode entry share: "
            f"{input_topology['requested_multi_entry_single_episode_percent']}%",
            "- actual expected entry counts: "
            f"{input_topology['actual_entry_counts']}",
            "- entries expected to be in multi-entry episodes: "
            f"{input_topology['actual_multi_entry_episode_entries']}",
            "",
        ]
    golden = cluster_report.get("golden_anchor")
    golden_lines = []
    if golden is not None:
        golden_lines = [
            "## Golden anchor", "",
            f"- reviewed entries materialized: {golden['materialized_entries']}",
            f"- episodes: {golden['episodes']}",
            f"- storylines: {golden['storylines']}",
            f"- themes: {golden['themes']}",
            f"- replay lower bound: {cluster_report.get('since')}",
            "",
        ]
    lines = [
        f"# Experiment: {name}", "",
        f"Duration: {duration_s}s — processed {cluster_report['processed']}, "
        f"closed {cluster_report['episodes_closed']} episodes, "
        f"cache {cache_stats.get('hits', 0)} hits / {cache_stats.get('misses', 0)} misses.", "",
        "## Totals", "",
        f"- entries clustered: {summary['entries_clustered']}",
        f"- episodes: {summary['episodes']}  storylines: {summary['storylines']}  cards: {summary['cards']}",
        f"- singleton-episode rate: {summary['singleton_episode_rate']}",
        f"- multi-episode storylines: {summary['multi_episode_storylines']}", "",
        *curation_lines,
        *golden_lines,
        "## Attach mix (entry -> episode)", "",
        *[f"- {m}: {n}" for m, n in summary["entry_attach_mix"].items()],
        "", "## Attach mix (episode -> storyline)", "",
        *[f"- {m}: {n}" for m, n in summary["episode_attach_mix"].items()],
        "", "## Top chains", "",
        *[f"- [{c['episodes']} episodes] {c['headline']}" for c in summary["top_chains"]],
        "", "## Topics", "",
        f"- themes: {summary['topics']['themes']}  "
        f"categories: {summary['topics']['categories_seed']} seed "
        f"+ {summary['topics']['categories_llm']} llm",
        f"- singleton-theme rate: {summary['topics']['singleton_theme_rate']}",
        "", "## LLM health", "",
        f"- overview fallback rate: {summary['llm_health']['overview_fallback_rate']}"
        + ("  ⚠ compressor mostly failing"
           if (summary['llm_health']['overview_fallback_rate'] or 0) > 0.5 else ""),
        f"- uncategorized themes: {summary['llm_health']['uncategorized_themes']}",
        f"- deferred/unassigned storylines: {summary['llm_health'].get('unthemed_storylines', 0)}",
        f"- theme creator errors: {summary['llm_health']['theme_creator_errors']}",
        f"- model errors: {summary['llm_health'].get('model_errors', {})}",
        "", "## Theme attach mix (storyline -> theme)", "",
        *[f"- {m}: {n}" for m, n in summary["topics"]["theme_attach_mix"].items()],
        "", "## Top themes", "",
        *[f"- [{t['storylines']} storylines] {t['theme']} ({t['category']})"
          for t in summary["topics"]["top_themes"]],
        "", "## Config", "",
        "```json", json.dumps(redacted, indent=2, sort_keys=True), "```", "",
    ]
    return "\n".join(lines)


def record_run(db, name: str, cfg: Config, cluster_report: dict, summary: dict,
               cache_stats: dict, started_at, finished_at) -> str:
    cursor = db.conn.execute(
        "insert into public.experiment_runs "
        "(name, started_at, finished_at, config, cluster_report, summary, "
        " cache_hits, cache_misses) "
        "values (%(name)s, %(started_at)s, %(finished_at)s, %(config)s::jsonb, "
        "        %(cluster_report)s::jsonb, %(summary)s::jsonb, %(hits)s, %(misses)s) "
        "returning id",
        {"name": name, "started_at": started_at, "finished_at": finished_at,
         "config": json.dumps(_redacted_config(cfg), sort_keys=True),
         "cluster_report": json.dumps(cluster_report, default=str),
         "summary": json.dumps(summary, default=str),
         "hits": cache_stats.get("hits", 0), "misses": cache_stats.get("misses", 0)})
    return str(cursor.fetchone()["id"])


def run_experiment(db, store, models, cfg: Config, name: str,
                   limit: int | None = None, since=None, until=None,
                   out_dir: str = "docs/eval",
                   per_agency: int | None = None,
                   topology_label_set_id: str | None = None,
                   multi_episode_percent: float | None = None,
                   multi_entry_single_episode_percent: float = 0.0,
                   topology_seed: str = "default",
                   use_golden: bool = False) -> dict:
    started = datetime.now(timezone.utc)
    import sys
    print(f"[experiment] engine={cfg.engine} "
          f"database={_dsn_label(cfg.database_url)}", file=sys.stderr)
    _validate_engine(cfg)
    if cfg.engine == "spine" and (topology_label_set_id is not None or use_golden):
        raise ValueError("spine engine does not support topology curation "
                         "or --use-golden yet")
    golden_anchor = None
    if use_golden:
        from pipeline.golden import GoldenValidationError, apply_reviewed, validate
        since = _anchored_replay_since(since)
        validation = validate(db, complete=True)
        if not validation["valid"]:
            raise GoldenValidationError(
                "golden anchor is not ready: " + "; ".join(validation["errors"][:10]))
        golden_anchor = apply_reviewed(db, cfg)
    else:
        reset_clusters(db)
    if cfg.engine == "spine":
        from spine.replay import run as spine_run
        cluster_report = spine_run(store, models, cfg, limit=limit,
                                   since=since, until=until,
                                   per_agency=per_agency)
    else:
        cluster_report = cluster(store, models, cfg, limit=limit, since=since,
                                 until=until, per_agency=per_agency,
                                 topology_label_set_id=topology_label_set_id,
                                 multi_episode_percent=multi_episode_percent,
                                 multi_entry_single_episode_percent=(
                                     multi_entry_single_episode_percent),
                                 topology_seed=topology_seed)
    if use_golden:
        cluster_report["golden_anchor"] = golden_anchor
        cluster_report["since"] = since
    finished = datetime.now(timezone.utc)
    duration = round((finished - started).total_seconds(), 1)
    summary = summarize(db)
    summary["llm_health"]["model_errors"] = dict(getattr(models, "errors", {}))
    cache_stats = {"hits": getattr(models, "hits", 0), "misses": getattr(models, "misses", 0)}
    report = render_report(name, cfg, cluster_report, summary, cache_stats, duration)
    path = os.path.join(out_dir, name, "report.md")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(report)
    run_id = record_run(db, name, cfg, cluster_report, summary, cache_stats, started, finished)
    from pipeline.rank import snapshot_run
    snapshot = snapshot_run(db, cfg, run_id)
    return {"report": path, "run_id": run_id, **snapshot}
