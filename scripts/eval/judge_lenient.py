"""Lenient blinded-judge dispatch: one vector, tolerant CSV intake.

Standard dispatch path as of 2026-07-20 (three of four run_judges.py batch
dispatches that day aborted whole-process on a single malformed CSV row).
Differences from run_judges.py:

- Overflow CSV fields (unquoted commas in a judge's reason) are mechanically
  rejoined into the trailing reason column instead of failing the pass.
- Dropped cases are re-judged in a same-rubric top-up dispatch over only the
  affected case groups (chains/themes/pairs/episodes/overviews), then merged.
  Note every top-up in the eval report's caveats.
- Duplicate and unexpected rows are discarded (first verdict per case wins).

The blinding contract and the frozen validation (_validate_case_coverage,
categorical vocabularies) are unchanged — merged output must still pass the
exact case-coverage check before anything is written.

v4/v5 are not supported here (v4 rarely misbehaves; v5's free-form
entity-misses.csv has no fixed cardinality to top up) — use run_judges.py.

Usage (repo root; requires ANTHROPIC_API_KEY in .env):
  uv run python scripts/eval/judge_lenient.py <v1|v2|v3|v6|v7> \
      --artifacts docs/eval/<run>/eval/artifacts \
      --verdicts docs/eval/<run>/eval/verdicts
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from dotenv import load_dotenv

from pipeline.judge import (
    _CASE_COLUMNS,
    VECTORS,
    _expected_cases,
    _validate_case_coverage,
    anthropic_complete,
    build_judge_prompt,
    load_rubric,
    parse_judge_output,
)

# per-vector: (top-level artifact list key, item -> case-group key)
SUBSETTABLE = {
    "v1": ("chains", lambda c: str(c["storyline"]["storyline_id"])),
    "v2": ("themes", lambda t: str(t["theme_id"])),
    "v3": ("category_storyline_pairs",
           lambda p: str(p["storyline"]["storyline_id"])),
    "v6": ("episodes", lambda e: str(e["episode_id"])),
    "v7": ("overviews", lambda o: str(o["storyline_id"])),
}
REINFORCE = (
    "\n\nFormat reinforcement: output EXACTLY one row per case in the "
    "artifact for each file — count the cases and match that count. "
    "Double-quote every reason field."
)
MAX_TOPUPS = 3


def lenient_rows(csv_text: str, columns: list[str]) -> list[dict]:
    """Parse judge CSV; rejoin overflow fields into the trailing column."""
    rows = []
    reader = csv.reader(io.StringIO(csv_text))
    header = next(reader)
    if header != columns:
        raise ValueError(f"unexpected header {header!r}")
    for raw in reader:
        if not raw:
            continue
        if len(raw) > len(columns):
            raw = raw[: len(columns) - 1] + [",".join(raw[len(columns) - 1:])]
        if len(raw) < len(columns):
            raw = raw + [""] * (len(columns) - len(raw))
        rows.append(dict(zip(columns, raw)))
    return rows


def dispatch(vector: str, artifact: dict, complete, rubric: str) -> dict[str, list[dict]]:
    files = VECTORS[vector]["files"]
    system, user = build_judge_prompt(rubric, files, json.dumps(artifact, indent=1))
    parsed = parse_judge_output(complete(system + REINFORCE, user))
    out = {}
    for name, columns in files.items():
        if name not in parsed:
            raise ValueError(f"judge output missing file {name!r}")
        out[name] = lenient_rows(parsed[name], columns)
    return out


def run(vector: str, artifacts: Path, verdicts: Path) -> None:
    list_key, group = SUBSETTABLE[vector]
    artifact = json.loads((artifacts / VECTORS[vector]["artifact"]).read_text())
    expected = _expected_cases(vector, artifact)
    rubric = load_rubric(vector)
    complete = anthropic_complete()
    items = artifact[list_key]
    print(f"dispatching {vector}: {len(items)} items", flush=True)

    kept: dict[str, dict[tuple, dict]] = {name: {} for name in expected}

    def absorb(got: dict[str, list[dict]]) -> None:
        for name, rows in got.items():
            if name not in expected:
                continue
            case_columns = _CASE_COLUMNS[name]
            for row in rows:
                key = tuple(str(row[column]) for column in case_columns)
                if key in expected[name] and key not in kept[name]:
                    kept[name][key] = row

    def missing_groups() -> set[str]:
        return {key[0] for name in expected
                for key in expected[name] - set(kept[name])}

    absorb(dispatch(vector, artifact, complete, rubric))
    for attempt in range(MAX_TOPUPS):
        missing = missing_groups()
        if not missing:
            break
        subset = dict(artifact)
        subset[list_key] = [item for item in items if group(item) in missing]
        print(f"top-up {attempt + 1}: {len(missing)} case groups", flush=True)
        absorb(dispatch(vector, subset, complete, rubric))

    if missing_groups():
        raise SystemExit(f"{vector}: cases still missing after {MAX_TOPUPS} "
                         f"top-ups: {sorted(missing_groups())[:3]}")

    files_out = {}
    for name in expected:
        columns = VECTORS[vector]["files"][name]
        ordered = [kept[name][key] for key in sorted(kept[name])]
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(ordered)
        files_out[name] = buffer.getvalue().strip()
    _validate_case_coverage(vector, json.dumps(artifact), files_out)
    for name, text in files_out.items():
        (verdicts / name).write_text(text + "\n")
        print(f"wrote {name} ({len(kept[name])} rows)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("vector", choices=sorted(SUBSETTABLE))
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--verdicts", required=True)
    args = parser.parse_args()
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    verdicts = Path(args.verdicts)
    verdicts.mkdir(parents=True, exist_ok=True)
    run(args.vector, Path(args.artifacts), verdicts)


if __name__ == "__main__":
    main()
