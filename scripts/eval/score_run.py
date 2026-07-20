"""Mechanical scoring: verdict CSVs -> score.json (clustering-eval skill, step 4).

Zero judgment — formulas live in pipeline/shared/evals.py. Optionally stamps the
score onto the run's cluster snapshot (`--write-reward`), tying
the ledger to the experiment the autoresearch loop actually ran.

Usage (repo root):
  uv run python scripts/eval/score_run.py \
      --pipeline complex_v1 \
      --verdicts docs/eval/<run>/eval/verdicts \
      --artifacts docs/eval/<run>/eval/artifacts \
      --out docs/eval/<run>/eval/score.json \
      [--write-reward [--best]]   # ledger write: autoresearch only
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from pipeline.shared import evals
from pipeline.shared.eval_namespace import EVAL_NAMESPACES, get_eval_namespace

DISCRIMINATION_FLOOR = 0.40


def rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def score(verdicts: Path, artifacts: Path) -> dict:
    intruder_truth = json.loads((artifacts / "intruder-truth.json").read_text())
    v4_artifact = json.loads((artifacts / "v4.json").read_text())
    v5_artifact = json.loads((artifacts / "v5.json").read_text())

    result: dict = {}
    result.update(evals.score_v1(rows(verdicts / "chain-verdicts.csv"),
                                 rows(verdicts / "chain-summary.csv")))
    # a run can legitimately produce zero themes / zero multi-entry episodes
    # (tiny replay window); the vector is then unmeasured, not zero
    theme_rows = rows(verdicts / "theme-verdicts.csv")
    granularity_rows = rows(verdicts / "theme-granularity.csv")
    if theme_rows or granularity_rows:
        result.update(evals.score_v2(theme_rows, granularity_rows,
                                     intruder_truth))
    else:
        result.update({"v2_score": None, "v2_n": 0, "v2_n_cases": 0,
                       "v2_n_themes": 0, "v2_n_intruders": 0,
                       "v2_discrimination": None, "v2_theme_scores": {},
                       "v2_theme_case_counts": {}, "v2_granularity": {}})
    result.update(evals.score_v3(rows(verdicts / "category-verdicts.csv")))
    result.update(evals.score_v4(
        rows(verdicts / "granularity-merge-verdicts.csv")
    ))
    result["v4_singleton_rate"] = float(
        v4_artifact["structural_stats"]["singleton_theme_rate"])
    result.update(evals.score_v5(
        rows(verdicts / "entity-verdicts.csv"),
        miss_count=len(rows(verdicts / "entity-misses.csv")),
        sampled_count=len(v5_artifact["sampled_entries"]),
        stats_rows=rows(verdicts / "entity-stats-verdicts.csv"),
    ))
    episode_rows = rows(verdicts / "episode-verdicts.csv")
    if episode_rows:
        result.update(evals.score_v6(episode_rows))
    else:
        result.update({"v6_score": None, "v6_n": 0})
    result.update(evals.score_v7(rows(verdicts / "overview-verdicts.csv")))

    unmeasured = [key for key in ("v1_score", "v2_score", "v3_score",
                                  "v5_entity_precision", "v6_score",
                                  "v7_score") if result.get(key) is None]
    if unmeasured:
        result["reward_v2"] = None
        result["reward_v2_note"] = (
            "not computable: unmeasured vectors " + ", ".join(unmeasured))
        result["quanta"] = None
    else:
        result["reward_v2"] = evals.reward_v2(result)
        result["quanta"] = evals.quanta(result)
    discrimination = result.get("v2_discrimination")
    result["validity"] = {
        "v2_weak": discrimination is None or discrimination < DISCRIMINATION_FLOOR,
    }
    # gold recall — n/a until golden_news_entries is populated; slot stays
    result.setdefault("recall", {"storyline_pairwise_f1": None,
                                 "theme_pairwise_f1": None,
                                 "note": "n/a (no gold labels)"})
    return result


def write_reward(run_id: str, result: dict, best: bool,
                 pipeline: str = "complex_v1") -> None:
    from pipeline.shared.db import Db

    namespace = get_eval_namespace(pipeline)
    db = Db(os.environ["DATABASE_URL"])
    run = db.one(
        f"select id from public.{namespace.experiment_runs_table} "
        "where id = %(id)s", {"id": run_id})
    if run is None:
        raise SystemExit(f"unknown experiment run id {run_id!r}")
    db.rpc(namespace.annotate_snapshot_rpc,
           p_run_id=run["id"],
           p_reward=Db.jsonb({"score": result["reward_v2"],
                              "formula": "R_v2",
                              "vectors": {k: result[k] for k in
                                          ("v1_score", "v2_score", "v3_score",
                                           "v5_entity_precision", "v6_score",
                                           "v7_score", "v4_merge_pairs")},
                              "validity": result["validity"]}),
           p_is_best=best)
    db.conn.commit()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verdicts", required=True)
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--out")
    parser.add_argument("--pipeline", choices=sorted(EVAL_NAMESPACES),
                        default="complex_v1")
    parser.add_argument("--write-reward", action="store_true",
                        help="stamp reward onto the run's cluster snapshot "
                             "(ledger write — autoresearch loop only)")
    parser.add_argument("--best", action="store_true")
    args = parser.parse_args()

    result = score(Path(args.verdicts), Path(args.artifacts))
    payload = json.dumps(result, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).write_text(payload + "\n")
    print(payload)
    if args.write_reward:
        metadata = json.loads(
            (Path(args.artifacts) / "metadata.json").read_text()
        )
        artifact_pipeline = metadata.get("pipeline")
        if artifact_pipeline != args.pipeline:
            raise SystemExit(
                f"artifact pipeline {artifact_pipeline!r} does not match "
                f"--pipeline {args.pipeline!r}"
            )
        run_id = str((metadata.get("run") or {}).get("id") or "")
        if not run_id:
            raise SystemExit("artifact metadata is missing run.id")
        write_reward(run_id, result, args.best, args.pipeline)
        print(f"reward stamped on snapshot for run id {run_id!r}"
              + (" (is_best)" if args.best else ""))
    elif args.best:
        parser.error("--best requires --write-reward")


if __name__ == "__main__":
    main()
