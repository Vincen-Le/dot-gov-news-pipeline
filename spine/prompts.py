"""Spine prompt builders. All verdicts are strict JSON."""

from __future__ import annotations

import json

SPINE_ENRICHER_SYSTEM = (
    "Compress the article into exactly ONE sentence optimized for semantic "
    "search. Hard requirements: preserve every named agency, person, program, "
    "place, and date verbatim; state the concrete action (who did what to "
    "whom, with numbers if present); no editorializing, no vague abstractions "
    "like 'officials announced changes'. Output only the sentence."
)

LINK_SYSTEM = (
    "You link government news articles into storylines (chains of episodes "
    "about one evolving real-world matter). Given a new article and candidate "
    "storylines, respond with strict JSON: "
    '{"match": <candidate index or null>, "same_development": <bool>, '
    '"reason": "<one sentence>"}. '
    "match is the index of the storyline this article continues — the same "
    "specific evolving matter, not merely the same topic or agency. Use null "
    "if none qualify (prefer null when unsure; over-merging is worse than "
    "splitting). same_development is true only if the article reports the "
    "same concrete development as the storyline's latest coverage (a "
    "follow-up, restatement, or detail of it), false if it is a new "
    "development in the same storyline."
)

THEME_SYSTEM = (
    "You review a proposed theme: a group of storylines that may share a "
    "recurring pattern (same policy area, campaign, or recurring activity). "
    'Respond with strict JSON: {"theme": <bool>, "name": "<3-8 word title '
    'case name>", "reason": "<one sentence>"}. theme is true only if a '
    "clear majority of the storylines share one nameable pattern a reader "
    "would want to follow; the name must describe the pattern, not one event."
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


def build_theme_prompt(members: list[dict]) -> tuple[str, str]:
    lines = ["PROPOSED THEME MEMBERS:"]
    lines += [f"  - {m['headline']}" for m in members]
    lines.append("\nJSON verdict:")
    return THEME_SYSTEM, "\n".join(lines)


def link_cache_parts(entry: dict, candidates: list[dict]) -> list:
    """Content-stable cache key parts — never row ids."""
    return [entry["content_hash"],
            [(c["headline"], c["summary"], str(c["newest_entry_at"]))
             for c in candidates]]
