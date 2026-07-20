from __future__ import annotations

import argparse
import json
from datetime import datetime

from pipeline.shared.cache import CachedModels, DecisionCache
from pipeline.shared.config import load_config
from pipeline.shared.db import Db
from pipeline.shared.store import Store

CACHE_PATH = ".cache/decisions.sqlite"


def _models(cfg, stub: bool, no_cache: bool):
    if stub:
        from pipeline.shared.stub import StubModels
        inner, tag = StubModels(), "stub"
    else:
        from pipeline.shared.ai import WorkersAI
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
    if args.since is not None:
        parser.error("--topology-label-set cannot be combined with --since")


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
    p.add_argument("--since", help="inclusive replay lower bound")
    p.add_argument("--until", help="inclusive replay upper bound")
    p.add_argument("--stub", action="store_true")
    p.add_argument("--no-cache", action="store_true")
    _add_topology_curation_arguments(p)

    p = sub.add_parser(
        "rank", help="rank observability and versioned context maintenance")
    p.add_argument(
        "action", choices=[
            "snapshot", "audit", "fit", "backfill-contexts", "calculate",
            "bootstrap-legacy", "opinions"
        ])
    p.add_argument("--name", help="immutable rank experiment name (calculate)")
    p.add_argument("--run", help="complex_v1_experiment_runs.id (snapshot/audit)")
    p.add_argument("--runs", help="comma-separated run ids (fit)")
    p.add_argument("--labels", default=None,
                   help="rank-labels csv overriding llm verdicts (fit)")
    p.add_argument("--min-pairs", type=int, default=50, dest="min_pairs")
    p.add_argument("--write", action="store_true",
                   help="persist fitted weights or exact context backfill rows")
    p.add_argument("--allow-fallback", action="store_true",
                   help="deprecated safety check; fallback writes are rejected")
    p.add_argument("--limit", type=int,
                   help="maximum missing cards to inspect during context backfill")
    p.add_argument("--stub", action="store_true")
    p.add_argument("--no-cache", action="store_true")

    p = sub.add_parser("reset", help="wipe experiment state (local db only)")
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--clusters", action="store_true")
    group.add_argument("--features", action="store_true")

    p = sub.add_parser(
        "golden", help="initialize and curate the chronological July-August anchor")
    p.add_argument(
        "action", choices=["init", "status", "show", "run", "approve",
                           "promote", "apply", "preview", "validate",
                           "export", "repair-features"])
    p.add_argument("--batch", type=int, help="chronological curation batch number")
    p.add_argument("--start", help="inclusive anchor start (init only)")
    p.add_argument("--before", help="exclusive anchor end (init only)")
    p.add_argument("--batch-size", type=int, default=50, dest="batch_size")
    p.add_argument("--path", default="docs/eval/golden-news-entries.jsonl")
    p.add_argument("--complete", action="store_true",
                   help="validation requires every anchor row reviewed")
    p.add_argument("--source-run", dest="source_run",
                   help="canonical simple_v1 run for golden promote; inferred when unique")
    p.add_argument("--stub", action="store_true")
    p.add_argument("--no-cache", action="store_true")

    p = sub.add_parser("experiment", help="reset + cluster + report, one command")
    p.add_argument("name")
    p.add_argument("--limit", type=int)
    p.add_argument("--per-agency", type=int, dest="per_agency",
                   help="cap replayed entries per agency (balanced sampling)")
    p.add_argument("--since", help="inclusive replay lower bound")
    p.add_argument("--until", help="inclusive replay upper bound")
    p.add_argument("--use-golden", action="store_true",
                   help="materialize reviewed gold before replay; defaults since to Sep 1")
    p.add_argument("--stub", action="store_true")
    p.add_argument("--no-cache", action="store_true")
    p.add_argument("--out", default="docs/eval")
    _add_topology_curation_arguments(p)

    args = parser.parse_args()
    if args.command in ("cluster", "experiment"):
        _validate_topology_curation_arguments(args, parser)
    if args.command == "experiment" and args.use_golden:
        if args.per_agency is not None or args.topology_label_set is not None:
            parser.error("--use-golden cannot be combined with per-agency/topology sampling")
    cfg = load_config()
    # Experiments are local-only; hosted writes go through the worker RPCs.
    # Direct hosted reads use psql with HOSTED_READONLY_DATABASE_URL instead.
    from pipeline.shared.bench import assert_local_dsn
    assert_local_dsn(cfg.database_url)
    db = Db(cfg.database_url)
    store = Store(db)

    if args.command == "sync":
        from pipeline.shared.bench import sync_corpus
        from pipeline.shared.hosted import load_hosted
        url, key = load_hosted()
        out = sync_corpus(db, url, key)
    elif args.command == "prepare":
        from pipeline.shared.preparation import prepare
        out = prepare(store, _models(cfg, args.stub, no_cache=True), cfg,
                      limit=args.limit, concurrency=args.concurrency,
                      per_agency=args.per_agency, agencies=args.agencies)
    elif args.command == "reextract":
        from pipeline.shared.extraction import EXTRACTOR_VERSION, extract
        rows = store.entries_needing_reextraction(EXTRACTOR_VERSION, limit=args.limit)
        for row in rows:
            entities, keys = extract(row["title"], row.get("summary"),
                                     row.get("body_text"))
            store.update_entry_features(
                row["id"], None, None, None, None,
                entity_set=entities, event_keys=keys,
                extractor_version=EXTRACTOR_VERSION)
        out = {"reextracted": len(rows)}
    elif args.command == "cluster":
        from pipeline.runner import cluster
        out = cluster(store, _models(cfg, args.stub, args.no_cache), cfg,
                      limit=args.limit, since=_until(args.since),
                      until=_until(args.until),
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
        if args.action == "bootstrap-legacy":
            from pipeline.ranking.experiments import bootstrap_legacy_rank
            out = bootstrap_legacy_rank(db)
        elif args.action == "opinions":
            if not args.run:
                parser.error("--run is required for rank opinions")
            from pipeline.ranking.opinions import generate_position_opinions
            out = generate_position_opinions(
                db, _models(cfg, args.stub, args.no_cache), cfg, args.run)
        elif args.action == "calculate":
            if not args.name:
                parser.error("--name is required for rank calculate")
            from pipeline.ranking.experiments import create_rank_experiment
            out = create_rank_experiment(
                db, cfg, args.name, source_run_id=args.run)
        elif args.action == "backfill-contexts":
            from pipeline.ranking.backfill import backfill_event_card_contexts
            out = backfill_event_card_contexts(
                db, cfg, write=args.write,
                allow_fallback=args.allow_fallback, limit=args.limit,
                source_run_id=args.run)
        elif args.action == "snapshot":
            out = snapshot_run(db, cfg, args.run)
        elif args.action == "audit":
            out = audit_run(db, _models(cfg, args.stub, args.no_cache), cfg, args.run)
        else:
            from pipeline.complex.fit import fit_weights, load_pairs, write_weights
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
        from pipeline.shared.bench import reset_clusters, reset_features
        (reset_features if args.features else reset_clusters)(db)
        out = {"reset": "features" if args.features else "clusters"}
    elif args.command == "golden":
        from pipeline import golden
        if args.action in ("show", "run", "approve") and args.batch is None:
            parser.error(f"--batch is required for golden {args.action}")
        if args.action == "init":
            out = golden.initialize(
                db,
                start=_until(args.start) or golden.GOLDEN_START,
                before=_until(args.before) or golden.GOLDEN_BEFORE,
                batch_size=args.batch_size,
            )
        elif args.action == "status":
            out = golden.status(db)
        elif args.action == "show":
            out = golden.show_batch(db, args.batch)
        elif args.action == "run":
            out = golden.run_batch(
                db, store, _models(cfg, args.stub, args.no_cache), cfg, args.batch)
        elif args.action == "approve":
            out = golden.approve_batch(db, args.batch)
        elif args.action == "promote":
            out = golden.promote_clustered(db, args.source_run)
        elif args.action == "apply":
            out = golden.apply_reviewed(db, cfg)
        elif args.action == "preview":
            out = golden.apply_reviewed(db, cfg, include_proposed=True)
        elif args.action == "validate":
            out = golden.validate(db, complete=args.complete)
        elif args.action == "repair-features":
            out = golden.clear_invalid_features(db, args.batch)
        else:
            out = golden.export_jsonl(db, args.path)
    elif args.command == "experiment":
        from pipeline.experiment import run_experiment
        since = _until(args.since)
        out = run_experiment(db, store, _models(cfg, args.stub, args.no_cache), cfg,
                             args.name, limit=args.limit, since=since,
                             until=_until(args.until), use_golden=args.use_golden,
                             out_dir=args.out, per_agency=args.per_agency,
                             topology_label_set_id=args.topology_label_set,
                             multi_episode_percent=args.multi_episode_percent,
                             multi_entry_single_episode_percent=(
                                 args.multi_entry_single_episode_percent),
                             topology_seed=args.topology_seed)
    print(json.dumps(out, default=str))


if __name__ == "__main__":
    main()
