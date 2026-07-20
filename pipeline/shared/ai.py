from __future__ import annotations

import json
import re
from collections import Counter

import httpx
import numpy as np

from pipeline.shared.config import Config
from pipeline.shared.prompts import (
    ADJUDICATOR_JSON_SCHEMA,
    CATEGORY_CLASSIFIER_JSON_SCHEMA,
    COMPRESSOR_JSON_SCHEMA,
    RANK_AUDIT_JSON_SCHEMA,
    RUBRIC_CRITERIA,
    THEME_MEMBERSHIP_JSON_SCHEMA,
    THEME_PROMOTION_JSON_SCHEMA,
    THEME_REVIEW_JSON_SCHEMA,
    build_adjudicator_prompt,
    build_category_classifier_prompt,
    build_compressor_prompt,
    build_enricher_prompt,
    build_rank_audit_prompt,
    build_theme_membership_prompt,
    build_theme_promotion_prompt,
    build_theme_review_prompt,
)

_TRANSPORT_ATTEMPTS = 3
# Anthropic-routed chat calls (judges/compressor/classifier): thinking is
# adaptive by default on Sonnet 5; low effort keeps per-call latency small
# for verdict-sized outputs. 8192 leaves headroom for thinking + the
# compressor's timeline.
_ANTHROPIC_EFFORT = "low"
_ANTHROPIC_MAX_TOKENS = 8192


def _json_mode(schema: dict) -> dict:
    return {"type": "json_schema", "json_schema": schema}


def _anthropic_schema(schema: dict) -> dict:
    """Anthropic structured outputs require additionalProperties: false on
    every object; Workers AI schemas omit it. Returns an adapted copy."""
    import copy

    adapted = copy.deepcopy(schema)

    def close_objects(node) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object":
                node.setdefault("additionalProperties", False)
            for value in node.values():
                close_objects(value)
        elif isinstance(node, list):
            for item in node:
                close_objects(item)

    close_objects(adapted)
    return adapted


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
            # p90 Workers AI stragglers ran ~2min; cutting at 60s and
            # retrying (timeouts are TransportErrors — _run retries them)
            # beats waiting out a hung call. Healthy JSON-mode calls run
            # 2-4s; the compressor's worst observed median was ~27s.
            timeout=httpx.Timeout(60.0, connect=10.0),
            transport=transport,
        )

    def _run(self, model: str, payload: dict) -> dict:
        for attempt in range(_TRANSPORT_ATTEMPTS):
            try:
                response = self.http.post(self.base + model, json=payload)
                break
            except httpx.TransportError:
                if attempt + 1 == _TRANSPORT_ATTEMPTS:
                    raise
        response.raise_for_status()
        body = response.json()
        if not body.get("success", False):
            raise RuntimeError(f"workers ai error: {body.get('errors')}")
        return body["result"]

    def _chat(self, model: str, system: str, user: str,
              response_format: dict | None = None) -> str:
        # route by model id: claude-* → Anthropic Messages API (reliable
        # structured outputs; Workers AI proved flaky — 403s/stragglers),
        # everything else → Workers AI (embeddings, enricher)
        if model.startswith("claude-"):
            return self._chat_anthropic(model, system, user, response_format)
        payload = {
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
        }
        if response_format is not None:
            payload["response_format"] = response_format
        result = self._run(model, payload)
        return result["response"]

    def _anthropic_client(self):
        if not hasattr(self, "_anthropic"):
            import anthropic
            self._anthropic = anthropic.Anthropic()  # ANTHROPIC_API_KEY from env
        return self._anthropic

    def _chat_anthropic(self, model: str, system: str, user: str,
                        response_format: dict | None) -> str:
        kwargs = {"output_config": {"effort": _ANTHROPIC_EFFORT}}
        if response_format is not None:
            kwargs["output_config"]["format"] = {
                "type": "json_schema",
                "schema": _anthropic_schema(response_format["json_schema"]),
            }
        response = self._anthropic_client().messages.create(
            model=model, max_tokens=_ANTHROPIC_MAX_TOKENS,
            system=system, messages=[{"role": "user", "content": user}],
            **kwargs)
        return next(block.text for block in response.content
                    if block.type == "text")

    # Workers AI rejects large embedding payloads with a bare 400 (observed:
    # 60 texts / 131KB). Split requests by cumulative size; item order is
    # preserved across chunks.
    _EMBED_CHAR_BUDGET = 30_000

    def embed(self, texts: list[str]) -> list[np.ndarray]:
        vectors: list[np.ndarray] = []
        chunk: list[str] = []
        chunk_chars = 0
        for text in texts:
            if chunk and chunk_chars + len(text) > self._EMBED_CHAR_BUDGET:
                result = self._run(self.cfg.embedding_model, {"text": chunk})
                vectors.extend(np.asarray(v, dtype=np.float32)
                               for v in result["data"])
                chunk, chunk_chars = [], 0
            chunk.append(text)
            chunk_chars += len(text)
        if chunk:
            result = self._run(self.cfg.embedding_model, {"text": chunk})
            vectors.extend(np.asarray(v, dtype=np.float32)
                           for v in result["data"])
        return vectors

    def enrich(self, title: str, summary: str | None) -> str:
        system, user = build_enricher_prompt(title, summary)
        return self._chat(self.cfg.enricher_model, system, user).strip()

    def adjudicate_same_event(self, a: dict, b: dict, context: str) -> tuple[bool, str]:
        system, user = build_adjudicator_prompt(a, b, context)
        try:
            parsed = _extract_json(self._chat(
                self.cfg.adjudicator_model, system, user,
                response_format=_json_mode(ADJUDICATOR_JSON_SCHEMA)))
            return bool(parsed.get("same_event", False)), str(parsed.get("reason", ""))
        except Exception as exc:  # split-biased: any failure means "not the same event"
            self.errors["adjudicator"] += 1
            return False, f"adjudicator_error: {exc}"

    def compress_overview(self, storyline_summary: dict, episode_cards: list[dict]) -> dict:
        system, user = build_compressor_prompt(storyline_summary, episode_cards)
        parsed = _extract_json(self._chat(
            self.cfg.judge_model, system, user,
            response_format=_json_mode(COMPRESSOR_JSON_SCHEMA)))
        parsed.setdefault("rubric", {})
        for criterion in RUBRIC_CRITERIA:
            parsed["rubric"].setdefault(criterion, 0)
        return parsed

    def compare_rank(self, a: dict, b: dict) -> dict:
        system, user = build_rank_audit_prompt(a, b)
        try:
            parsed = _extract_json(self._chat(
                self.cfg.audit_model, system, user,
                response_format=_json_mode(RANK_AUDIT_JSON_SCHEMA)))
            prefers = str(parsed.get("prefers", "")).strip().lower()
            if prefers not in ("a", "b"):
                return {"prefers": "invalid",
                        "reason": f"rank_audit_error: unparseable verdict {parsed!r}"}
            return {"prefers": prefers, "reason": str(parsed.get("reason", ""))[:2048]}
        except Exception as exc:  # audit failure is recorded, never raised
            self.errors["rank_audit"] += 1
            return {"prefers": "invalid", "reason": f"rank_audit_error: {exc}"}

    def classify_category(self, storyline: dict,
                          categories: list[dict]) -> dict:
        """Assign one seeded category; the only stream-time topic label."""
        system, user = build_category_classifier_prompt(storyline, categories)
        try:
            parsed = _extract_json(self._chat(
                self.cfg.judge_model, system, user,
                response_format=_json_mode(CATEGORY_CLASSIFIER_JSON_SCHEMA)))
            return {
                "category_id": (str(parsed["category_id"])
                                if parsed.get("category_id") else None),
                "reason": str(parsed.get("reason", "")),
            }
        except Exception:
            self.errors["category_classifier"] += 1
            raise

    def adjudicate_membership(self, storyline: dict,
                              candidates: list[dict]) -> dict:
        # raises on failure by design: the stream path is none-biased and skips
        system, user = build_theme_membership_prompt(storyline, candidates)
        parsed = _extract_json(self._chat(
            self.cfg.judge_model, system, user,
            response_format=_json_mode(THEME_MEMBERSHIP_JSON_SCHEMA)))
        return {
            "theme_id": str(parsed["theme_id"]) if parsed.get("theme_id") else None,
            "reason": str(parsed.get("reason", "")),
        }

    def judge_promotion(self, dossier: dict) -> dict:
        # raises on failure by design: a failed verdict never births a theme
        system, user = build_theme_promotion_prompt(dossier)
        try:
            parsed = _extract_json(self._chat(
                self.cfg.judge_model, system, user,
                response_format=_json_mode(THEME_PROMOTION_JSON_SCHEMA)))
            return {
                "verdict": str(parsed.get("verdict") or ""),
                "theme_name": (str(parsed["theme_name"])
                               if parsed.get("theme_name") else None),
                "inclusion_criterion": (str(parsed["inclusion_criterion"])
                                        if parsed.get("inclusion_criterion") else None),
                "theme_id": (str(parsed["theme_id"])
                             if parsed.get("theme_id") else None),
                "reason": str(parsed.get("reason", "")),
            }
        except Exception:
            self.errors["theme_promotion"] += 1
            raise

    def review_theme(self, dossier: dict) -> dict:
        # raises on failure by design: a failed verdict never demotes
        system, user = build_theme_review_prompt(dossier)
        try:
            parsed = _extract_json(self._chat(
                self.cfg.judge_model, system, user,
                response_format=_json_mode(THEME_REVIEW_JSON_SCHEMA)))
            return {"verdict": str(parsed.get("verdict") or ""),
                    "reason": str(parsed.get("reason", ""))}
        except Exception:
            self.errors["theme_review"] += 1
            raise

    def link_storyline(self, entry: dict, candidates: list[dict]) -> dict:
        from pipeline.simple.prompts import LINK_JSON_SCHEMA, build_link_prompt
        try:
            system, user = build_link_prompt(entry, candidates)
            data = _extract_json(self._chat(
                self.cfg.adjudicator_model, system, user,
                response_format=_json_mode(LINK_JSON_SCHEMA)))
            match = data.get("match")
            if match is not None:
                match = int(match)
                if not 0 <= match < len(candidates):
                    match = None
            return {"match": match,
                    "same_development": bool(data.get("same_development")),
                    "reason": str(data.get("reason", ""))[:512]}
        except Exception as exc:
            self.errors["link_storyline"] += 1
            return {"match": None, "same_development": False,
                    "reason": f"adjudicator_error: {exc}"[:512]}

    def induce_theme(self, members: list[dict]) -> dict:
        from pipeline.simple.prompts import THEME_JSON_SCHEMA, build_theme_prompt
        try:
            system, user = build_theme_prompt(members)
            data = _extract_json(self._chat(
                self.cfg.judge_model, system, user,
                response_format=_json_mode(THEME_JSON_SCHEMA)))
            return {"theme": bool(data.get("theme")),
                    "name": str(data.get("name", "")).strip()[:120],
                    "reason": str(data.get("reason", ""))[:512]}
        except Exception as exc:
            self.errors["induce_theme"] += 1
            return {"theme": False, "name": "",
                    "reason": f"adjudicator_error: {exc}"[:512]}
