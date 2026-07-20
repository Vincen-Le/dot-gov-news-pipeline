"""Salient-discriminator extraction (entity guard) + hard event keys.

Pure, versioned: same (title, summary, body, EXTRACTOR_VERSION) -> identical
output on any instance, any replay. Runs on RAW feed text only — never
enriched text. Subtractive by design: the wide capitalization net is filtered
by frozen lexicons; survivors are event-specific names (drugs, companies,
IDs, amounts).

Scoping: entities come from title + the first prose sentence (noise control) —
from the summary, falling back to the body when the summary yields none
(nav-blob or missing); event keys scan the full title + summary-or-body
(hard IDs are reliable anywhere).
"""

from __future__ import annotations

import re
import unicodedata

EXTRACTOR_VERSION = 4

# v4: (a) wire datelines ("FRANKFORT, Ky. – ...") — the abbreviation period
# ended first-sentence detection one word into the prose, and the ALL-CAPS
# city was invisible to the cap-span net. The dateline marks where prose
# actually starts: scope the entity sentence to the text after it and keep
# the city as an entity candidate. (b) body fallback — a summary that yields
# no prose sentence (nav-blob or missing) falls back to the body's lede.

# v2: CFR citations dropped (legal-authority references shared by unrelated
# notices — 36 CFR 261.50 appeared in 6 different park announcements) and bare
# "No. XX-XX" now requires case/docket context (release-numbering boilerplate
# like BLS "No. 23-01" glued unrelated chains via the tier-1 event-key attach).
_EVENT_KEY_PATTERNS = [
    re.compile(r"\bCVE-\d{4}-\d{4,7}\b", re.IGNORECASE),                       # CVEs
    re.compile(r"\b[A-Z]{2,6}(?:-[A-Z]{1,6})*-\d{4}-\d{3,5}(?:-\d{1,6})?\b"),  # dockets
    re.compile(r"\b(?<!-)\d{4}-\d{5,6}\b"),                                    # FR doc numbers
    re.compile(r"\b[ZF]-\d{4}-\d{2,4}\b"),                                     # FDA recall numbers
    re.compile(r"\b(?:case|docket)\s+no\.\s?\d{2}-\d{2,5}\b", re.IGNORECASE),  # court case numbers (context-anchored)
]

_DOLLAR = re.compile(r"\$\d[\d,.]*(?:\s?(?:million|billion|trillion))?", re.IGNORECASE)
_CAP_SPAN = re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b")

_AGENCY_LEXICON = frozenset("""
fda hhs epa cdc nih usda doj dhs dod doe dot va ssa irs gsa nasa noaa fema cms
department departments administration agency agencies office offices bureau
bureaus commission federal national united states secretary center centers
institute institutes service services treasury
""".split())

_BOILERPLATE_LEXICON = frozenset("""
announces announcement announced statement statements recall recalls notice
notices press release releases update updated updates news alert alerts issues
issued proposes proposed final rule rules regulation regulations report reports
officials designate designates designated launches launched celebrates
celebrating meets meeting knows opens closes remarks readout briefing
chronology photo photos video videos podcast blog webinar factsheet
january february march april may june july august september october
november december monday tuesday wednesday thursday friday saturday sunday
today yesterday tomorrow week weekly month monthly year yearly annual daily
quarterly fiscal nationwide public
""".split())

_COMMON_ENGLISH = frozenset("""
blood pressure medication drug drugs company companies million billion state
states people american americans health safety program programs funding grant
grants water air food act law court case plan effort action actions
here there this that these those what when where which while who whom why how
about above after again against because before between during into more most
learn read click visit contact information article explains look first second
third last next new old data mass distribution results review overview
employment unemployment jobs benefits families working children changes
event events episode series story stories partnership dialogue economic
prosperity international official website government since takes over recent
dear colleague call calls watch highlights hiring apparent role sept
abraham acting address advisory affected america anniversary apply approves
area assets assistance atlantic available based beautiful bill birthplace blue
board bruce california canyon cape care carolina ceremony chemical chronic
colorado commemoration comment committee commodity competition conservation
credit crews crypto deceptive deputy director disaster disease draft education
exchange exclusive explosion extension fatal financial fire fisheries flooding
foreign former fraud from futures gorge governor guidance historic historical
homeland human investigation island joint jurisdiction justice labor left major
marco marine minister monument north park president readiness recovery reducing
repair response river robert science securities security severe site species
spokesperson sues support tank temporary terrorism than tips tornadoes tourism
trade trading under urgent veteran veterans virus volcano washington
""".split())

_MIN_LEN = 4


_NAV_BLOB_HORIZON = 240

# ALL-CAPS city (one or more words), optional ", St." abbreviation, then a
# spaced dash. Only searched within the nav-blob horizon: a genuine wire
# dateline sits at the head of the prose, not deep inside it.
_DATELINE = re.compile(
    r"\b([A-Z][A-Z'.-]+(?:\s+[A-Z][A-Z'.-]+)*)"
    r"(?:,\s*[A-Z][A-Za-z]{0,5}\.?)?"
    r"\s+[–—-]\s+"
)


def _first_sentence(text: str | None) -> str:
    """First sentence of the summary — or nothing if the text does not read
    like prose. Nav-blob guard: feed summaries that lead with site navigation
    (long capitalized runs with no sentence punctuation, e.g. state.gov) must
    contribute no entity candidates."""
    text = text or ""
    match = re.search(r"[.!?](\s|$)", text)
    if not match or match.start() > _NAV_BLOB_HORIZON:
        return ""
    return text[: match.start() + 1]


_BODY_CAP = 4000  # the event is in the lede; the tail is page chrome


def _prose_window(text: str | None) -> tuple[str, str]:
    """(first prose sentence, dateline city) of a text, stepping over a
    leading wire dateline."""
    text = text or ""
    dateline_city = ""
    dateline = _DATELINE.search(text[:_NAV_BLOB_HORIZON])
    if dateline:
        dateline_city = dateline.group(1)
        text = text[dateline.end():]
    return _first_sentence(text), dateline_city


def extract(title: str | None, summary: str | None,
            body: str | None = None) -> tuple[list[str], list[str]]:
    body = (body or "")[:_BODY_CAP]
    full_text = unicodedata.normalize("NFKC", (title or "") + ". " + (summary or body))

    sentence, dateline_city = _prose_window(summary)
    if not sentence and not dateline_city:
        sentence, dateline_city = _prose_window(body)
    entity_text = unicodedata.normalize("NFKC", (title or "") + ". " + sentence)

    keys: set[str] = set()
    for pattern in _EVENT_KEY_PATTERNS:
        for match in pattern.findall(full_text):
            keys.add(re.sub(r"\s+", " ", match).strip().casefold())

    entities: set[str] = set()
    for match in _DOLLAR.findall(entity_text):
        entities.add(re.sub(r"\s+", " ", match).strip().casefold())

    candidate_tokens = [token for span in _CAP_SPAN.findall(entity_text) for token in span.split()]
    candidate_tokens += dateline_city.split()
    for token in candidate_tokens:
        word = token.strip(".,;:'\"()").casefold()
        if len(word) < _MIN_LEN:
            continue
        if word in _AGENCY_LEXICON or word in _BOILERPLATE_LEXICON or word in _COMMON_ENGLISH:
            continue
        entities.add(word)

    return sorted(entities)[:64], sorted(keys)[:16]
