"""Salient-discriminator extraction (entity guard) + hard event keys.

Pure, versioned: same (title, summary, EXTRACTOR_VERSION) -> identical output
on any instance, any replay. Runs on RAW title/summary only — never enriched
text. Subtractive by design: the wide capitalization net is filtered by frozen
lexicons; survivors are event-specific names (drugs, companies, IDs, amounts).

Scoping: entities come from title + first summary sentence (noise control);
event keys scan the full title + summary (hard IDs are reliable anywhere).
"""

from __future__ import annotations

import re
import unicodedata

EXTRACTOR_VERSION = 1

_EVENT_KEY_PATTERNS = [
    re.compile(r"\bCVE-\d{4}-\d{4,7}\b", re.IGNORECASE),                       # CVEs
    re.compile(r"\b[A-Z]{2,6}(?:-[A-Z]{1,6})*-\d{4}-\d{3,5}(?:-\d{1,6})?\b"),  # dockets
    re.compile(r"\b(?<!-)\d{4}-\d{5,6}\b"),                                    # FR doc numbers
    re.compile(r"\b\d{1,3}\s?CFR\s?(?:Part\s?)?\d+(?:\.\d+)?\b", re.IGNORECASE),
    re.compile(r"\b[ZF]-\d{4}-\d{2,4}\b"),                                     # FDA recall numbers
    re.compile(r"\bNo\.\s?\d{2}-\d{2,5}\b"),                                   # case numbers
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
""".split())

_MIN_LEN = 4


_NAV_BLOB_HORIZON = 240


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


def extract(title: str | None, summary: str | None) -> tuple[list[str], list[str]]:
    full_text = unicodedata.normalize("NFKC", (title or "") + ". " + (summary or ""))
    entity_text = unicodedata.normalize("NFKC", (title or "") + ". " + _first_sentence(summary))

    keys: set[str] = set()
    for pattern in _EVENT_KEY_PATTERNS:
        for match in pattern.findall(full_text):
            keys.add(re.sub(r"\s+", " ", match).strip().casefold())

    entities: set[str] = set()
    for match in _DOLLAR.findall(entity_text):
        entities.add(re.sub(r"\s+", " ", match).strip().casefold())

    for span in _CAP_SPAN.findall(entity_text):
        for token in span.split():
            word = token.strip(".,;:'\"()").casefold()
            if len(word) < _MIN_LEN:
                continue
            if word in _AGENCY_LEXICON or word in _BOILERPLATE_LEXICON or word in _COMMON_ENGLISH:
                continue
            entities.add(word)

    return sorted(entities)[:64], sorted(keys)[:16]
