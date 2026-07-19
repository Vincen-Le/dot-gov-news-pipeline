from __future__ import annotations

import json
import re
from collections import Counter

import httpx
import numpy as np

from pipeline.config import Config
from pipeline.prompts import (
    RUBRIC_CRITERIA,
    build_adjudicator_prompt,
    build_category_prompt,
    build_compressor_prompt,
    build_enricher_prompt,
    build_rank_audit_prompt,
    build_theme_adjudicator_prompt,
    build_theme_namer_prompt,
)


def _extract_json(text: str | dict) -> dict:
    if isinstance(text, dict):  # workers ai may return pre-parsed json
        return text
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"no json object in model output: {text[:200]}")
    return json.loads(match.group(0))


class WorkersAI:
    def __init__(self, cfg: Config, transport: httpx.BaseTransport | None = None) -> None:
        self.cfg = cfg
        self.embedding_tag = cfg.embedding_model
        self.errors: Counter = Counter()  # swallowed-failure tallies for report health
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{cfg.cf_account_id}/ai/run/"
        self.http = httpx.Client(
            headers={"Authorization": f"Bearer {cfg.cf_api_token}"},
            timeout=120.0,
            transport=transport,
        )

    def _run(self, model: str, payload: dict) -> dict:
        response = self.http.post(self.base + model, json=payload)
        response.raise_for_status()
        body = response.json()
        if not body.get("success", False):
            raise RuntimeError(f"workers ai error: {body.get('errors')}")
        return body["result"]

    def _chat(self, model: str, system: str, user: str) -> str:
        result = self._run(model, {
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
        })
        return result["response"]

    def embed(self, texts: list[str]) -> list[np.ndarray]:
        result = self._run(self.cfg.embedding_model, {"text": texts})
        return [np.asarray(v, dtype=np.float32) for v in result["data"]]

    def enrich(self, title: str, summary: str | None) -> str:
        system, user = build_enricher_prompt(title, summary)
        return self._chat(self.cfg.enricher_model, system, user).strip()

    def adjudicate_same_event(self, a: dict, b: dict, context: str) -> tuple[bool, str]:
        system, user = build_adjudicator_prompt(a, b, context)
        try:
            parsed = _extract_json(self._chat(self.cfg.adjudicator_model, system, user))
            return bool(parsed.get("same_event", False)), str(parsed.get("reason", ""))
        except Exception as exc:  # split-biased: any failure means "not the same event"
            self.errors["adjudicator"] += 1
            return False, f"adjudicator_error: {exc}"

    def compress_overview(self, storyline_summary: dict, episode_cards: list[dict]) -> dict:
        system, user = build_compressor_prompt(storyline_summary, episode_cards)
        parsed = _extract_json(self._chat(self.cfg.judge_model, system, user))
        parsed.setdefault("rubric", {})
        for criterion in RUBRIC_CRITERIA:
            parsed["rubric"].setdefault(criterion, 0)
        return parsed

    def compare_rank(self, a: dict, b: dict) -> dict:
        system, user = build_rank_audit_prompt(a, b)
        try:
            parsed = _extract_json(self._chat(self.cfg.audit_model, system, user))
            prefers = str(parsed.get("prefers", "")).strip().lower()
            if prefers not in ("a", "b"):
                return {"prefers": "invalid",
                        "reason": f"rank_audit_error: unparseable verdict {parsed!r}"}
            return {"prefers": prefers, "reason": str(parsed.get("reason", ""))[:2048]}
        except Exception as exc:  # audit failure is recorded, never raised
            self.errors["rank_audit"] += 1
            return {"prefers": "invalid", "reason": f"rank_audit_error: {exc}"}

    def name_theme(self, storyline: dict) -> str:
        # judge model on purpose: naming is high-volume (every spawn) and
        # tolerance for a mediocre label is high; the engine falls back to
        # the headline if this raises
        system, user = build_theme_namer_prompt(storyline)
        return self._chat(self.cfg.judge_model, system, user).strip().strip('"')

    def classify_category(self, theme_name: str, storyline: dict,
                          categories: list[dict]) -> dict:
        system, user = build_category_prompt(theme_name, storyline, categories)
        try:
            parsed = _extract_json(self._chat(self.cfg.judge_model, system, user))
            category_id = parsed.get("category_id")
            proposed = parsed.get("new_category_name")
            return {
                "category_id": str(category_id) if category_id else None,
                "new_category_name": str(proposed) if proposed else None,
                "reason": str(parsed.get("reason", "")),
            }
        except Exception as exc:  # engine leaves category null on failure
            self.errors["classifier"] += 1
            return {"category_id": None, "new_category_name": None,
                    "reason": f"classifier_error: {exc}"}

    def adjudicate_theme(self, storyline: dict, candidates: list[dict]) -> dict:
        # raises on failure by design: ThemeEngine falls back to knn majority
        system, user = build_theme_adjudicator_prompt(storyline, candidates)
        parsed = _extract_json(self._chat(self.cfg.judge_model, system, user))
        return {
            "decision": str(parsed.get("decision") or ""),
            "theme_id": str(parsed["theme_id"]) if parsed.get("theme_id") else None,
            "new_theme_name": (str(parsed["new_theme_name"])
                               if parsed.get("new_theme_name") else None),
            "merge_theme_ids": [str(i) for i in parsed.get("merge_theme_ids") or []
                                if i],
            "reason": str(parsed.get("reason", "")),
        }
