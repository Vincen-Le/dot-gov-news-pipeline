"""Dispatch the seven blinded judges in parallel (clustering-eval skill, step 3).

Each judge receives ONLY its rubric section + artifact JSON — never the
hypothesis, config delta, or intruder truth. Verdict CSVs land verbatim in
--verdicts (canonically docs/eval/<run>/eval/verdicts/).

Usage (repo root; requires ANTHROPIC_API_KEY in .env):
  uv run python scripts/eval/run_judges.py \
      --artifacts docs/eval/<run>/eval/artifacts \
      --verdicts docs/eval/<run>/eval/verdicts [--vectors v1,v2]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from dotenv import load_dotenv

from pipeline.judge import (
    DEFAULT_JUDGE_MODEL,
    VECTORS,
    anthropic_complete,
    judge_vector,
    load_rubric,
)


def run_one(vector: str, artifacts: Path, verdicts: Path) -> str:
    spec = VECTORS[vector]
    artifact_json = (artifacts / spec["artifact"]).read_text()
    out = judge_vector(anthropic_complete(), load_rubric(vector),
                       spec["files"], artifact_json, vector=vector)
    for name, csv_text in out.items():
        (verdicts / name).write_text(csv_text + "\n")
    return vector


def record_judge_model(artifacts: Path) -> str:
    """Record the actual model only after the requested judge pass succeeds."""
    model = os.environ.get("EVAL_JUDGE_MODEL", DEFAULT_JUDGE_MODEL)
    metadata_path = artifacts / "metadata.json"
    metadata = json.loads(metadata_path.read_text())
    metadata["judge_model"] = model
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    return model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--verdicts", required=True)
    parser.add_argument("--vectors", default=",".join(VECTORS))
    args = parser.parse_args()
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")

    artifacts, verdicts = Path(args.artifacts), Path(args.verdicts)
    verdicts.mkdir(parents=True, exist_ok=True)
    vectors = [v.strip() for v in args.vectors.split(",") if v.strip()]

    with ThreadPoolExecutor(max_workers=len(vectors)) as pool:
        futures = {pool.submit(run_one, v, artifacts, verdicts): v for v in vectors}
        for future, vector in futures.items():
            try:
                future.result()
                print(f"{vector}: ok")
            except Exception as exc:  # keep the other judges running
                print(f"{vector}: FAILED — {exc}")
                raise SystemExit(1) from exc
    print(f"judge model: {record_judge_model(artifacts)}")


if __name__ == "__main__":
    main()
