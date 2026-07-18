"""Deterministic LLM-free ModelClient for tests, dry runs, and CI.

Embedder: hashed bag-of-words (similar texts share tokens -> high cosine).
Adjudicator: same_event iff entity sets overlap. Compressor: template with
verbatim episode citations. No randomness, no network, no clock.
"""

from __future__ import annotations

import hashlib

import numpy as np

from pipeline.prompts import RUBRIC_CRITERIA

_DIM = 256


class StubModels:
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
