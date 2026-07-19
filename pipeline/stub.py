"""Deterministic LLM-free ModelClient for tests, dry runs, and CI.

Embedder: hashed bag-of-words (similar texts share tokens -> high cosine).
Adjudicator: same_event iff entity sets overlap. Compressor: template with
verbatim episode citations. No randomness, no network, no clock.
"""

from __future__ import annotations

import hashlib
from collections import Counter

import numpy as np

from pipeline.prompts import RUBRIC_CRITERIA

_DIM = 256


def _tokens(text: str) -> set[str]:
    return {t.strip(".,;:!?()'\"").casefold()
            for t in text.split() if len(t.strip(".,;:!?()'\"")) >= 4}


class StubModels:
    # recorded as news_entries.embedding_model so stub vectors are never
    # mistaken for real ones (they are 256-dim; bge-m3 is 1024-dim)
    embedding_tag = "stub-bow-256"

    def embed(self, texts: list[str]) -> list[np.ndarray]:
        out: list[np.ndarray] = []
        for text in texts:
            vec = np.zeros(_DIM, dtype=np.float32)
            for token in text.casefold().split():
                token = token.strip(".,;:!?()'\"")
                if len(token) < 3:
                    continue
                digest = hashlib.sha256(token.encode()).digest()
                vec[digest[0] % _DIM] += 1.0
                vec[digest[1] % _DIM] += 1.0
            norm = np.linalg.norm(vec)
            out.append(vec / norm if norm > 0 else vec)
        return out

    def enrich(self, title: str, summary: str | None) -> str:
        return f"{title}. {summary or ''}".strip()

    def adjudicate_same_event(self, a: dict, b: dict, context: str) -> tuple[bool, str]:
        overlap = set(a.get("entities", [])) & set(b.get("entities", []))
        if overlap:
            return True, f"stub: shared entities {sorted(overlap)}"
        return False, "stub: disjoint entities"

    def compress_overview(self, storyline_summary: dict, episode_cards: list[dict]) -> dict:
        latest = episode_cards[-1]
        return {
            "headline": latest["headline"],
            "summary": " / ".join(c["headline"] for c in episode_cards),
            "timeline": [
                {"episode_id": str(c["episode_id"]), "date": c["date"], "text": c["headline"]}
                for c in episode_cards
            ],
            "rubric": {c: 0 for c in RUBRIC_CRITERIA},
            "reason": "stub rubric",
        }

    def compare_rank(self, a: dict, b: dict) -> dict:
        # swap-consistent by construction: verdict derives from content only
        def score(item):
            return (item["agencies"], item["feeds"], item["entries"])
        if score(a) != score(b):
            winner = "a" if score(a) > score(b) else "b"
            return {"prefers": winner, "reason": "stub: corroboration order"}
        first = min(a["headline"], b["headline"])
        return {"prefers": "a" if a["headline"] == first else "b",
                "reason": "stub: tie broken by headline"}

    def classify_category(self, storyline: dict,
                          categories: list[dict]) -> dict:
        mine = _tokens(storyline["headline"] + " " +
                       (storyline.get("summary") or ""))
        for category in categories:
            if mine & _tokens(category["display_name"]):
                return {"category_id": category["id"],
                        "reason": "stub: token overlap with category name"}
        if categories:
            return {"category_id": categories[0]["id"],
                    "reason": "stub: first seeded category fallback"}
        return {"category_id": None, "reason": "stub: no categories"}

    def adjudicate_membership(self, storyline: dict,
                              candidates: list[dict]) -> dict:
        mine = _tokens(storyline["headline"] + " " +
                       (storyline.get("summary") or ""))
        for candidate in candidates:
            theirs = _tokens(candidate["name"] + " " +
                             (candidate.get("inclusion_criterion") or ""))
            if mine & theirs:
                return {"theme_id": candidate["theme_id"],
                        "reason": "stub: token overlap with criterion"}
        return {"theme_id": None, "reason": "stub: no criterion satisfied"}

    def judge_promotion(self, dossier: dict) -> dict:
        first = dossier["members"][0]["headline"]
        mine = _tokens(first)
        for theme in dossier.get("existing_themes") or []:
            if mine & _tokens(theme["name"]):
                return {"verdict": "attach_existing", "theme_name": None,
                        "inclusion_criterion": None,
                        "theme_id": theme["theme_id"],
                        "reason": "stub: existing theme name overlap"}
        name = " ".join(first.split()[:4])
        return {"verdict": "promote", "theme_name": name,
                "inclusion_criterion": f"stub: storylines about {name}",
                "theme_id": None, "reason": "stub: promote cluster"}

    def review_theme(self, dossier: dict) -> dict:
        if dossier["cohesion"] < 0.2:
            return {"verdict": "demote", "reason": "stub: cohesion collapsed"}
        return {"verdict": "keep", "reason": "stub: cohesion acceptable"}

    def link_storyline(self, entry: dict, candidates: list[dict]) -> dict:
        entry_tokens = _tokens(entry["title"])
        for i, c in enumerate(candidates):
            if len(entry_tokens & _tokens(c["headline"])) >= 3:
                return {"match": i, "same_development": True,
                        "reason": "stub token overlap"}
        return {"match": None, "same_development": False, "reason": "stub no overlap"}

    def induce_theme(self, members: list[dict]) -> dict:
        counts = Counter(t for m in members for t in _tokens(m["headline"]))
        top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:2]
        return {"theme": True, "name": " ".join(w for w, _ in top).title(),
                "reason": "stub theme"}
