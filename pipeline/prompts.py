from __future__ import annotations

import json

RUBRIC_CRITERIA = [
    "mass_impact", "health_safety", "economic", "policy_change",
    "rights_legal", "national_scope", "urgency", "novelty",
]

ENRICHER_SYSTEM = (
    "You rewrite US government news items into one dense, self-contained event "
    "description of 2-3 sentences for semantic search. Restate and contextualize "
    "what is stated; name the acting agency, the specific subject, and the action. "
    "Add no facts that are not in the input. Output only the description."
)

ADJUDICATOR_SYSTEM = (
    "You decide whether two US government news items describe the same specific "
    "real-world event. Answer true only if clearly the same specific event; "
    "different products, companies, cases, or locations = different events. "
    "When uncertain, answer false. "
    'Respond with JSON only: {"same_event": boolean, "reason": "one sentence"}'
)

COMPRESSOR_SYSTEM = (
    "You compress a chain of related US government news episodes into an overview card. "
    "Respond with JSON only, schema: "
    '{"headline": string, "summary": string (<= 3 sentences), '
    '"timeline": [{"episode_id": string, "date": "YYYY-MM-DD", "text": string}], '
    '"rubric": {' + ", ".join(f'"{c}": 0 or 1' for c in RUBRIC_CRITERIA) + '}, '
    '"reason": "one sentence explaining the rubric"}. '
    "Every timeline item MUST cite one episode_id from the input verbatim. "
    "Use only facts present in the input episodes."
)


def build_enricher_prompt(title: str, summary: str | None) -> tuple[str, str]:
    return ENRICHER_SYSTEM, f"Title: {title}\nSummary: {summary or '(none)'}"


def build_adjudicator_prompt(a: dict, b: dict, context: str) -> tuple[str, str]:
    user = (
        f"Item A title: {a['title']}\nItem A summary: {a.get('summary') or '(none)'}\n"
        f"Item A entities: {', '.join(a.get('entities', [])) or '(none)'}\n\n"
        f"Item B title: {b['title']}\nItem B summary: {b.get('summary') or '(none)'}\n"
        f"Item B entities: {', '.join(b.get('entities', [])) or '(none)'}"
    )
    if context:
        user += f"\n\nContext: {context}"
    return ADJUDICATOR_SYSTEM, user


def build_compressor_prompt(storyline_summary: dict, episode_cards: list[dict]) -> tuple[str, str]:
    episodes = [
        {"episode_id": str(c["episode_id"]), "date": c["date"], "headline": c["headline"], "summary": c["summary"]}
        for c in episode_cards
    ]
    return COMPRESSOR_SYSTEM, "Episodes (oldest first):\n" + json.dumps(episodes, indent=2)


def validate_timeline(timeline: list[dict], valid_episode_ids: set[str]) -> list[dict]:
    """Hallucination guard: drop bullets that do not cite a real member episode."""
    return [
        item for item in (timeline or [])
        if isinstance(item, dict) and str(item.get("episode_id")) in valid_episode_ids
    ]


THEME_ADJUDICATOR_SYSTEM = (
    "You organize US government news storylines into ongoing topic themes. "
    "Given one storyline and candidate themes, decide whether the storyline "
    "belongs to one of them. Join only when the storyline covers the same "
    "ongoing topic; when uncertain, do not join. "
    'Respond with JSON only: {"theme_id": string or null (copy verbatim from '
    'the candidates, null = none fit), "updated_name": string or null (a '
    "better display name — for a joined theme whose name should broaden, or "
    "a proposed name for a new theme when theme_id is null), "
    '"reason": "one sentence"}'
)

CATEGORY_CLASSIFIER_SYSTEM = (
    "You classify a US government news theme into one broad category. "
    "Prefer an existing category; propose a new one only when nothing fits. "
    'Respond with JSON only: {"category_id": string or null (copy verbatim), '
    '"new_category_name": string or null (only when category_id is null), '
    '"reason": "one sentence"}'
)


def build_theme_adjudicator_prompt(storyline: dict, candidates: list[dict]) -> tuple[str, str]:
    shaped = [
        {"theme_id": c["id"], "name": c["display_name"],
         "similarity": round(float(c["similarity"]), 2),
         "sample_headlines": c["headlines"][:5]}
        for c in candidates
    ]
    user = (
        f"Storyline headline: {storyline['headline']}\n"
        f"Storyline summary: {storyline.get('summary') or '(none)'}\n\n"
        "Candidate themes (closest first):\n" + json.dumps(shaped, indent=2)
    )
    return THEME_ADJUDICATOR_SYSTEM, user


def build_category_prompt(theme_name: str, storyline: dict,
                          categories: list[dict]) -> tuple[str, str]:
    shaped = [
        {"category_id": c["id"], "name": c["display_name"], "origin": c["origin"]}
        for c in categories
    ]
    user = (
        f"Theme: {theme_name}\n"
        f"Example storyline: {storyline['headline']} — "
        f"{storyline.get('summary') or '(none)'}\n\n"
        "Categories:\n" + json.dumps(shaped, indent=2)
    )
    return CATEGORY_CLASSIFIER_SYSTEM, user
