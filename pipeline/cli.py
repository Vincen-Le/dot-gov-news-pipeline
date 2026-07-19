from __future__ import annotations

import argparse
import json
import os
from datetime import datetime

from pipeline.cache import CachedModels, DecisionCache
from pipeline.config import load_config
from pipeline.db import Db
from pipeline.store import Store

CACHE_PATH = ".cache/decisions.sqlite"


def _models(cfg, stub: bool, no_cache: bool):
    if stub:
        from pipeline.stub import StubModels
        inner, tag = StubModels(), "stub"
    else:
        from pipeline.ai import WorkersAI
        inner, tag = WorkersAI(cfg), cfg.adjudicator_model
    if no_cache:
        return inner
    return CachedModels(inner, DecisionCache(CACHE_PATH), tag)


def _until(value: str | None):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def _add_topology_curation_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--topology-label-set",
        help="complete topology_label_sets.id used to curate replay input")
    parser.add_argument(
        "--multi-episode-percent", type=float,
        help="target entry share from complete multi-episode storylines")
    parser.add_argument(
        "--multi-entry-single-episode-percent", type=float, default=0.0,
        help="target entry share from complete multi-entry single-episode storylines")
    parser.add_argument(
        "--topology-seed", default="default",
        help="deterministic curation seed")


def _validate_topology_curation_arguments(
    args: argparse.Namespace, parser: argparse.ArgumentParser,
) -> None:
    if args.topology_label_set is None:
        if args.multi_episode_percent is not None:
            parser.error("--multi-episode-percent requires --topology-label-set")
        if args.multi_entry_single_episode_percent != 0:
            parser.error(
                "--multi-entry-single-episode-percent requires --topology-label-set")
        return
    if args.limit is None:
        parser.error("--topology-label-set requires --limit")
    if args.multi_episode_percent is None:
        parser.error("--topology-label-set requires --multi-episode-percent")
    if args.per_agency is not None:
        parser.error("--topology-label-set cannot be combined with --per-agency")


def main() -> None:
    parser = argparse.ArgumentParser(prog="pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("sync", help="copy hosted corpus into local db (id-preserving)")

    p = sub.add_parser("prepare", help="enrich+embed+extract unfeatured entries")
    p.add_argument("--limit", type=int)
    p.add_argument("--per-agency", type=int, dest="per_agency",
                   help="cap entries per agency host (balanced sampling)")
    p.add_argument("--agency", action="append", dest="agencies",
                   help="prepare only this curated publisher key (repeatable)")
    p.add_argument("--concurrency", type=int, default=8)
    p.add_argument("--stub", action="store_true")

    p = sub.add_parser("reextract", help="re-run anchor extraction (no llm, no embeddings)")
    p.add_argument("--limit", type=int)

    p = sub.add_parser("cluster", help="event-time clustering replay")
    p.add_argument("--limit", type=int)
    p.add_argument("--per-agency", type=int, dest="per_agency",
                   help="cap replayed entries per agency (balanced sampling)")
    p.add_argument("--until")
    p.add_argument("--stub", action="store_true")
    p.add_argument("--no-cache", action="store_true")
    _add_topology_curation_arguments(p)

    p = sub.add_parser("rank", help="rank observability: snapshot | audit | fit")
    p.add_argument("action", choices=["snapshot", "audit", "fit"])
    p.add_argument("--run", help="experiment_runs.id (snapshot/audit)")
    p.add_argument("--runs", help="comma-separated run ids (fit)")
    p.add_argument("--labels", default=None,
                   help="rank-labels csv overriding llm verdicts (fit)")
    p.add_argument("--min-pairs", type=int, default=50, dest="min_pairs")
    p.add_argument("--write", action="store_true",
                   help="insert fitted weights as a new rubric_version")
    p.add_argument("--stub", action="store_true")
    p.add_argument("--no-cache", action="store_true")

    p = sub.add_parser("reset", help="wipe experiment state (local db only)")
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--clusters", action="store_true")
    group.add_argument("--features", action="store_true")

    p = sub.add_parser("experiment", help="reset + cluster + report, one command")
    p.add_argument("name")
    p.add_argument("--limit", type=int)
    p.add_argument("--per-agency", type=int, dest="per_agency",
                   help="cap replayed entries per agency (balanced sampling)")
    p.add_argument("--until")
    p.add_argument("--stub", action="store_true")
    p.add_argument("--no-cache", action="store_true")
    p.add_argument("--out", default="docs/eval")
    _add_topology_curation_arguments(p)

    args = parser.parse_args()
    if args.command in ("cluster", "experiment"):
        _validate_topology_curation_arguments(args, parser)
    cfg = load_config()
    db = Db(cfg.database_url)
    store = Store(db)

    if args.command == "sync":
        from pipeline.bench import sync_corpus
        out = sync_corpus(db, os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    elif args.command == "prepare":
        from pipeline.runner import prepare
        out = prepare(store, _models(cfg, args.stub, no_cache=True), cfg,
                      limit=args.limit, concurrency=args.concurrency,
                      per_agency=args.per_agency, agencies=args.agencies)
    elif args.command == "reextract":
        from pipeline.extraction import EXTRACTOR_VERSION, extract
        rows = store.entries_needing_reextraction(EXTRACTOR_VERSION, limit=args.limit)
        for row in rows:
            entities, keys = extract(row["title"],
                                     row.get("body_text") or row.get("summary"))
            store.update_entry_features(
                row["id"], None, None, None, None,
                entity_set=entities, event_keys=keys,
                extractor_version=EXTRACTOR_VERSION)
        out = {"reextracted": len(rows)}
    elif args.command == "cluster":
        from pipeline.runner import cluster
        out = cluster(store, _models(cfg, args.stub, args.no_cache), cfg,
                      limit=args.limit, until=_until(args.until),
                      per_agency=args.per_agency,
                      topology_label_set_id=args.topology_label_set,
                      multi_episode_percent=args.multi_episode_percent,
                      multi_entry_single_episode_percent=(
                          args.multi_entry_single_episode_percent),
                      topology_seed=args.topology_seed)
    elif args.command == "rank":
        from pipeline.rank import audit_run, snapshot_run
        if args.action in ("snapshot", "audit") and not args.run:
            parser.error("--run is required for snapshot/audit")
        if args.action == "snapshot":
            out = snapshot_run(db, cfg, args.run)
        elif args.action == "audit":
            out = audit_run(db, _models(cfg, args.stub, args.no_cache), cfg, args.run)
        else:
            from pipeline.fit import fit_weights, load_pairs, write_weights
            run_ids = [r.strip() for r in (args.runs or "").split(",") if r.strip()]
            if not run_ids:
                parser.error("--runs is required for fit")
            pairs = load_pairs(db, run_ids, labels_path=args.labels)
            if len(pairs) < args.min_pairs:
                out = {"error": "not_enough_pairs", "pairs": len(pairs),
                       "min_pairs": args.min_pairs}
            else:
                weights = fit_weights(pairs)
                out = {"pairs": len(pairs), "weights": weights}
                if args.write:
                    out["rubric_version"] = write_weights(db, weights)
    elif args.command == "reset":
        from pipeline.bench import reset_clusters, reset_features
        (reset_features if args.features else reset_clusters)(db)
        out = {"reset": "features" if args.features else "clusters"}
    elif args.command == "experiment":
        from pipeline.experiment import run_experiment
        out = run_experiment(db, store, _models(cfg, args.stub, args.no_cache), cfg,
                             args.name, limit=args.limit, until=_until(args.until),
                             out_dir=args.out, per_agency=args.per_agency,
                             topology_label_set_id=args.topology_label_set,
                             multi_episode_percent=args.multi_episode_percent,
                             multi_entry_single_episode_percent=(
                                 args.multi_entry_single_episode_percent),
                             topology_seed=args.topology_seed)
    print(json.dumps(out, default=str))


if __name__ == "__main__":
    main()
