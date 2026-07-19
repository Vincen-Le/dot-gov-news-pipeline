"""Fitting recovers a dominant criterion from synthetic preference pairs."""

import numpy as np

from pipeline.fit import fit_weights
from pipeline.prompts import RUBRIC_CRITERIA


def _bits(**on):
    return np.array([1.0 if on.get(c) else 0.0 for c in RUBRIC_CRITERIA])


def test_fit_recovers_dominant_criterion():
    # ground truth: health_safety dominates, novelty is worthless
    pairs = []
    for i in range(60):
        a = _bits(health_safety=True, economic=(i % 2 == 0))
        b = _bits(novelty=True, economic=(i % 3 == 0))
        pairs.append({"bits_a": a, "bits_b": b, "offset": 0.0, "verdict": "a"})
        # and the mirrored pair so the fit sees both directions
        pairs.append({"bits_a": b, "bits_b": a, "offset": 0.0, "verdict": "b"})
    weights = fit_weights(pairs)
    assert weights["health_safety"] > weights["novelty"]
    assert weights["health_safety"] > 0.0


def test_fit_is_deterministic():
    pairs = [{"bits_a": _bits(urgency=True), "bits_b": _bits(),
              "offset": 0.0, "verdict": "a"}] * 60
    assert fit_weights(pairs) == fit_weights(pairs)
