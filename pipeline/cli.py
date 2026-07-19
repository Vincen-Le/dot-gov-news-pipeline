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

    p = sub.add_parser("cluster", help="event-time clustering replay")
    p.add_argument("--limit", type=int)
    p.add_argument("--per-agency", type=int, dest="per_agency",
                   help="cap replayed entries per agency (balanced sampling)")
    p.add_argument("--until")
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

    args = parser.parse_args()
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
    elif args.command == "cluster":
        from pipeline.runner import cluster
        out = cluster(store, _models(cfg, args.stub, args.no_cache), cfg,
                      limit=args.limit, until=_until(args.until),
                      per_agency=args.per_agency)
    elif args.command == "reset":
        from pipeline.bench import reset_clusters, reset_features
        (reset_features if args.features else reset_clusters)(db)
        out = {"reset": "features" if args.features else "clusters"}
    elif args.command == "experiment":
        from pipeline.experiment import run_experiment
        out = run_experiment(db, store, _models(cfg, args.stub, args.no_cache), cfg,
                             args.name, limit=args.limit, until=_until(args.until),
                             out_dir=args.out, per_agency=args.per_agency)
    print(json.dumps(out, default=str))


if __name__ == "__main__":
    main()
