"""Stage 3.5 — storyline category classification.

The broad seeded category is the only topic label assigned on the stream;
themes are born offline by the promotion sweep. Failure bias: a failed or
hallucinated verdict leaves category_id null, and the runner's end-of-run
retry loop picks it up.
"""

from __future__ import annotations

from pipeline.shared.config import Config


class CategoryEngine:
    def __init__(self, store, models, cfg: Config) -> None:
        self.store = store
        self.models = models
        self.cfg = cfg

    def classify(self, storyline_id: str, method: str = "classified") -> None:
        state = self.store.storyline_theme_state(storyline_id)
        if state is None or state.get("category_id") is not None:
            return
        categories = [c for c in self.store.all_categories()
                      if c.get("origin") == "seed"]
        if not categories:
            return
        storyline = {"headline": state.get("headline") or "(no card)",
                     "summary": state.get("summary") or ""}
        try:
            verdict = self.models.classify_category(storyline, categories)
        except Exception:
            return  # left null; retried at end of run
        chosen = verdict.get("category_id")
        if chosen in {str(c["id"]) for c in categories}:
            self.store.set_storyline_category(
                storyline_id, chosen, method=method,
                reason=verdict.get("reason") or None)

    def classify_many(self, storyline_ids: list[str],
                      method: str = "classified", concurrency: int = 8) -> int:
        """Batch classification: serial reads, parallel LLM calls, serial
        writes (the psycopg connection is single-threaded; httpx is not)."""
        from concurrent.futures import ThreadPoolExecutor

        categories = [c for c in self.store.all_categories()
                      if c.get("origin") == "seed"]
        if not categories:
            return 0
        valid_ids = {str(c["id"]) for c in categories}
        pending = []
        for storyline_id in storyline_ids:
            state = self.store.storyline_theme_state(storyline_id)
            if state is None or state.get("category_id") is not None:
                continue
            pending.append((storyline_id,
                            {"headline": state.get("headline") or "(no card)",
                             "summary": state.get("summary") or ""}))
        if not pending:
            return 0

        def judge(item):
            storyline_id, storyline = item
            try:
                return storyline_id, self.models.classify_category(
                    storyline, categories)
            except Exception:
                return storyline_id, None  # left null; caller may retry

        written = 0
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            verdicts = list(pool.map(judge, pending))
        for storyline_id, verdict in verdicts:
            if verdict is None:
                continue
            chosen = verdict.get("category_id")
            if chosen in valid_ids:
                self.store.set_storyline_category(
                    storyline_id, chosen, method=method,
                    reason=verdict.get("reason") or None)
                written += 1
        return written
