from __future__ import annotations

import json
import re

import httpx
import numpy as np

from pipeline.config import Config
from pipeline.prompts import (
    RUBRIC_CRITERIA,
    build_adjudicator_prompt,
    build_category_prompt,
    build_compressor_prompt,
    build_enricher_prompt,
    build_theme_adjudicator_prompt,
)


def _extract_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"no json object in model output: {text[:200]}")
    return json.loads(match.group(0))


class WorkersAI:
    def __init__(self, cfg: Config, transport: httpx.BaseTransport | None = None) -> None:
        self.cfg = cfg
        self.embedding_tag = cfg.embedding_model
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
            return False, f"adjudicator_error: {exc}"

    def compress_overview(self, storyline_summary: dict, episode_cards: list[dict]) -> dict:
        system, user = build_compressor_prompt(storyline_summary, episode_cards)
        parsed = _extract_json(self._chat(self.cfg.judge_model, system, user))
        parsed.setdefault("rubric", {})
        for criterion in RUBRIC_CRITERIA:
            parsed["rubric"].setdefault(criterion, 0)
        return parsed

    def adjudicate_theme(self, storyline: dict, candidates: list[dict]) -> dict:
        system, user = build_theme_adjudicator_prompt(storyline, candidates)
        try:
            parsed = _extract_json(self._chat(self.cfg.adjudicator_model, system, user))
            theme_id = parsed.get("theme_id")
            updated = parsed.get("updated_name")
            return {
                "theme_id": str(theme_id) if theme_id else None,
                "updated_name": str(updated) if updated else None,
                "reason": str(parsed.get("reason", "")),
            }
        except Exception as exc:  # engine spawns a new theme on failure
            return {"theme_id": None, "updated_name": None,
                    "reason": f"adjudicator_error: {exc}"}

    def classify_category(self, theme_name: str, storyline: dict,
                          categories: list[dict]) -> dict:
        system, user = build_category_prompt(theme_name, storyline, categories)
        try:
            parsed = _extract_json(self._chat(self.cfg.adjudicator_model, system, user))
            category_id = parsed.get("category_id")
            proposed = parsed.get("new_category_name")
            return {
                "category_id": str(category_id) if category_id else None,
                "new_category_name": str(proposed) if proposed else None,
                "reason": str(parsed.get("reason", "")),
            }
        except Exception as exc:  # engine leaves category null on failure
            return {"category_id": None, "new_category_name": None,
                    "reason": f"classifier_error: {exc}"}
