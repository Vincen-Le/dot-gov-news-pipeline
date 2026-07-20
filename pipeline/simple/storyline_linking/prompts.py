"""Listwise storyline-link judge prompt and cache contract."""

from __future__ import annotations

# Workers AI JSON mode schemas — see pipeline/shared/prompts.py for rationale.
# No union types ("type": [..., "null"]): Workers AI's constrained decoder
# hangs or 403s on them (observed 2026-07-19, 56 corrupted link verdicts in
# one run). Nullable semantics use sentinels instead: match -1 = none.
LINK_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "match": {"type": "integer"},
        "same_development": {"type": "boolean"},
        "reason": {"type": "string"},
    },
    "required": ["match", "same_development", "reason"],
}

LINK_SYSTEM = (
    "You link government news articles into storylines (chains of episodes "
    "about one evolving real-world matter). Given a new article and candidate "
    "storylines, respond with strict JSON: "
    '{"match": <candidate index, or -1 if none>, "same_development": <bool>, '
    '"reason": "<one sentence>"}. '
    "match is the index of the storyline this article continues — the same "
    "specific evolving matter, not merely the same topic or agency. Use -1 "
    "if none qualify (prefer -1 when unsure; over-merging is worse than "
    "splitting). same_development is true only if the article reports the "
    "same concrete development as the storyline's latest coverage (a "
    "follow-up, restatement, or detail of it), false if it is a new "
    "development in the same storyline."
)


def build_link_prompt(entry: dict, candidates: list[dict]) -> tuple[str, str]:
    lines = [
        "NEW ARTICLE:",
        f"  title: {entry['title']}",
        f"  gist: {entry.get('enriched_text') or ''}",
        f"  published: {entry['published_at']}",
        f"  entities: {', '.join(entry.get('entity_set') or [])}",
        "",
        "CANDIDATE STORYLINES:",
    ]
    for i, c in enumerate(candidates):
        lines += [
            f"  [{i}] {c['headline']}",
            f"      overview: {c['summary']}",
            f"      episodes so far: {c['episode_count']}; latest coverage: "
            f"{c['newest_entry_at']} ({c['gap_hours']} hours before this "
            "article)",
            f"      shared entities with article: "
            f"{', '.join(c['shared_entities']) or '(none)'}",
        ]
    lines.append("\nJSON verdict:")
    return LINK_SYSTEM, "\n".join(lines)


def link_cache_parts(entry: dict, candidates: list[dict]) -> list:
    """Content-stable cache key parts — never row ids. The prompt varies with
    the full entry payload (title/enriched_text/published_at/entity_set/
    content_hash) and full candidate payloads (headline/summary/
    newest_entry_at/gap_hours/shared_entities/episode_count), so key on both
    payload dicts in full — neither carries a row id (see
    pipeline/simple/storyline_linking/linker.py's _entry_payload and
    _candidate_payload) — and let the caller's sha256-over-
    sorted-json handle stability."""
    return [entry, candidates]
