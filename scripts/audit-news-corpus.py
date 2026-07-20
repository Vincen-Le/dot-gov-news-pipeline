#!/usr/bin/env python3
"""Read-only whole-corpus topology and seeded-category estimator.

This intentionally does not call the enrichment, embedding, or clustering
write paths.  It downloads the hosted raw corpus, assigns one of the seeded
topic categories with audited lexical/publisher rules, then builds conservative
candidate storylines from repeated identifiers, rare terms, and text overlap.
Episodes use the production four-hour dormancy window; exact-content duplicate
evidence remains eligible for 72 hours, matching the pipeline configuration.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import itertools
import json
import math
import os
import re
from typing import Iterable

import httpx
from dotenv import load_dotenv

from pipeline.shared.extraction import extract as extract_anchors


SEEDED_CATEGORIES = (
    "Immigration & Border",
    "Public Health",
    "Food & Drug Safety",
    "Defense & Military",
    "Veterans Affairs",
    "Justice & Law Enforcement",
    "Courts & Legal Rulings",
    "Economy & Labor",
    "Taxes & Revenue",
    "Financial Regulation",
    "Energy & Environment",
    "Transportation & Infrastructure",
    "Education",
    "Housing & Urban Development",
    "Social Security & Benefits",
    "Science & Space",
    "Technology & Cybersecurity",
    "Elections & Government Operations",
    "Foreign Affairs & Trade",
    "Disaster Response & Emergency",
    "Agriculture",
    "Civil Rights & Liberties",
    "Public Lands & Natural Resources",
)


PUBLISHER_PRIORS: dict[str, dict[str, float]] = {
    "bls": {"Economy & Labor": 9},
    "cdc": {"Public Health": 9},
    "cftc": {"Financial Regulation": 9},
    "csb": {"Energy & Environment": 6, "Transportation & Infrastructure": 4},
    "doj": {"Justice & Law Enforcement": 8},
    "epa": {"Energy & Environment": 9},
    "fda": {"Food & Drug Safety": 10},
    "fema": {"Disaster Response & Emergency": 10},
    "fsa": {"Agriculture": 10},
    "ftc": {"Justice & Law Enforcement": 7, "Financial Regulation": 3},
    "inciweb": {"Disaster Response & Emergency": 10},
    "irs": {"Taxes & Revenue": 10},
    "nasa": {"Science & Space": 10},
    "ncbi": {"Public Health": 7, "Science & Space": 4},
    "noaa": {"Science & Space": 6, "Public Lands & Natural Resources": 4},
    "nps": {"Public Lands & Natural Resources": 10},
    "ntsb": {"Transportation & Infrastructure": 10},
    "nws": {"Disaster Response & Emergency": 10},
    "osha": {"Economy & Labor": 9},
    "sec": {"Financial Regulation": 10},
    "ssa": {"Social Security & Benefits": 10},
    "state": {"Foreign Affairs & Trade": 9},
    "texas-gov": {"Disaster Response & Emergency": 8,
                  "Elections & Government Operations": 3},
    "treasury": {"Financial Regulation": 6, "Taxes & Revenue": 4,
                 "Foreign Affairs & Trade": 2},
    "uscis": {"Immigration & Border": 10},
    "usda": {"Agriculture": 10},
    "usgs": {"Public Lands & Natural Resources": 6, "Science & Space": 5},
    "usps": {"Elections & Government Operations": 9},
    "va": {"Veterans Affairs": 10},
}


CATEGORY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "Immigration & Border": (
        "immigration", "immigrant", "border", "visa", "citizenship",
        "naturalization", "asylum", "refugee", "deportation", "removal",
        "migrant", "customs and border",
    ),
    "Public Health": (
        "public health", "outbreak", "disease", "infection", "vaccine",
        "vaccination", "epidemic", "pandemic", "health care", "healthcare",
        "medicare", "medicaid", "mental health", "clinical", "patient",
    ),
    "Food & Drug Safety": (
        "food safety", "drug safety", "recall", "fda approves", "approval of",
        "contamination", "salmonella", "listeria", "allergen", "medical device",
        "prescription drug", "clinical trial", "warning letter",
    ),
    "Defense & Military": (
        "military", "defense", "army", "navy", "air force", "marine corps",
        "missile", "airstrike", "troops", "pentagon", "combat", "weapon system",
    ),
    "Veterans Affairs": (
        "veteran", "veterans", "va health", "va benefits", "gi bill",
        "veterans affairs", "veteran homelessness",
    ),
    "Justice & Law Enforcement": (
        "indicted", "indictment", "charged", "arrested", "convicted", "pleads guilty",
        "guilty plea", "law enforcement", "criminal", "fraud", "seizure",
        "enforcement action", "investigation", "penalty", "violations",
    ),
    "Courts & Legal Rulings": (
        "court", "judge", "lawsuit", "sues", "complaint", "consent decree",
        "settlement", "sentenced", "judgment", "injunction", "ruling",
        "appeals", "supreme court", "litigation", "final order",
    ),
    "Economy & Labor": (
        "employment", "unemployment", "jobs", "labor", "workplace", "worker",
        "workers", "wages", "earnings", "inflation", "consumer prices", "osha",
        "occupational safety", "union", "strike", "economic growth",
    ),
    "Taxes & Revenue": (
        "tax", "taxes", "taxpayer", "taxpayers", "irs", "revenue", "filing season",
        "tax credit", "tax return", "withholding", "deduction",
    ),
    "Financial Regulation": (
        "securities", "commodity futures", "investment adviser", "broker",
        "financial institution", "banking", "market manipulation", "investor",
        "cryptocurrency", "digital asset", "cftc", "sec ", "fintech",
    ),
    "Energy & Environment": (
        "environment", "pollution", "cleanup", "superfund", "hazardous waste",
        "drinking water", "wastewater", "emissions", "clean air", "epa",
        "energy", "oil and gas", "coal", "climate", "pfas", "pesticide",
    ),
    "Transportation & Infrastructure": (
        "transportation", "infrastructure", "aviation", "aircraft", "airport",
        "highway", "railroad", "railway", "train", "bridge", "pipeline",
        "ship", "vessel", "collision", "crash", "derailment", "ntsb",
    ),
    "Education": (
        "education", "school", "schools", "student", "students", "university",
        "college", "teacher", "teachers", "campus", "student loan",
    ),
    "Housing & Urban Development": (
        "housing", "hud", "homeowner", "homeowners", "tenant", "tenants",
        "rent", "rental", "mortgage", "homelessness", "urban development",
        "fair housing",
    ),
    "Social Security & Benefits": (
        "social security", "benefits", "supplemental security income", "retirement",
        "disability benefits", "beneficiaries", "cost-of-living adjustment",
    ),
    "Science & Space": (
        "nasa", "space", "spacecraft", "satellite", "astronaut", "mission",
        "telescope", "planet", "moon", "mars", "research", "scientists",
        "scientific", "earthquake", "volcano", "geology",
    ),
    "Technology & Cybersecurity": (
        "cybersecurity", "cyber", "malware", "ransomware", "vulnerability",
        "cve-", "artificial intelligence", " ai ", "data breach", "software",
        "technology", "online platform", "privacy", "digital identity",
    ),
    "Elections & Government Operations": (
        "election", "voting", "ballot", "postal service", "post office",
        "government operations", "federal register", "inspector general",
        "appointment", "nominated", "sworn in", "public meeting",
    ),
    "Foreign Affairs & Trade": (
        "foreign", "diplomatic", "embassy", "ambassador", "secretary of state",
        "sanctions", "export controls", "tariff", "trade agreement", "treaty",
        "ceasefire", "ukraine", "russia", "china", "iran", "israel", "gaza",
        "nato", "united nations", "humanitarian assistance",
    ),
    "Disaster Response & Emergency": (
        "disaster", "emergency", "wildfire", "fire update", "hurricane", "tornado",
        "flood", "severe storm", "earthquake", "evacuation", "recovery center",
        "disaster recovery", "incident update", "containment", "fema assistance",
    ),
    "Agriculture": (
        "agriculture", "agricultural", "farm", "farmer", "farmers", "crop",
        "livestock", "rancher", "rural development", "usda", "conservation reserve",
    ),
    "Civil Rights & Liberties": (
        "civil rights", "discrimination", "hate crime", "voting rights",
        "religious freedom", "disability rights", "equal employment", "ada ",
        "first amendment", "human rights",
    ),
    "Public Lands & Natural Resources": (
        "national park", "national forest", "public lands", "wildlife", "habitat",
        "endangered species", "fisheries", "ocean", "river", "watershed",
        "conservation", "recreation area", "trail", "campground", "mineral resources",
    ),
}


TOKEN_RE = re.compile(r"[a-z][a-z0-9]+(?:[-'][a-z0-9]+)*")
STRONG_KEY_PATTERNS = (
    re.compile(r"\bCVE-\d{4}-\d{4,7}\b", re.I),
    re.compile(r"\b(?:DR|EM)-\d{4}-[A-Z]{2}\b", re.I),
    re.compile(r"\bFEMA-\d{4}-(?:DR|EM)\b", re.I),
    re.compile(r"\bLR-\d{4,6}\b", re.I),
    re.compile(r"\b(?:case|docket)\s+(?:no\.?|number|#)\s*[A-Z0-9][A-Z0-9:./-]{3,}\b", re.I),
    re.compile(r"\b[A-Z]{2,6}(?:-[A-Z]{1,6})*-\d{4}-\d{3,6}(?:-\d{1,6})?\b"),
    re.compile(r"\b[ZF]-\d{4}-\d{2,4}\b", re.I),
)

STOPWORDS = frozenset("""
a about above after again against all also am an and any are as at be because
been before being below between both but by can could did do does doing down
during each few for from further had has have having he her here hers herself
him himself his how i if in into is it its itself just me more most my myself
no nor not now of off on once only or other our ours ourselves out over own
same she should so some such than that the their theirs them themselves then
there these they this those through to too under until up very was we were what
when where which while who whom why will with would you your yours yourself
agency announces announced announcement department federal government national
news press release releases says said state states united update updates us usa
new final public official officials office service services today year years
million billion program programs funding action act administration
area closure closures county counties daily fire fires forest incident incidents
order orders park parks road roads trail trails weekly
""".split())

RECURRING_TEMPLATE = re.compile(
    r"\b(?:public schedule|jobs? of the week|weekly news quiz|daily schedule|"
    r"remarks to (?:the )?press|daily briefing|weekly digest|"
    r"events? (?:&|and) updates at|approves? .{0,40} support recovery)\b",
    re.I,
)

HIGH_TEMPLATE_PUBLISHERS = frozenset({"fema", "nps", "state", "va"})

STATE_NAMES = (
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
    "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
    "maine", "maryland", "massachusetts", "michigan", "minnesota",
    "mississippi", "missouri", "montana", "nebraska", "nevada",
    "new hampshire", "new jersey", "new mexico", "new york",
    "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
    "pennsylvania", "rhode island", "south carolina", "south dakota",
    "tennessee", "texas", "utah", "vermont", "virginia", "washington",
    "west virginia", "wisconsin", "wyoming", "puerto rico",
)

MONTH_NAMES = (
    "january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december",
)

HAZARD_NAMES = (
    "severe storms", "storm", "flooding", "flood", "wildfire", "hurricane",
    "tornado", "earthquake", "landslide", "mudslide", "winter storm",
)


@dataclass
class Entry:
    id: str
    publisher: str
    title: str
    summary: str
    body: str
    published_at: datetime
    url: str
    content_hash: str
    subtype: str = "unknown"
    category: str = ""
    category_confidence: str = ""
    title_norm: str = ""
    title_terms: Counter[str] = field(default_factory=Counter)
    content_terms: Counter[str] = field(default_factory=Counter)
    feature_vector: dict[str, float] = field(default_factory=dict)
    title_vector: dict[str, float] = field(default_factory=dict)
    entities: set[str] = field(default_factory=set)
    event_keys: set[str] = field(default_factory=set)
    selected_terms: set[str] = field(default_factory=set)


class UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, value: int) -> int:
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, left: int, right: int) -> bool:
        left, right = self.find(left), self.find(right)
        if left == right:
            return False
        if self.rank[left] < self.rank[right]:
            left, right = right, left
        self.parent[right] = left
        if self.rank[left] == self.rank[right]:
            self.rank[left] += 1
        return True


def parse_time(value: str | None) -> datetime:
    if not value:
        return datetime(1970, 1, 1, tzinfo=timezone.utc)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def tokens(text: str) -> list[str]:
    return [token for token in TOKEN_RE.findall(text.casefold())
            if len(token) >= 3 and token not in STOPWORDS]


def normalize_title(title: str) -> str:
    title = re.sub(r"\s*\|\s*(?:US )?[A-Z][A-Za-z .&-]+$", "", title)
    title = re.sub(r"\b(?:19|20)\d{2}\b", " ", title)
    title = re.sub(r"\$?[\d,.]+(?:\s*(?:million|billion))?", " ", title, flags=re.I)
    return " ".join(tokens(title))


def extract_strong_keys(text: str) -> set[str]:
    keys: set[str] = set()
    for pattern in STRONG_KEY_PATTERNS:
        for match in pattern.findall(text):
            keys.add(re.sub(r"\s+", " ", match).casefold())
    return keys


def source_event_keys(entry: Entry) -> set[str]:
    """High-precision publisher-specific identities available in raw text."""
    keys: set[str] = set()
    title = entry.title.casefold()
    if entry.publisher == "inciweb":
        clean = re.sub(r"\b\d{2}-\d{2}-\d{4}\b", " ", title)
        match = re.search(r"([a-z][a-z '&-]{1,60}\bfire)\b", clean)
        if match:
            words = [word for word in TOKEN_RE.findall(match.group(1))
                     if word not in {"news", "closures", "photographs", "maps",
                                     "temporary", "national", "forest", "blm",
                                     "update", "daily"}]
            if words and words[-1] == "fire":
                keys.add("incident:" + " ".join(words[-4:]))
    if entry.publisher == "fema":
        text = f" {entry.title} {entry.body[:1800]} ".casefold()
        state = next((name for name in STATE_NAMES if f" {name} " in text), None)
        month = next((name for name in MONTH_NAMES if f" {name} " in text), None)
        hazard = next((name for name in HAZARD_NAMES if f" {name} " in text), None)
        if state and month and hazard:
            keys.add(f"fema:{state}:{month}:{hazard}:{entry.published_at.year}")
    return keys


def sparse_cosine(left: dict[str, float], right: dict[str, float]) -> float:
    if not left or not right:
        return 0.0
    if len(left) > len(right):
        left, right = right, left
    return sum(value * right.get(term, 0.0) for term, value in left.items())


def normalize_vector(weights: dict[str, float]) -> dict[str, float]:
    norm = math.sqrt(sum(value * value for value in weights.values()))
    if norm == 0:
        return {}
    return {term: value / norm for term, value in weights.items()}


def classify_category(entry: Entry) -> tuple[str, str]:
    scores = Counter({name: 0.0 for name in SEEDED_CATEGORIES})
    for category, score in PUBLISHER_PRIORS.get(entry.publisher, {}).items():
        scores[category] += score
    title = f" {entry.title.casefold()} "
    content = f" {entry.title} {entry.summary} {entry.body[:3000]} ".casefold()
    for category, phrases in CATEGORY_KEYWORDS.items():
        for phrase in phrases:
            phrase = phrase.casefold()
            if phrase in title:
                scores[category] += 5.0 if " " in phrase else 3.5
            elif phrase in content:
                scores[category] += 1.4 if " " in phrase else 0.8

    # Categories without a dedicated publisher need decisive title evidence to
    # override the source prior. These are intentionally narrow phrases.
    title_overrides = {
        "Civil Rights & Liberties": (
            "civil rights", "voting rights", "religious discrimination",
            "racial discrimination", "disability rights", "equal employment"),
        "Courts & Legal Rulings": (
            "sentenced", "court orders", "court approves", "lawsuit",
            "consent decree", "final consent order", "judgment"),
        "Housing & Urban Development": (
            "fair housing", "mortgage", "tenant", "rental housing", "rent prices"),
        "Education": (
            "student loan", "students", "school district", "university", "college"),
        "Technology & Cybersecurity": (
            "cybersecurity", "ransomware", "malware", "data breach", "cve-"),
        "Defense & Military": (
            "military", "airstrike", "missile", "troops", "weapon system"),
    }
    for category, phrases in title_overrides.items():
        if any(phrase in title for phrase in phrases):
            scores[category] += 11

    ordered = scores.most_common(2)
    best, best_score = ordered[0]
    runner_up_score = ordered[1][1]
    margin = best_score - runner_up_score
    if best_score >= 9 and margin >= 4:
        confidence = "high"
    elif best_score >= 6 and margin >= 2:
        confidence = "medium"
    else:
        confidence = "low"
    return best, confidence


def get_all(http: httpx.Client, base: str, table: str, select: str,
            *, page_size: int = 1000) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        response = http.get(f"{base}/{table}", params={
            "select": select,
            "offset": offset,
            "limit": page_size,
        })
        response.raise_for_status()
        batch = response.json()
        rows.extend(batch)
        if len(batch) < page_size:
            return rows
        offset += page_size


def load_hosted() -> tuple[list[Entry], list[str], dict[str, str]]:
    load_dotenv()
    supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
    secret = os.environ["SUPABASE_SECRET_KEY"]
    base = f"{supabase_url}/rest/v1"
    headers = {"apikey": secret, "Authorization": f"Bearer {secret}"}
    with httpx.Client(headers=headers, timeout=90) as http:
        category_rows = get_all(
            http, base, "topic_categories", "id,display_name,origin")
        publisher_rows = get_all(
            http, base, "news_source_publishers", "news_source_id,publisher_key")
        origin_rows = get_all(
            http, base, "news_entry_origins", "news_entry_id,news_subtype")
        raw_entries = get_all(
            http, base, "news_entries",
            "id,news_source_id,url_canonical,title,summary,body_text,published_at,content_hash")

    hosted_seed = sorted(row["display_name"] for row in category_rows
                         if row["origin"] == "seed")
    category_ids = {row["display_name"]: row["id"] for row in category_rows
                    if row["origin"] == "seed"}
    if hosted_seed != sorted(SEEDED_CATEGORIES):
        raise RuntimeError("hosted seed taxonomy differs from the audited taxonomy")

    publishers = {row["news_source_id"]: row["publisher_key"]
                  for row in publisher_rows}
    subtype_votes: dict[str, Counter[str]] = defaultdict(Counter)
    for row in origin_rows:
        subtype_votes[row["news_entry_id"]][row["news_subtype"]] += 1

    missing_publishers: list[str] = []
    entries: list[Entry] = []
    for row in raw_entries:
        publisher = publishers.get(row["news_source_id"])
        if publisher is None:
            missing_publishers.append(row["id"])
            continue
        subtype = (subtype_votes[row["id"]].most_common(1)[0][0]
                   if subtype_votes[row["id"]] else "unknown")
        entries.append(Entry(
            id=row["id"], publisher=publisher,
            title=(row["title"] or "").strip(),
            summary=(row["summary"] or "").strip(),
            body=(row["body_text"] or "").strip(),
            published_at=parse_time(row["published_at"]),
            url=row["url_canonical"], content_hash=row["content_hash"],
            subtype=subtype,
        ))
    if missing_publishers:
        raise RuntimeError(f"{len(missing_publishers)} entries lack publisher attribution")
    entries.sort(key=lambda item: (item.published_at, item.id))
    return entries, hosted_seed, category_ids


def prepare_features(entries: list[Entry]) -> dict[str, Counter[str]]:
    document_frequency: Counter[str] = Counter()
    title_frequency: Counter[str] = Counter()
    entity_frequency: Counter[str] = Counter()
    key_frequency: Counter[str] = Counter()

    for entry in entries:
        entry.category, entry.category_confidence = classify_category(entry)
        entry.title_norm = normalize_title(entry.title)
        entry.title_terms = Counter(tokens(entry.title))
        entry.content_terms = Counter(tokens(
            f"{entry.title} {entry.summary[:800]} {entry.body[:1200]}"))
        summary_for_anchors = entry.body or entry.summary
        entities, extracted_keys = extract_anchors(entry.title, summary_for_anchors)
        entry.entities = set(entities)
        entry.event_keys = set(extracted_keys) | extract_strong_keys(
            f"{entry.title}\n{entry.summary}\n{entry.body}")
        entry.event_keys |= source_event_keys(entry)
        document_frequency.update(entry.content_terms)
        title_frequency.update(entry.title_terms)
        entity_frequency.update(entry.entities)
        key_frequency.update(entry.event_keys)

    size = len(entries)
    idf = {term: math.log((size + 1) / (frequency + 1)) + 1
           for term, frequency in document_frequency.items()}
    title_idf = {term: math.log((size + 1) / (frequency + 1)) + 1
                 for term, frequency in title_frequency.items()}

    for entry in entries:
        content_weights = {
            term: idf[term] * (1.0 + math.log(min(count, 4)))
            for term, count in entry.content_terms.items()
        }
        title_weights = {
            term: title_idf[term] * (1.0 + math.log(min(count, 3)))
            for term, count in entry.title_terms.items()
        }
        entry.feature_vector = normalize_vector(content_weights)
        entry.title_vector = normalize_vector(title_weights)
        candidates = [term for term in entry.content_terms
                      if 2 <= document_frequency[term] <= 70]
        entry.selected_terms = set(sorted(
            candidates, key=lambda term: (document_frequency[term], term))[:12])

    return {
        "document": document_frequency,
        "title": title_frequency,
        "entity": entity_frequency,
        "key": key_frequency,
    }


def add_pairs(index: dict[str, list[int]], pairs: dict[tuple[int, int], Counter[str]],
              kind: str, *, maximum_group: int) -> None:
    for members in index.values():
        unique = sorted(set(members))
        if len(unique) < 2 or len(unique) > maximum_group:
            continue
        for left, right in itertools.combinations(unique, 2):
            pairs[(left, right)][kind] += 1


def candidate_pairs(entries: list[Entry], frequencies: dict[str, Counter[str]]) \
        -> dict[tuple[int, int], Counter[str]]:
    pairs: dict[tuple[int, int], Counter[str]] = defaultdict(Counter)
    exact_titles: dict[str, list[int]] = defaultdict(list)
    selected_terms: dict[str, list[int]] = defaultdict(list)
    rare_title_terms: dict[str, list[int]] = defaultdict(list)
    rare_entities: dict[str, list[int]] = defaultdict(list)
    event_keys: dict[str, list[int]] = defaultdict(list)

    for index, entry in enumerate(entries):
        if entry.title_norm:
            exact_titles[entry.title_norm].append(index)
        for term in entry.selected_terms:
            selected_terms[term].append(index)
        for term in entry.title_terms:
            if 2 <= frequencies["title"][term] <= 80:
                rare_title_terms[term].append(index)
        for entity in entry.entities:
            if 2 <= frequencies["entity"][entity] <= 80:
                rare_entities[entity].append(index)
        for key in entry.event_keys:
            if frequencies["key"][key] <= 100:
                event_keys[key].append(index)

    add_pairs(exact_titles, pairs, "exact_title", maximum_group=80)
    add_pairs(selected_terms, pairs, "selected_term", maximum_group=70)
    add_pairs(rare_title_terms, pairs, "rare_title", maximum_group=80)
    add_pairs(rare_entities, pairs, "rare_entity", maximum_group=80)
    add_pairs(event_keys, pairs, "event_key", maximum_group=100)
    return pairs


def estimate_topology(entries: list[Entry], pairs: dict[tuple[int, int], Counter[str]],
                      *, mode: str) \
        -> tuple[list[list[int]], list[list[list[int]]], dict[str, int]]:
    story_uf = UnionFind(len(entries))
    episode_edges: list[tuple[int, int]] = []
    evidence = Counter()

    for (left_index, right_index), overlap in pairs.items():
        left, right = entries[left_index], entries[right_index]
        same_category = left.category == right.category
        feature_similarity = sparse_cosine(left.feature_vector, right.feature_vector)
        title_similarity = sparse_cosine(left.title_vector, right.title_vector)
        shared_key = overlap["event_key"] > 0
        exact_title = overlap["exact_title"] > 0
        shared_rare = overlap["rare_title"] + overlap["rare_entity"]
        shared_terms = overlap["selected_term"]

        recurring_template = bool(RECURRING_TEMPLATE.search(left.title)) \
            or bool(RECURRING_TEMPLATE.search(right.title))
        high_template = (left.publisher in HIGH_TEMPLATE_PUBLISHERS
                         or right.publisher in HIGH_TEMPLATE_PUBLISHERS)
        if mode == "strict":
            similarity_join = (
                not recurring_template and title_similarity >= 0.84
                and overlap["rare_title"] >= 3)
        elif high_template:
            similarity_join = (
                not recurring_template and title_similarity >= 0.84
                and overlap["rare_title"] >= 3)
        else:
            similarity_join = (
                (not recurring_template and title_similarity >= 0.77
                 and overlap["rare_title"] >= 2)
                or (not recurring_template and feature_similarity >= 0.82
                    and overlap["rare_title"] >= 2
                    and overlap["rare_entity"] >= 1)
            )
        join_story = (shared_key or (same_category and exact_title
                                     and not recurring_template)
                      or (same_category and similarity_join))
        if not join_story:
            continue
        story_uf.union(left_index, right_index)
        if shared_key:
            evidence["event_key_story_edges"] += 1
        elif exact_title:
            evidence["exact_title_story_edges"] += 1
        else:
            evidence["similarity_story_edges"] += 1

        gap_hours = abs((right.published_at - left.published_at).total_seconds()) / 3600
        exact_content = left.content_hash == right.content_hash
        join_episode = (
            (exact_content and gap_hours <= 72)
            or (gap_hours <= 4 and shared_key)
            or (gap_hours <= 4 and exact_title)
            or (gap_hours <= 4 and feature_similarity >= 0.72
                and (shared_rare >= 1 or shared_terms >= 2))
        )
        if join_episode:
            episode_edges.append((left_index, right_index))
            evidence["episode_edges"] += 1

    story_members: dict[int, list[int]] = defaultdict(list)
    for index in range(len(entries)):
        story_members[story_uf.find(index)].append(index)
    storylines = sorted(story_members.values(),
                        key=lambda members: (entries[members[0]].published_at, members[0]))

    storyline_episodes: list[list[list[int]]] = []
    for members in storylines:
        membership = set(members)
        episode_uf = UnionFind(len(entries))
        for left, right in episode_edges:
            if left in membership and right in membership:
                episode_uf.union(left, right)
        episode_members: dict[int, list[int]] = defaultdict(list)
        for member in members:
            episode_members[episode_uf.find(member)].append(member)
        episodes = sorted(episode_members.values(),
                          key=lambda episode: entries[episode[0]].published_at)
        storyline_episodes.append(episodes)
    return storylines, storyline_episodes, dict(evidence)


def bucket(value: int, boundaries: tuple[int, ...]) -> str:
    for boundary in boundaries:
        if value <= boundary:
            return str(boundary) if boundary == 1 else f"2-{boundary}"
    return f">{boundaries[-1]}"


def example(entries: list[Entry], members: list[int], episodes: list[list[int]]) -> dict:
    ordered = sorted((entries[index] for index in members), key=lambda item: item.published_at)
    categories = Counter(item.category for item in ordered)
    return {
        "category": categories.most_common(1)[0][0],
        "entries": len(ordered),
        "episodes": len(episodes),
        "publishers": sorted({item.publisher for item in ordered}),
        "first_published": ordered[0].published_at.isoformat(),
        "last_published": ordered[-1].published_at.isoformat(),
        "sample_titles": [item.title for item in ordered[:6]],
        "sample_urls": [item.url for item in ordered[:3]],
    }


def summarize(entries: list[Entry], storylines: list[list[int]],
              storyline_episodes: list[list[list[int]]], evidence: dict[str, int],
              hosted_seed: list[str]) -> dict:
    topology = Counter()
    topology_entries = Counter()
    episode_sizes = Counter()
    storyline_sizes = Counter()
    category_rows: dict[str, Counter[str]] = {
        category: Counter() for category in hosted_seed}
    subtype_rows: dict[str, Counter[str]] = defaultdict(Counter)

    multi_episode_examples: list[dict] = []
    multi_entry_examples: list[dict] = []
    singleton_examples: list[dict] = []

    for members, episodes in zip(storylines, storyline_episodes, strict=True):
        if len(episodes) >= 2:
            topology_name = "multi_episode_storyline"
        elif len(members) >= 2:
            topology_name = "multi_entry_single_episode"
        else:
            topology_name = "singleton_episode_storyline"
        topology[topology_name] += 1
        topology_entries[topology_name] += len(members)
        storyline_sizes[bucket(len(members), (1, 2, 5, 10, 25))] += 1
        for episode in episodes:
            episode_sizes[bucket(len(episode), (1, 2, 5, 10))] += 1

        categories = Counter(entries[index].category for index in members)
        category = categories.most_common(1)[0][0]
        category_rows[category]["storylines"] += 1
        category_rows[category][topology_name] += 1
        category_rows[category]["episodes"] += len(episodes)
        category_rows[category]["entries_in_storylines"] += len(members)

        subtypes = Counter(entries[index].subtype for index in members)
        subtype = subtypes.most_common(1)[0][0]
        subtype_rows[subtype]["storylines"] += 1
        subtype_rows[subtype][topology_name] += 1
        subtype_rows[subtype]["episodes"] += len(episodes)
        subtype_rows[subtype]["entries_in_storylines"] += len(members)

        shaped = example(entries, members, episodes)
        if topology_name == "multi_episode_storyline":
            multi_episode_examples.append(shaped)
        elif topology_name == "multi_entry_single_episode":
            multi_entry_examples.append(shaped)
        elif len(singleton_examples) < 30:
            singleton_examples.append(shaped)

    entry_categories = Counter(entry.category for entry in entries)
    entry_subtypes = Counter(entry.subtype for entry in entries)
    confidence = Counter(entry.category_confidence for entry in entries)
    for category, count in entry_categories.items():
        category_rows[category]["entries"] = count
    for subtype, count in entry_subtypes.items():
        subtype_rows[subtype]["entries"] = count

    for values in (multi_episode_examples, multi_entry_examples):
        values.sort(key=lambda item: (
            -item["episodes"], -item["entries"], item["first_published"]))

    total_storylines = len(storylines)
    total_entries = len(entries)
    total_episodes = sum(len(episodes) for episodes in storyline_episodes)
    episode_member_lists = [episode for episodes in storyline_episodes
                            for episode in episodes]
    multi_entry_episodes = [episode for episode in episode_member_lists
                            if len(episode) >= 2]

    def shaped_distribution(rows: Counter, denominator: int) -> list[dict]:
        order = ("multi_episode_storyline", "multi_entry_single_episode",
                 "singleton_episode_storyline")
        return [{
            "type": name,
            "count": rows[name],
            "share_percent": round(100 * rows[name] / denominator, 2),
        } for name in order]

    categories = []
    for category in hosted_seed:
        row = category_rows[category]
        story_count = row["storylines"]
        entry_count = row["entries"]
        chain_storylines = (row["multi_episode_storyline"]
                            + row["multi_entry_single_episode"])
        categories.append({
            "category": category,
            "entries": entry_count,
            "entry_share_percent": round(100 * entry_count / total_entries, 2),
            "storylines": story_count,
            "episodes": row["episodes"],
            "singleton_storylines": row["singleton_episode_storyline"],
            "multi_entry_single_episode": row["multi_entry_single_episode"],
            "multi_episode_storylines": row["multi_episode_storyline"],
            "chain_storyline_rate_percent": (
                round(100 * chain_storylines / story_count, 2) if story_count else 0.0),
        })
    categories.sort(key=lambda row: (-row["entries"], row["category"]))

    subtypes = []
    for subtype, row in subtype_rows.items():
        story_count = row["storylines"]
        chain_storylines = (row["multi_episode_storyline"]
                            + row["multi_entry_single_episode"])
        subtypes.append({
            "subtype": subtype,
            "entries": row["entries"],
            "entry_share_percent": round(100 * row["entries"] / total_entries, 2),
            "storylines": story_count,
            "singleton_storylines": row["singleton_episode_storyline"],
            "multi_entry_single_episode": row["multi_entry_single_episode"],
            "multi_episode_storylines": row["multi_episode_storyline"],
            "chain_storyline_rate_percent": (
                round(100 * chain_storylines / story_count, 2) if story_count else 0.0),
        })
    subtypes.sort(key=lambda row: (-row["entries"], row["subtype"]))

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "method": {
            "episode_dormancy_hours": 4,
            "duplicate_window_hours": 72,
            "storyline_bias": "split-biased deterministic estimate",
            "writes_performed": 0,
            "evidence_edges": evidence,
        },
        "coverage": {
            "entries": total_entries,
            "entries_with_body": sum(bool(entry.body) for entry in entries),
            "publishers": len({entry.publisher for entry in entries}),
            "seeded_categories": len(hosted_seed),
            "category_confidence": dict(confidence),
        },
        "totals": {
            "estimated_storylines": total_storylines,
            "estimated_episodes": total_episodes,
            "multi_entry_episodes": len(multi_entry_episodes),
            "multi_entry_episode_rate_percent": round(
                100 * len(multi_entry_episodes) / total_episodes, 2),
            "entries_in_multi_entry_episodes": sum(
                len(episode) for episode in multi_entry_episodes),
        },
        "storyline_distribution": shaped_distribution(topology, total_storylines),
        "entry_distribution": shaped_distribution(topology_entries, total_entries),
        "episode_size_distribution": dict(episode_sizes),
        "storyline_size_distribution": dict(storyline_sizes),
        "categories": categories,
        "news_subtypes": subtypes,
        "examples": {
            "multi_episode_storylines": multi_episode_examples[:20],
            "multi_entry_single_episode": multi_entry_examples[:15],
            "singleton_episode_storylines": singleton_examples[:10],
        },
    }


def _stable_group_key(kind: str, mode: str, entries: list[Entry],
                      members: list[int]) -> str:
    member_ids = "\n".join(sorted(entries[index].id for index in members))
    digest = hashlib.sha256(member_ids.encode("utf-8")).hexdigest()
    return f"{kind}:{mode}:v1:{digest}"


def build_label_rows(entries: list[Entry], storylines: list[list[int]],
                     storyline_episodes: list[list[list[int]]], *, mode: str,
                     category_ids: dict[str, str]) -> list[dict]:
    labels: list[dict] = []
    for members, episodes in zip(storylines, storyline_episodes, strict=True):
        storyline_key = _stable_group_key("storyline", mode, entries, members)
        episode_by_member: dict[int, tuple[str, int]] = {}
        for episode in episodes:
            episode_key = _stable_group_key("episode", mode, entries, episode)
            for member in episode:
                episode_by_member[member] = (episode_key, len(episode))

        for member in members:
            entry = entries[member]
            episode_key, episode_entry_count = episode_by_member[member]
            labels.append({
                "news_entry_id": entry.id,
                "content_hash_at_labeling": entry.content_hash,
                "proposed_storyline_key": storyline_key,
                "proposed_episode_key": episode_key,
                "storyline_entry_count": len(members),
                "storyline_episode_count": len(episodes),
                "episode_entry_count": episode_entry_count,
                "topic_category_id": category_ids[entry.category],
                "category_confidence": entry.category_confidence,
                "evidence": {
                    "audit_mode": mode,
                    "publisher": entry.publisher,
                    "seeded_category": entry.category,
                },
            })
    labels.sort(key=lambda row: row["news_entry_id"])
    if len(labels) != len(entries):
        raise RuntimeError("topology labels do not reconcile to corpus")
    return labels


def publish_label_rows_to_database(labels: list[dict], *, name: str,
                                   labeling_version: int, batch_size: int,
                                   parameters: dict) -> str:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb

    database_url = os.environ.get(
        "DATABASE_URL",
        "postgresql://postgres:postgres@127.0.0.1:57422/postgres",
    )
    with psycopg.connect(database_url, row_factory=dict_row, autocommit=True) as conn:
        category_rows = conn.execute(
            "select id, display_name from public.topic_categories "
            "where origin = 'seed'").fetchall()
        category_ids = {row["display_name"]: str(row["id"])
                        for row in category_rows}
        local_labels = [
            {
                **label,
                "topic_category_id": category_ids[
                    label["evidence"]["seeded_category"]],
            }
            for label in labels
        ]
        label_set_id = conn.execute(
            "select public.begin_topology_label_set(%s, %s, %s, %s) as id",
            (name, "deterministic-corpus-topology-audit", labeling_version,
             Jsonb(parameters)),
        ).fetchone()["id"]
        written = 0
        for start in range(0, len(local_labels), batch_size):
            batch = local_labels[start:start + batch_size]
            written += int(conn.execute(
                "select public.upsert_news_entry_topology_labels(%s, %s) as count",
                (label_set_id, Jsonb(batch)),
            ).fetchone()["count"])
        completed = int(conn.execute(
            "select public.complete_topology_label_set(%s, %s) as count",
            (label_set_id, len(local_labels)),
        ).fetchone()["count"])
    if written != len(labels) or completed != len(labels):
        raise RuntimeError(
            f"published label counts do not reconcile: wrote={written}, completed={completed}")
    return str(label_set_id)


def publish_label_rows(labels: list[dict], *, mode: str, name: str,
                       labeling_version: int, batch_size: int,
                       report: dict, target: str) -> str:
    if labeling_version < 1:
        raise ValueError("labeling_version must be positive")
    if batch_size < 1 or batch_size > 1000:
        raise ValueError("batch_size must be between 1 and 1000")

    parameters = {
        "mode": mode,
        "episode_dormancy_hours": report["method"]["episode_dormancy_hours"],
        "duplicate_window_hours": report["method"]["duplicate_window_hours"],
        "corpus_entry_count": len(labels),
        "estimated_storylines": report["totals"]["estimated_storylines"],
        "estimated_episodes": report["totals"]["estimated_episodes"],
    }
    if target == "local":
        return publish_label_rows_to_database(
            labels,
            name=name,
            labeling_version=labeling_version,
            batch_size=batch_size,
            parameters=parameters,
        )

    load_dotenv()
    supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
    secret = os.environ["SUPABASE_SECRET_KEY"]
    base = f"{supabase_url}/rest/v1/rpc"
    headers = {"apikey": secret, "Authorization": f"Bearer {secret}"}

    def call(http: httpx.Client, function: str, payload: dict):
        response = http.post(f"{base}/{function}", json=payload)
        response.raise_for_status()
        return response.json()

    with httpx.Client(headers=headers, timeout=90) as http:
        label_set_id = call(http, "begin_topology_label_set", {
            "p_name": name,
            "p_labeling_method": "deterministic-corpus-topology-audit",
            "p_labeling_version": labeling_version,
            "p_parameters": parameters,
        })
        written = 0
        for start in range(0, len(labels), batch_size):
            batch = labels[start:start + batch_size]
            written += int(call(http, "upsert_news_entry_topology_labels", {
                "p_label_set_id": label_set_id,
                "p_labels": batch,
            }))
        completed = int(call(http, "complete_topology_label_set", {
            "p_label_set_id": label_set_id,
            "p_expected_entry_count": len(labels),
        }))
    if written != len(labels) or completed != len(labels):
        raise RuntimeError(
            f"published label counts do not reconcile: wrote={written}, completed={completed}")
    return str(label_set_id)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--mode", choices=("strict", "balanced"),
                        default="balanced")
    parser.add_argument(
        "--publish", action="store_true",
        help="write only the derived labels to the versioned sidecar tables")
    parser.add_argument(
        "--publish-target", choices=("local", "hosted"), default="local",
        help="local DATABASE_URL (default) or hosted Supabase REST")
    parser.add_argument("--label-set-name")
    parser.add_argument("--labeling-version", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args()
    entries, hosted_seed, category_ids = load_hosted()
    frequencies = prepare_features(entries)
    pairs = candidate_pairs(entries, frequencies)
    storylines, episodes, evidence = estimate_topology(entries, pairs, mode=args.mode)
    report = summarize(entries, storylines, episodes, evidence, hosted_seed)
    report["method"]["mode"] = args.mode
    if sum(row["entries"] for row in report["categories"]) != len(entries):
        raise RuntimeError("category distribution does not reconcile to corpus")
    if sum(row["entries"] for row in report["news_subtypes"]) != len(entries):
        raise RuntimeError("news subtype distribution does not reconcile to corpus")
    if sum(row["count"] for row in report["storyline_distribution"]) \
            != report["totals"]["estimated_storylines"]:
        raise RuntimeError("storyline topology does not reconcile")
    if sum(row["count"] for row in report["entry_distribution"]) != len(entries):
        raise RuntimeError("entry topology does not reconcile")
    if args.publish:
        labels = build_label_rows(
            entries, storylines, episodes, mode=args.mode,
            category_ids=category_ids)
        label_set_id = publish_label_rows(
            labels,
            mode=args.mode,
            name=args.label_set_name or f"corpus-topology-{args.mode}",
            labeling_version=args.labeling_version,
            batch_size=args.batch_size,
            report=report,
            target=args.publish_target,
        )
        report["method"]["writes_performed"] = len(labels)
        report["published_label_set"] = {
            "id": label_set_id,
            "name": args.label_set_name or f"corpus-topology-{args.mode}",
            "labeling_version": args.labeling_version,
            "entries": len(labels),
            "target": args.publish_target,
        }
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=False))


if __name__ == "__main__":
    main()
