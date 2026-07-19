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
    return {
        **totals,
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


def _redacted_config(cfg: Config) -> dict:
    return {k: v for k, v in asdict(cfg).items()
            if k not in ("database_url", "cf_account_id", "cf_api_token")}


def render_report(name: str, cfg: Config, cluster_report: dict, summary: dict,
                  cache_stats: dict, duration_s: float) -> str:
    redacted = _redacted_config(cfg)
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
                   limit: int | None = None, until=None,
                   out_dir: str = "docs/eval",
                   per_agency: int | None = None) -> dict:
    started = datetime.now(timezone.utc)
    reset_clusters(db)
    cluster_report = cluster(store, models, cfg, limit=limit, until=until,
                             per_agency=per_agency)
    finished = datetime.now(timezone.utc)
    duration = round((finished - started).total_seconds(), 1)
    summary = summarize(db)
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
