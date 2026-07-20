"""Theme confirmation and naming prompt contract."""

from __future__ import annotations

# Workers AI JSON mode schemas — see pipeline/shared/prompts.py for rationale.
# No union types: Workers AI's constrained decoder hangs or rejects them.
THEME_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "theme": {"type": "boolean"},
        "name": {"type": "string"},
        "reason": {"type": "string"},
    },
    "required": ["theme", "name", "reason"],
}

THEME_SYSTEM = (
    "You review a proposed theme: a group of storylines that may share a "
    "recurring pattern (same policy area, campaign, or recurring activity). "
    'Respond with strict JSON: {"theme": <bool>, "name": "<3-8 word title '
    'case name>", "reason": "<one sentence>"}. theme is true only if a '
    "clear majority of the storylines share one nameable pattern a reader "
    "would want to follow; the name must describe the pattern, not one event."
)


def build_theme_prompt(members: list[dict]) -> tuple[str, str]:
    lines = ["PROPOSED THEME MEMBERS:"]
    lines += [f"  - {m['headline']}" for m in members]
    lines.append("\nJSON verdict:")
    return THEME_SYSTEM, "\n".join(lines)
