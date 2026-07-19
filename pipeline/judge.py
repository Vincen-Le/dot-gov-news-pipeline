"""Anthropic judge client for the one-pass eval (clustering-eval skill).

Blinding contract: a judge call carries ONLY the vector's rubric, the CSV
output contract, and the artifact JSON — never the hypothesis, config delta,
or intruder truth. The judge model must differ from the pipeline's
Cloudflare llama models (self-preference bias); default is Claude via the
Anthropic API (ANTHROPIC_API_KEY, loaded from .env by pipeline.config).
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
from pathlib import Path

DEFAULT_JUDGE_MODEL = "claude-opus-4-8"
SKILL_DIR = Path(".claude/skills/clustering-eval")

# One entry per blinded judge dispatch: rubric section, artifact input,
# expected verdict CSVs. Column contracts must match pipeline.evals scoring.
VECTORS: dict[str, dict] = {
    "v1": {
        "rubric": ("multi-episode-scoring.md", "## V1"),
        "artifact": "v1.json",
        "files": {
            "chain-verdicts.csv": ["storyline_id", "episode_id", "related",
                                   "attach_method", "reason"],
            "chain-summary.csv": ["storyline_id", "endpoints_related",
                                  "chain_verdict", "reason"],
        },
    },
    "v2": {
        "rubric": ("theme_scoring.md", "## V2"),
        "artifact": "v2.json",
        "files": {
            "theme-verdicts.csv": ["theme_id", "storyline_id", "fits", "reason"],
            "theme-granularity.csv": ["theme_id", "granularity", "probe_label",
                                      "members_gained", "reason"],
        },
    },
    "v3": {
        "rubric": ("scoring.md", "## V3"),
        "artifact": "v3.json",
        "files": {
            "category-verdicts.csv": ["storyline_id", "theme_id", "filed_category",
                                      "verdict", "suggested_category", "reason"],
        },
    },
    "v4": {
        "rubric": ("theme_scoring.md", "## V4"),
        "artifact": "v4.json",
        "files": {
            "granularity-merge-verdicts.csv": ["theme_a_id", "theme_b_id",
                                               "should_merge", "reason"],
        },
    },
    "v5": {
        "rubric": ("scoring.md", "## V5"),
        "artifact": "v5.json",
        "files": {
            "entity-stats-verdicts.csv": ["entity", "valid", "reason"],
            "entity-verdicts.csv": ["entry_id", "kind", "token", "valid", "reason"],
            "entity-misses.csv": ["entry_id", "missed_entity"],
        },
    },
    "v6": {
        "rubric": ("multi-episode-scoring.md", "## V6"),
        "artifact": "v6.json",
        "files": {
            "episode-verdicts.csv": ["episode_id", "entry_id", "same_event", "reason"],
        },
    },
    "v7": {
        "rubric": ("multi-episode-scoring.md", "## V7"),
        "artifact": "v7.json",
        "files": {
            "overview-verdicts.csv": ["storyline_id", "coverage", "faithful",
                                      "current", "representative", "reason"],
        },
    },
}


def load_rubric(vector: str, skill_dir: Path | None = None) -> str:
    """Extract a vector's rubric section ('## Vn ...' to the next '## ')."""
    filename, heading = VECTORS[vector]["rubric"]
    text = ((skill_dir or SKILL_DIR) / filename).read_text()
    start = text.index(heading)
    end = text.find("\n## ", start + 1)
    return text[start:end if end != -1 else len(text)].strip()

_SYSTEM_TEMPLATE = """You are a blinded evaluation judge for a news-clustering pipeline. \
Judge ONLY the artifact data in the user message against the rubric below. \
Do not speculate about how the data was produced.

## Rubric

{rubric}

## Output contract

Return one CSV per output file, each as:

FILE: <filename>
```csv
<header row exactly as specified>
<one row per verdict>
```

Required files and their exact header rows:
{file_specs}

Every case in the artifact must receive a verdict row. Reasons must be one \
short sentence. Double-quote any CSV field that contains a comma. No text \
outside the FILE blocks is read."""

_FILE_RE = re.compile(r"FILE:\s*(\S+)\s*\n```(?:csv)?\n(.*?)```", re.DOTALL)


def build_judge_prompt(rubric: str, files: dict[str, list[str]],
                       artifact_json: str) -> tuple[str, str]:
    lines = []
    for name, cols in files.items():
        allowed = _VALUE_COLUMNS.get(name, {})
        vocab = "".join(
            f"; {col} must be one of: {', '.join(sorted(values))}"
            for col, values in allowed.items())
        lines.append(f"- {name}: `{','.join(cols)}`{vocab}")
    specs = "\n".join(lines)
    return _SYSTEM_TEMPLATE.format(rubric=rubric, file_specs=specs), artifact_json


def parse_judge_output(text: str) -> dict[str, str]:
    return {name: body.strip() for name, body in _FILE_RE.findall(text)}


def _expected_cases(vector: str, artifact: dict) -> dict[str, set[tuple[str, ...]]]:
    """Return the exact case keys every fixed-cardinality verdict file must cover."""
    if vector == "v1":
        chains = artifact.get("chains") or []
        return {
            "chain-verdicts.csv": {
                (str(chain["storyline"]["storyline_id"]), str(episode["episode_id"]))
                for chain in chains for episode in (chain.get("episodes") or [])[1:]
            },
            "chain-summary.csv": {
                (str(chain["storyline"]["storyline_id"]),) for chain in chains
            },
        }
    if vector == "v2":
        themes = artifact.get("themes") or []
        return {
            "theme-verdicts.csv": {
                (str(theme["theme_id"]), str(storyline["storyline_id"]))
                for theme in themes for storyline in theme.get("storylines") or []
            },
            "theme-granularity.csv": {
                (str(theme["theme_id"]),) for theme in themes
            },
        }
    if vector == "v3":
        return {
            "category-verdicts.csv": {
                (str(pair["storyline"]["storyline_id"]), str(pair["theme_id"]))
                for pair in artifact.get("category_storyline_pairs") or []
            }
        }
    if vector == "v4":
        return {
            "granularity-merge-verdicts.csv": {
                (str(pair["theme_a"]["theme_id"]),
                 str(pair["theme_b"]["theme_id"]))
                for pair in artifact.get("merge_candidates") or []
            }
        }
    if vector == "v5":
        sampled = artifact.get("sampled_entries") or []
        return {
            "entity-stats-verdicts.csv": {
                (str(row["entity"]),) for row in artifact.get("top_entity_stats") or []
            },
            "entity-verdicts.csv": {
                (str(entry["entry_id"]), kind, str(token))
                for entry in sampled
                for kind, tokens in (("entity", entry.get("entities") or []),
                                     ("event_key", entry.get("event_keys") or []))
                for token in tokens
            },
        }
    if vector == "v6":
        return {
            "episode-verdicts.csv": {
                (str(episode["episode_id"]), str(entry["entry_id"]))
                for episode in artifact.get("episodes") or []
                for entry in (episode.get("entries") or [])[1:]
            }
        }
    if vector == "v7":
        return {
            "overview-verdicts.csv": {
                (str(overview["storyline_id"]),)
                for overview in artifact.get("overviews") or []
            }
        }
    raise ValueError(f"unknown judge vector {vector!r}")


_CASE_COLUMNS = {
    "chain-verdicts.csv": ("storyline_id", "episode_id"),
    "chain-summary.csv": ("storyline_id",),
    "theme-verdicts.csv": ("theme_id", "storyline_id"),
    "theme-granularity.csv": ("theme_id",),
    "category-verdicts.csv": ("storyline_id", "theme_id"),
    "granularity-merge-verdicts.csv": ("theme_a_id", "theme_b_id"),
    "entity-stats-verdicts.csv": ("entity",),
    "entity-verdicts.csv": ("entry_id", "kind", "token"),
    "episode-verdicts.csv": ("episode_id", "entry_id"),
    "overview-verdicts.csv": ("storyline_id",),
}

# binary verdicts are emitted as 1 (yes) / 0 (no) so scoring is direct
# arithmetic over the columns (2026-07-19 review decision)
_VALUE_COLUMNS: dict[str, dict[str, set[str]]] = {
    "chain-verdicts.csv": {"related": {"1", "0"}},
    "chain-summary.csv": {
        "endpoints_related": {"1", "0"},
        "chain_verdict": {"coherent", "drifted", "should_split"},
    },
    "theme-verdicts.csv": {"fits": {"1", "0"}},
    "theme-granularity.csv": {
        "granularity": {"right", "too_granular", "too_broad"},
    },
    "category-verdicts.csv": {
        "verdict": {"correct", "better_option_exists", "ambiguous"},
    },
    "granularity-merge-verdicts.csv": {"should_merge": {"1", "0"}},
    "entity-stats-verdicts.csv": {"valid": {"1", "0"}},
    "entity-verdicts.csv": {
        "kind": {"entity", "event_key"},
        "valid": {"1", "0"},
    },
    "episode-verdicts.csv": {"same_event": {"1", "0"}},
    "overview-verdicts.csv": {
        "coverage": {"1", "0"},
        "faithful": {"1", "0"},
        "current": {"1", "0"},
        "representative": {"1", "0"},
    },
}


def _validate_categorical_values(name: str, rows: list[dict[str, str]]) -> None:
    for column, allowed in _VALUE_COLUMNS.get(name, {}).items():
        for index, row in enumerate(rows, start=2):
            value = str(row[column]).strip().lower()
            if value not in allowed:
                raise ValueError(
                    f"{name}:{index}: invalid {column} {row[column]!r}; "
                    f"expected one of {sorted(allowed)}"
                )


def _validate_case_coverage(vector: str, artifact_json: str,
                            files: dict[str, str]) -> None:
    artifact = json.loads(artifact_json)
    expected_by_file = _expected_cases(vector, artifact)
    for name, expected in expected_by_file.items():
        reader = csv.DictReader(io.StringIO(files[name]))
        rows = list(reader)
        if any(None in row or any(value is None for value in row.values()) for row in rows):
            raise ValueError(f"{name}: malformed CSV row")
        _validate_categorical_values(name, rows)
        columns = _CASE_COLUMNS[name]
        actual_list = [tuple(str(row[column]) for column in columns) for row in rows]
        actual = set(actual_list)
        if len(actual) != len(actual_list):
            raise ValueError(f"{name}: duplicate verdict case")
        if actual != expected:
            missing = sorted(expected - actual)[:5]
            unexpected = sorted(actual - expected)[:5]
            raise ValueError(
                f"{name}: verdict cases mismatch; missing={missing}, "
                f"unexpected={unexpected}"
            )

    if vector == "v5":
        valid_entries = {
            str(entry["entry_id"]) for entry in artifact.get("sampled_entries") or []
        }
        reader = csv.DictReader(io.StringIO(files["entity-misses.csv"]))
        rows = list(reader)
        if any(None in row or any(value is None for value in row.values()) for row in rows):
            raise ValueError("entity-misses.csv: malformed CSV row")
        keys = [(str(row["entry_id"]), str(row["missed_entity"])) for row in rows]
        if len(set(keys)) != len(keys):
            raise ValueError("entity-misses.csv: duplicate missed entity")
        unexpected = sorted({entry_id for entry_id, _ in keys} - valid_entries)
        if unexpected:
            raise ValueError(
                f"entity-misses.csv: unexpected entry ids {unexpected[:5]}"
            )


def judge_vector(complete, rubric: str, files: dict[str, list[str]],
                 artifact_json: str, *, vector: str | None = None) -> dict[str, str]:
    """Run one blinded judge call; returns validated {filename: csv_text}.

    `complete(system, user) -> text` — see anthropic_complete for the real one.
    """
    system, user = build_judge_prompt(rubric, files, artifact_json)
    parsed = parse_judge_output(complete(system, user))
    out: dict[str, str] = {}
    for name, columns in files.items():
        if name not in parsed:
            raise ValueError(f"judge output missing file {name!r}")
        header = parsed[name].splitlines()[0].strip()
        if header != ",".join(columns):
            raise ValueError(f"{name}: unexpected header {header!r}")
        out[name] = parsed[name]
    if vector is not None:
        _validate_case_coverage(vector, artifact_json, out)
    return out


def anthropic_complete(model: str | None = None):
    """Build a complete(system, user) callable backed by the Anthropic API."""
    import anthropic

    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY from env
    model = model or os.environ.get("EVAL_JUDGE_MODEL", DEFAULT_JUDGE_MODEL)

    def complete(system: str, user: str) -> str:
        with client.messages.stream(
            model=model,
            max_tokens=64000,
            thinking={"type": "adaptive"},
            system=system,
            messages=[{"role": "user", "content": user}],
        ) as stream:
            message = stream.get_final_message()
        if message.stop_reason == "refusal":
            raise RuntimeError("judge request refused")
        if message.stop_reason == "max_tokens":
            raise RuntimeError("judge output truncated at max_tokens")
        return "".join(b.text for b in message.content if b.type == "text")

    return complete
