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
    "A shared holiday, anniversary, observance, or umbrella initiative is not "
    "the same specific event; that relationship belongs at the theme level. "
    "Items about different actions under the same program are separate unless "
    "one is a direct update in the same concrete rollout, case, incident, or decision. "
    "When uncertain, answer false. "
    'Respond with JSON only: {"same_event": boolean, "reason": "one sentence"}'
)

COMPRESSOR_SYSTEM = (
    "You compress a chain of related US government news episodes into an overview card. "
    "Keep the summary to 1-2 tight sentences. "
    "Respond with JSON only, schema: "
    '{"headline": string, "summary": string (1-2 sentences), '
    '"timeline": [{"episode_id": string, "date": "YYYY-MM-DD", "text": string}], '
    '"rubric": {' + ", ".join(f'"{c}": 0 or 1' for c in RUBRIC_CRITERIA) + '}, '
    '"reason": "one sentence explaining the rubric"}. '
    "Every timeline item MUST cite one episode_id from the input verbatim. "
    "Use only facts present in the input episodes. "
    "Rubric bits evaluate the entire chain of episodes collectively — "
    "the cumulative real-world event, not only the latest development."
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


THEME_SCOPE_GUIDANCE = (
    "A theme must be more specific than a category but exactly one level more "
    "general than a single storyline. It must plausibly group several distinct "
    "real-world events, not merely restate the first event. Use a compact label "
    "2-5 words long. Do not copy incidental named entities from the storyline, including "
    "agencies, officials, companies, products, case numbers, or specific places. "
    "A proper name is allowed only when that name is itself the durable umbrella "
    "initiative or observance spanning multiple independent events, such as "
    "'America 250' or 'Trump Accounts'. For example, do not create 'Tijuana River Water Cleanup'; "
    "step up to 'Cross-Border Water Pollution'. Do not include punctuation or quotes. "
    "Also do not step up so far that the label becomes an agency or category bucket: "
    "'National Park Events' and 'Environmental Protection Efforts' are too broad. "
)

CATEGORY_ASSIGNMENT_GUIDANCE = (
    "For categories, choose by subject matter, not the publishing agency. Keep the "
    "same durable program or recurring subject in one category across storylines. "
)

CATEGORY_DESCRIPTIONS = {
    "Justice & Law Enforcement": (
        "general consumer-protection and antitrust enforcement, criminal "
        "investigations, prosecutions, policing, and sanctions enforcement"
    ),
    "Financial Regulation": (
        "securities, banking, capital markets, investment advisers, exchanges, "
        "and financial-institution oversight; not general consumer enforcement"
    ),
    "Veterans Affairs": (
        "programs, benefits, health care, employment support, and recognition "
        "specifically for veterans"
    ),
    "Economy & Labor": (
        "economy-wide employment, wages, workplaces, workforce policy, and business conditions"
    ),
    "Public Health": (
        "population health, disease, treatment, prevention, and health services "
        "not specific to a dedicated beneficiary category"
    ),
}

THEME_CREATOR_SYSTEM = (
    "You create a topic theme and assign its broad seeded category for one US "
    "government news storyline. " + THEME_SCOPE_GUIDANCE +
    CATEGORY_ASSIGNMENT_GUIDANCE +
    "You must copy exactly one category_id from the provided seeded categories; "
    "never invent a category or return null. "
    'Respond with JSON only: {"theme_name": string, "category_id": string, '
    '"reason": "one sentence explaining the abstraction and category"}'
)


def _shape_seed_categories(categories: list[dict]) -> list[dict]:
    return [
        {"category_id": c["id"], "name": c["display_name"],
         "guidance": CATEGORY_DESCRIPTIONS.get(c["display_name"], "")}
        for c in categories if c.get("origin") == "seed"
    ]


def build_theme_creator_prompt(storyline: dict,
                               categories: list[dict]) -> tuple[str, str]:
    user = (
        f"Storyline headline: {storyline['headline']}\n"
        f"Storyline summary: {storyline.get('summary') or '(none)'}\n\n"
        "Seeded categories (choose exactly one category_id):\n" +
        json.dumps(_shape_seed_categories(categories), indent=2)
    )
    return THEME_CREATOR_SYSTEM, user


RANK_AUDIT_SYSTEM = (
    "You compare two US government news storylines and decide which one is "
    "more important for a general national audience to see first in a ranked "
    "news feed. Consider real-world impact, public health and safety, scope, "
    "urgency, and novelty. Each item lists its corroboration (distinct "
    "agencies, feeds, entries) and its age in hours — newer and more "
    "corroborated stories matter more, but importance can outweigh age. "
    'Respond with JSON only: {"prefers": "A" or "B", "reason": "one sentence"}'
)


def build_rank_audit_prompt(a: dict, b: dict) -> tuple[str, str]:
    def shape(item: dict) -> dict:
        return {
            "headline": item["headline"],
            "summary": (item.get("summary") or "")[:800],
            "agencies": item["agencies"],
            "feeds": item["feeds"],
            "entries": item["entries"],
            "age_hours": item["age_hours"],
        }
    user = ("Item A:\n" + json.dumps(shape(a), indent=2)
            + "\n\nItem B:\n" + json.dumps(shape(b), indent=2))
    return RANK_AUDIT_SYSTEM, user


THEME_ADJUDICATOR_SYSTEM = (
    "You assign a US government news storyline to a topic theme. Themes are "
    "recurring subjects, not broad departments or document styles. Join a candidate "
    "only when the storyline fits that reusable subject; a shared agency, entity, "
    "or press-release boilerplate is not enough. Otherwise spawn a new theme. "
    "Do not join a category-like theme merely because the storyline is related; "
    "the storyline and every listed recent headline must fit the theme's reusable subject. "
    "For every spawned theme, follow this naming rubric: " + THEME_SCOPE_GUIDANCE +
    CATEGORY_ASSIGNMENT_GUIDANCE +
    "When spawning, copy exactly one category_id from the provided seeded "
    "categories; never invent a category or return null. "
    "Separately, if two or more candidates clearly name the same subject, list "
    "them in merge_theme_ids. "
    'Respond with JSON only: {"decision": "join" or "spawn", '
    '"theme_id": string or null (copy one candidate theme_id verbatim, only when join), '
    '"new_theme_name": string or null (only when spawn), '
    '"category_id": string or null (copy a seeded category_id, only when spawn), '
    '"merge_theme_ids": [candidate theme_ids naming the same subject] or [], '
    '"reason": "one sentence"}'
)


def build_theme_adjudicator_prompt(storyline: dict,
                                   candidates: list[dict],
                                   categories: list[dict]) -> tuple[str, str]:
    shaped = [
        {"theme_id": c["theme_id"], "name": c["name"],
         "storyline_count": c["storyline_count"],
         "recent_headlines": c["recent_headlines"]}
        for c in candidates
    ]
    user = (
        f"Storyline headline: {storyline['headline']}\n"
        f"Storyline summary: {storyline.get('summary') or '(none)'}\n\n"
        "Candidate themes:\n" + json.dumps(shaped, indent=2) +
        "\n\nSeeded categories (required only when spawning):\n" +
        json.dumps(_shape_seed_categories(categories), indent=2)
    )
    return THEME_ADJUDICATOR_SYSTEM, user


THEME_PAIR_ADJUDICATOR_SYSTEM = (
    "You decide whether two existing US government news themes represent the "
    "same reusable subject and should be merged. Shared category, agency, document "
    "style, or generic words are not enough. Merge durable umbrella programs or "
    "subjects whose member headlines would all fit one compact label. Keep related "
    "but distinct subjects separate. " + THEME_SCOPE_GUIDANCE +
    CATEGORY_ASSIGNMENT_GUIDANCE +
    "When merging, provide one canonical name and copy exactly one seeded category_id. "
    'Respond with JSON only: {"same_theme": boolean, "canonical_name": string or null, '
    '"category_id": string or null, "reason": "one sentence"}'
)


def build_theme_pair_adjudicator_prompt(
        a: dict, b: dict, categories: list[dict]) -> tuple[str, str]:
    user = (
        "Theme A:\n" + json.dumps(a, indent=2) +
        "\n\nTheme B:\n" + json.dumps(b, indent=2) +
        "\n\nSeeded categories (required when merging):\n" +
        json.dumps(_shape_seed_categories(categories), indent=2)
    )
    return THEME_PAIR_ADJUDICATOR_SYSTEM, user
