"""Stage 3.5 — storyline category classification.

The broad seeded category is the only topic label assigned on the stream;
themes are born offline by the promotion sweep. Failure bias: a failed or
hallucinated verdict leaves category_id null, and the runner's end-of-run
retry loop picks it up.
"""

from __future__ import annotations

from pipeline.config import Config


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

