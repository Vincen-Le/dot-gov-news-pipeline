"""One-command experiment: reset -> cluster -> summarize -> report.

Reports are the lab notebook: every run embeds its full resolved Config,
so two reports diff cleanly and no result is ambiguous about its settings.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict

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
        order by s.episode_count desc, s.entry_count desc limit 10
    """)
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
    }


def render_report(name: str, cfg: Config, cluster_report: dict, summary: dict,
                  cache_stats: dict, duration_s: float) -> str:
    redacted = {k: v for k, v in asdict(cfg).items()
                if k not in ("database_url", "cf_account_id", "cf_api_token")}
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
        "", "## Config", "",
        "```json", json.dumps(redacted, indent=2, sort_keys=True), "```", "",
    ]
    return "\n".join(lines)


def run_experiment(db, store, models, cfg: Config, name: str,
                   limit: int | None = None, until=None,
                   out_dir: str = "docs/eval") -> str:
    started = time.monotonic()
    reset_clusters(db)
    cluster_report = cluster(store, models, cfg, limit=limit, until=until)
    duration = round(time.monotonic() - started, 1)
    report = render_report(
        name, cfg, cluster_report, summarize(db),
        {"hits": getattr(models, "hits", 0), "misses": getattr(models, "misses", 0)},
        duration)
    path = os.path.join(out_dir, name, "report.md")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(report)
    return path
