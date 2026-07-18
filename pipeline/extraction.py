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
department administration agency office bureau commission federal national
united states secretary center centers institute institutes service services
""".split())

_BOILERPLATE_LEXICON = frozenset("""
announces announcement announced statement statements recall recalls notice
notices press release releases update updates news alert alerts issues issued
proposes proposed final rule rules regulation regulations report reports
officials january february march april may june july august september october
november december monday tuesday wednesday thursday friday saturday sunday
today yesterday week month year nationwide public
""".split())

_COMMON_ENGLISH = frozenset("""
blood pressure medication drug drugs company companies million billion state
states people american americans health safety program funding grant grants
water air food act law court case plan effort action actions
""".split())

_MIN_LEN = 4


def _first_sentence(text: str | None) -> str:
    text = text or ""
    match = re.search(r"[.!?](\s|$)", text)
    return text[: match.start() + 1] if match else text


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
