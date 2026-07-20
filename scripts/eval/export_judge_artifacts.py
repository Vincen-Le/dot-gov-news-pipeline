"""Export blinded judge artifacts for one run (clustering-eval skill, step 2).

Writes v1..v7 artifact JSON + intruder-truth.json + diagnostics.json to
--out (canonically docs/eval/<run>/eval/artifacts/). Blinding: intruder
ground truth goes ONLY to intruder-truth.json; per-theme intruders are
shuffled unlabeled into the theme's storyline list in v2.json.

Usage (repo root):
  DATABASE_URL=... uv run python scripts/eval/export_judge_artifacts.py \
      --pipeline complex_v1 --out docs/eval/<run>/eval/artifacts [--probe-labels]

--probe-labels generates each theme's one-level-up granularity probe label
at export time via the Anthropic judge client (requires ANTHROPIC_API_KEY).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from pipeline.shared.db import Db
from pipeline.shared.eval_namespace import EVAL_NAMESPACES, get_eval_namespace
from pipeline.shared.evals import sample_intruders
from pipeline.shared.vectors import cosine, unpack_fp16

INTRUDERS_PER_THEME = 5


def dump(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, default=str))


def member_shape(row: dict) -> dict:
    return {
        "entry_id": str(row["entry_id"]),
        "title": row["title"],
        "summary": (row.get("summary") or "")[:1200],
        "published_at": row.get("published_at"),
        "entities": row.get("entity_set") or [],
        "event_keys": row.get("event_keys") or [],
        "entry_attach_method": row.get("entry_attach_method"),
        "entry_similarity": row.get("entry_similarity"),
    }


def storyline_shape(row: dict) -> dict:
    return {
        "storyline_id": str(row["storyline_id"]),
        "headline": row.get("headline") or "(no card)",
        "summary": (row.get("summary") or "")[:1600],
        "entities": row.get("entity_set") or [],
        "event_keys": row.get("event_keys") or [],
        "first_entry_at": row.get("first_entry_at"),
        "newest_entry_at": row.get("newest_entry_at"),
        "episode_count": row.get("episode_count"),
        "entry_count": row.get("entry_count"),
        "theme_attach_method": row.get("theme_attach_method"),
        "theme_similarity": row.get("theme_similarity"),
    }


def stratified_episode_sample(episodes: list[dict], limit: int = 50) -> list[dict]:
    if len(episodes) <= limit:
        return episodes
    rng = random.Random(42)
    bands: dict[str, list[dict]] = {"2": [], "3-5": [], "6+": []}
    for ep in episodes:
        n = int(ep["entry_count"])
        bands["2" if n == 2 else "3-5" if n <= 5 else "6+"].append(ep)
    for rows in bands.values():
        rows.sort(key=lambda r: str(r["episode_id"]))
        rng.shuffle(rows)
    selected: list[dict] = []
    while len(selected) < limit and any(bands.values()):
        for name in ("2", "3-5", "6+"):
            if bands[name] and len(selected) < limit:
                selected.append(bands[name].pop())
    return sorted(selected, key=lambda r: str(r["episode_id"]))


def stratified_entry_sample(rows: list[dict], limit: int = 100) -> list[dict]:
    rng = random.Random(42)
    by_agency: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_agency[row.get("agency") or "(unknown)"].append(row)
    for agency_rows in by_agency.values():
        agency_rows.sort(key=lambda r: str(r["entry_id"]))
        rng.shuffle(agency_rows)
    agencies = sorted(by_agency)
    selected: list[dict] = []
    while len(selected) < min(limit, len(rows)):
        progressed = False
        for agency in agencies:
            if by_agency[agency] and len(selected) < limit:
                selected.append(by_agency[agency].pop())
                progressed = True
        if not progressed:
            break
    return sorted(selected, key=lambda r: str(r["entry_id"]))


def distinctive_tokens(name: str) -> set[str]:
    stop = {
        "a", "an", "and", "for", "from", "in", "of", "on", "the", "to",
        "u", "us", "new", "federal", "government", "policy", "program",
        "programs", "updates", "issues", "actions", "news",
    }
    return {
        token for token in re.findall(r"[a-z0-9]+", name.lower())
        if len(token) >= 3 and token not in stop
    }


def build_category_pairs(storylines: list[dict], themes: list[dict],
                         categories: list[dict]) -> list[dict]:
    """Shape V3 cases from the storyline's captured stream category."""
    theme_by_id = {theme["theme_id"]: theme for theme in themes}
    category_by_id = {category["category_id"]: category
                      for category in categories}
    pairs = []
    for storyline in storylines:
        theme = theme_by_id.get(storyline.get("theme_id"))
        category = category_by_id.get(storyline.get("stream_category_id"))
        pairs.append({
            "storyline": {
                key: value for key, value in storyline.items()
                if key != "theme_reason"
            },
            "theme_id": theme["theme_id"] if theme else "",
            "theme_name": theme["display_name"] if theme else None,
            "filed_category": category["display_name"] if category else None,
        })
    return pairs


def assert_live_matches_snapshot(db: Db, snapshot: dict) -> None:
    """Refuse to mislabel mutable live state as the latest completed run."""
    specs = {
        "storylines": ("select id::text as id from public.storylines", ("id",)),
        "episodes": ("select id::text as id from public.episodes", ("id",)),
        "episode_entries": (
            "select episode_id::text, entry_id::text from public.episode_entries",
            ("episode_id", "entry_id"),
        ),
        "news_entries": (
            "select ne.id::text as id from public.news_entries ne "
            "where exists (select 1 from public.episode_entries ee "
            "where ee.entry_id = ne.id)",
            ("id",),
        ),
        "event_cards": ("select id::text as id from public.event_cards", ("id",)),
        "topic_themes": ("select id::text as id from public.topic_themes", ("id",)),
        "topic_categories": (
            "select id::text as id from public.topic_categories", ("id",)
        ),
    }
    mismatches = []
    for name, (query, columns) in specs.items():
        live = {tuple(str(row[column]) for column in columns)
                for row in db.all(query)}
        frozen = {tuple(str(row[column]) for column in columns)
                  for row in snapshot.get(name, [])}
        if live != frozen:
            mismatches.append(
                f"{name}(live={len(live)}, snapshot={len(frozen)})"
            )
    if mismatches:
        raise SystemExit(
            "live clustering state does not match the latest completed run "
            "snapshot; finish/replay that run before exporting: "
            + ", ".join(mismatches)
        )


def generate_probe_labels(themes: list[dict]) -> dict[str, str]:
    """One-level-up granularity probe label per theme, via the judge client."""
    from pipeline.shared.judge import anthropic_complete, judge_vector

    rubric = (
        "For each theme, rewrite its label exactly one abstraction level up: "
        "drop an adjective, drop a location qualifier, or widen the scope one "
        "notch (e.g. 'California EPA Diesel Emission Waivers' -> 'EPA Emission "
        "Waivers'). Do not step up to an agency or category bucket. 2-5 words, "
        "no punctuation."
    )
    files = {"probe-labels.csv": ["theme_id", "probe_label"]}
    payload = json.dumps([
        {"theme_id": t["theme_id"], "display_name": t["display_name"]}
        for t in themes
    ])
    out = judge_vector(anthropic_complete(), rubric, files, payload)
    labels = {
        row["theme_id"].strip(): row["probe_label"].strip()
        for row in csv.DictReader(io.StringIO(out["probe-labels.csv"]))
    }
    expected = {str(theme["theme_id"]) for theme in themes}
    if set(labels) != expected or any(not label for label in labels.values()):
        missing = sorted(expected - set(labels))[:5]
        unexpected = sorted(set(labels) - expected)[:5]
        raise ValueError(
            "probe label cases mismatch; "
            f"missing={missing}, unexpected={unexpected}"
        )
    return labels


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--pipeline", choices=sorted(EVAL_NAMESPACES),
                        default="complex_v1")
    parser.add_argument("--probe-labels", action="store_true")
    args = parser.parse_args()
    repo_root = Path(__file__).resolve().parents[2]
    load_dotenv(repo_root / ".env")
    namespace = get_eval_namespace(args.pipeline)
    db = Db(os.environ["DATABASE_URL"])
    db.conn.execute("begin transaction isolation level repeatable read read only")

    run = db.one(
        f"select r.id::text, r.name, r.finished_at::text, s.snapshot "
        f"from public.{namespace.experiment_runs_table} r "
        f"join public.{namespace.experiment_snapshots_table} s "
        "on s.run_id = r.id "
        "order by finished_at desc nulls last limit 1"
    )
    if run is None:
        raise SystemExit(f"no snapshotted experiment runs found for {namespace.key}")
    snapshot = run.pop("snapshot")
    assert_live_matches_snapshot(db, snapshot)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)

    # Shared live-storyline surface used by V2/V3 + intruder sampling.
    storyline_rows = db.all("""
        select s.id::text as storyline_id, s.theme_id::text, s.category_id::text,
               s.entity_set, s.event_keys, s.first_entry_at, s.newest_entry_at,
               s.episode_count, s.entry_count, s.theme_attach_method,
               s.theme_similarity, s.theme_reason, s.centroid,
               coalesce(c.headline, '(no card)') as headline,
               coalesce(c.summary, '') as summary
        from public.storylines s
        left join public.event_cards c on c.id = s.latest_card_id
        where s.merged_into is null
        order by s.id
    """)
    storylines = [storyline_shape(r) | {
        "theme_id": r.get("theme_id"),
        "stream_category_id": r.get("category_id"),
        "theme_reason": r.get("theme_reason"),
    } for r in storyline_rows]
    storyline_by_id = {r["storyline_id"]: r for r in storylines}
    storyline_centroids = {
        str(r["storyline_id"]): unpack_fp16(r["centroid"])
        for r in storyline_rows if r.get("centroid") is not None
    }

    # V1 — every multi-episode chain, episodes in build order, with entries.
    episode_rows = db.all("""
        select e.id::text as episode_id, e.storyline_id::text,
               e.attach_method, e.attach_similarity, e.attach_reason,
               e.first_entry_at, e.newest_entry_at, e.entry_count,
               e.entity_set, e.event_keys, e.centroid,
               coalesce(c.headline, '(no episode card)') as headline,
               coalesce(c.summary, '') as summary
        from public.episodes e
        join public.storylines s on s.id = e.storyline_id
        left join public.event_cards c on c.episode_id = e.id
             and c.kind = 'episode' and c.superseded_by is null
        where s.merged_into is null and s.episode_count >= 2
        -- build order, not event time: same-timestamp entries can put the
        -- adjudicated join ahead of the birth episode, and V1 expects
        -- episodes[0] to be the chain's birth
        order by e.storyline_id, e.created_at, e.id
    """)
    episode_member_rows = db.all("""
        select ee.episode_id::text, ne.id::text as entry_id, ne.title,
               ne.summary, ne.published_at, ne.entity_set, ne.event_keys,
               ee.attach_method as entry_attach_method,
               ee.similarity as entry_similarity
        from public.episode_entries ee
        join public.news_entries ne on ne.id = ee.entry_id
        join public.episodes e on e.id = ee.episode_id
        join public.storylines s on s.id = e.storyline_id
        where s.merged_into is null and s.episode_count >= 2
        order by ee.episode_id, ne.published_at, ne.id
    """)
    members_by_episode: dict[str, list[dict]] = defaultdict(list)
    for row in episode_member_rows:
        members_by_episode[row["episode_id"]].append(member_shape(row))
    chains_by_id: dict[str, dict] = {}
    episode_centroids: dict[str, list] = defaultdict(list)  # storyline -> ordered centroids
    episode_entities: dict[str, list] = defaultdict(list)
    for row in episode_rows:
        sid = row["storyline_id"]
        chain = chains_by_id.setdefault(sid, {
            "storyline": storyline_by_id[sid], "episodes": []
        })
        chain["episodes"].append({
            "episode_id": row["episode_id"],
            "attach_method": row.get("attach_method"),
            "attach_similarity": row.get("attach_similarity"),
            "attach_reason": row.get("attach_reason"),
            "first_entry_at": row.get("first_entry_at"),
            "newest_entry_at": row.get("newest_entry_at"),
            "entry_count": row.get("entry_count"),
            "entities": row.get("entity_set") or [],
            "event_keys": row.get("event_keys") or [],
            "headline": row.get("headline"),
            "summary": (row.get("summary") or "")[:1600],
            "entries": members_by_episode[row["episode_id"]],
        })
        if row.get("centroid") is not None:
            episode_centroids[sid].append(unpack_fp16(row["centroid"]))
        episode_entities[sid].append(set(row.get("entity_set") or []))
    dump(out / "v1.json", {"chains": list(chains_by_id.values())})

    # V2 — every live theme with members + per-theme planted intruders
    # (unlabeled, shuffled in); ground truth goes ONLY to intruder-truth.json.
    theme_rows = db.all("""
        select t.id::text as theme_id, t.display_name, t.inclusion_criterion,
               t.storyline_count, t.category_id::text, t.centroid,
               coalesce(tc.display_name, '(uncategorized)') as category
        from public.topic_themes t
        left join public.topic_categories tc on tc.id = t.category_id
        where t.merged_into is null and t.demoted_at is null
        order by t.id
    """)
    rng = random.Random(42)
    themes: list[dict] = []
    intruder_truth: list[dict] = []
    cohesion_by_theme: dict[str, float | None] = {}
    for row in theme_rows:
        theme_id = row["theme_id"]
        members = [s for s in storylines if s.get("theme_id") == theme_id]
        member_ids = {m["storyline_id"] for m in members}
        theme_centroid = (unpack_fp16(row["centroid"])
                          if row.get("centroid") is not None else None)
        # cohesion (diagnostic only — never enters V2)
        member_sims = [cosine(storyline_centroids[m], theme_centroid)
                       for m in member_ids
                       if theme_centroid is not None and m in storyline_centroids]
        cohesion_by_theme[theme_id] = (
            float(sum(member_sims) / len(member_sims)) if member_sims else None)
        # hard-negative candidates: non-members by cosine to the theme centroid
        candidates = []
        for s in storylines:
            sid = s["storyline_id"]
            if sid in member_ids or sid not in storyline_centroids:
                continue
            sim = (float(cosine(storyline_centroids[sid], theme_centroid))
                   if theme_centroid is not None else 0.0)
            candidates.append((sid, sim))
        planted_ids = (sample_intruders(candidates,
                                        min(len(members), INTRUDERS_PER_THEME), rng)
                       if members else [])
        for sid in planted_ids:
            intruder_truth.append({"theme_id": theme_id, "storyline_id": sid})
        judged = list(members) + [storyline_by_id[sid] for sid in planted_ids]
        rng.shuffle(judged)
        themes.append({
            "theme_id": theme_id,
            "display_name": row["display_name"],
            "inclusion_criterion": row.get("inclusion_criterion") or "",
            "category": row["category"],
            "declared_storyline_count": row["storyline_count"],
            "probe_label": None,  # filled below when --probe-labels
            "storylines": judged,
        })
    if args.probe_labels and themes:
        labels = generate_probe_labels(themes)
        for theme in themes:
            theme["probe_label"] = labels.get(theme["theme_id"])
    dump(out / "v2.json", {"themes": themes, "all_live_storylines": storylines})
    dump(out / "intruder-truth.json", intruder_truth)

    # V3 — category judgment at storyline grain using each stream category.
    categories = db.all("""
        select id::text as category_id, display_name, origin, proposal_reason
        from public.topic_categories order by display_name, id
    """)
    theme_by_id = {t["theme_id"]: t for t in themes}
    pairs = build_category_pairs(storylines, themes, categories)
    dump(out / "v3.json", {
        "categories": categories,
        "category_storyline_pairs": pairs,
        "live_storyline_count": len(storylines),
        "unthemed_storyline_count": sum(s.get("theme_id") is None for s in storylines),
    })

    # V4 — merge candidates: centroid cosine >= 0.75 OR shared distinctive
    # name token corpus-wide (themes legitimately span categories).
    theme_centroids = {r["theme_id"]: unpack_fp16(r["centroid"])
                       for r in theme_rows if r.get("centroid") is not None}
    v4_candidates = []
    all_pair_sims = []
    for i, a in enumerate(theme_rows):
        for b in theme_rows[i + 1:]:
            sim = None
            if a["theme_id"] in theme_centroids and b["theme_id"] in theme_centroids:
                sim = float(cosine(theme_centroids[a["theme_id"]],
                                   theme_centroids[b["theme_id"]]))
                all_pair_sims.append(round(sim, 4))
            shared = sorted(distinctive_tokens(a["display_name"]) &
                            distinctive_tokens(b["display_name"]))
            if (sim is not None and sim >= 0.75) or shared:
                v4_candidates.append({
                    "theme_a": {k: theme_by_id[a["theme_id"]][k]
                                for k in ("theme_id", "display_name",
                                          "inclusion_criterion", "category", "storylines")},
                    "theme_b": {k: theme_by_id[b["theme_id"]][k]
                                for k in ("theme_id", "display_name",
                                          "inclusion_criterion", "category", "storylines")},
                    "cosine": round(sim, 6) if sim is not None else None,
                    "shared_distinctive_name_tokens": shared,
                })
    counts = [int(t["storyline_count"]) for t in theme_rows]
    category_counts = Counter(t["category"] for t in theme_rows)
    dump(out / "v4.json", {
        "merge_candidates": v4_candidates,
        "structural_stats": {
            "theme_count": len(counts),
            "singleton_theme_rate": (sum(n == 1 for n in counts) / len(counts)) if counts else 0,
            "members_per_theme_histogram": dict(sorted(Counter(counts).items())),
            "themes_per_category": dict(sorted(category_counts.items())),
            "pair_cosine_histogram": dict(sorted(Counter(
                round(s, 1) for s in all_pair_sims).items())),
        },
    })

    # V5 — top deterministic entity sweep plus seeded agency-stratified sample.
    top_entities = db.all("""
        select entity, total_count, daily_ema, first_seen_at, last_seen_at
        from public.entity_stats order by total_count desc, entity limit 50
    """)
    entry_rows = db.all("""
        select ne.id::text as entry_id, ne.title, ne.summary, ne.entity_set,
               ne.event_keys, ne.published_at,
               split_part(ns.canonical_url, '/', 3) as agency
        from public.news_entries ne
        join public.news_sources ns on ns.id = ne.news_source_id
        where ne.entity_set is not null
        order by ne.id
    """)
    sampled = stratified_entry_sample(entry_rows)
    dump(out / "v5.json", {
        "top_entity_stats": top_entities,
        "sampled_entries": [{
            "entry_id": r["entry_id"],
            "agency": r.get("agency"),
            "title": r["title"],
            "summary": (r.get("summary") or "")[:1600],
            "published_at": r.get("published_at"),
            "entities": r.get("entity_set") or [],
            "event_keys": r.get("event_keys") or [],
        } for r in sampled],
    })

    # V6 — all small multi-entry episodes, otherwise seeded band sample of 50.
    v6_episode_rows = db.all("""
        select e.id::text as episode_id, e.entry_count, e.entity_set, e.event_keys,
               e.first_entry_at, e.newest_entry_at
        from public.episodes e where e.entry_count >= 2
        order by e.id
    """)
    selected_episodes = stratified_episode_sample(v6_episode_rows)
    selected_ids = {r["episode_id"] for r in selected_episodes}
    v6_member_rows = db.all("""
        select ee.episode_id::text, ne.id::text as entry_id, ne.title,
               ne.summary, ne.published_at, ne.entity_set, ne.event_keys,
               ee.attach_method as entry_attach_method,
               ee.similarity as entry_similarity
        from public.episode_entries ee
        join public.news_entries ne on ne.id = ee.entry_id
        join public.episodes e on e.id = ee.episode_id
        where e.entry_count >= 2
        order by ee.episode_id, ne.published_at, ne.id
    """)
    v6_members: dict[str, list[dict]] = defaultdict(list)
    for row in v6_member_rows:
        if row["episode_id"] in selected_ids:
            v6_members[row["episode_id"]].append(member_shape(row))
    dump(out / "v6.json", {
        "total_multi_entry_episodes": len(v6_episode_rows),
        "sampled_episode_count": len(selected_episodes),
        "episodes": [{
            "episode_id": ep["episode_id"],
            "entry_count": ep["entry_count"],
            "entities": ep.get("entity_set") or [],
            "event_keys": ep.get("event_keys") or [],
            "first_entry_at": ep.get("first_entry_at"),
            "newest_entry_at": ep.get("newest_entry_at"),
            "entries": v6_members[ep["episode_id"]],
        } for ep in selected_episodes],
    })

    # V7 — overview card + member episode cards per multi-episode storyline.
    overview_rows = db.all("""
        select s.id::text as storyline_id, c.headline, c.summary, c.timeline
        from public.storylines s
        join public.event_cards c on c.id = s.latest_card_id and c.kind = 'overview'
        where s.merged_into is null and s.episode_count >= 2
        order by s.id
    """)
    dump(out / "v7.json", {"overviews": [{
        "storyline_id": r["storyline_id"],
        "headline": r["headline"],
        "summary": r["summary"],
        "timeline": r.get("timeline"),
        "episode_cards": [
            {"episode_id": e["episode_id"], "date": str(e.get("newest_entry_at") or ""),
             "headline": e["headline"], "summary": e["summary"]}
            for e in chains_by_id.get(r["storyline_id"], {}).get("episodes", [])
        ],
    } for r in overview_rows]})

    # Diagnostics (no judge, no reward weight): chain embedding trends +
    # theme cohesion for the router quadrants.
    chain_diag = {}
    for sid, centroids in episode_centroids.items():
        sims = [float(cosine(a, b)) for a, b in zip(centroids, centroids[1:])]
        overlaps = [len(a & b) for a, b in zip(episode_entities[sid],
                                               episode_entities[sid][1:])]
        chain_diag[sid] = {"consecutive_cosine": [round(s, 4) for s in sims],
                           "entity_overlap": overlaps}
    dump(out / "diagnostics.json", {
        "chains": chain_diag,
        "theme_cohesion": cohesion_by_theme,
    })

    dump(out / "metadata.json", {
        "run": run,
        "pipeline": namespace.key,
        "judge_model": None,
        "counts": {
            "v1_chains": len(chains_by_id),
            "v2_themes": len(themes),
            "v2_intruders_planted": len(intruder_truth),
            "v3_pairs": len(pairs),
            "v4_candidates": len(v4_candidates),
            "v5_entries": len(sampled),
            "v6_episodes": len(selected_episodes),
            "v7_overviews": len(overview_rows),
        },
    })
    db.conn.commit()


if __name__ == "__main__":
    main()
