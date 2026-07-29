"""Deterministic semantic-map projection for the demo explorer."""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable
from typing import Any

import numpy as np

from pipeline.shared.vectors import unpack_fp16

EXPLORER_NEIGHBORS = 8
EXPLORER_RANDOM_STATE = 42
EXPLORER_COLLISION_PADDING = 32.0
EXPLORER_PROJECTION_SCALE = 520.0
EXPLORER_PROJECTION_ALGORITHM = "cosine-tsne-v2"

Projector = Callable[[np.ndarray], np.ndarray]


def node_dimensions(rank_percentile: float) -> tuple[float, float]:
    """Return the dimensions shared by projection collision and the UI."""
    scale = math.sqrt(min(1.0, max(0.0, rank_percentile)))
    return 120.0 + 100.0 * scale, 64.0 + 48.0 * scale


def _default_projector(vectors: np.ndarray) -> np.ndarray:
    if len(vectors) == 1:
        return np.zeros((1, 2), dtype=np.float32)
    if len(vectors) == 2:
        return np.asarray([[-1.0, 0.0], [1.0, 0.0]], dtype=np.float32)

    from sklearn.manifold import TSNE

    return TSNE(
        angle=0.35,
        init="pca",
        learning_rate="auto",
        max_iter=1500,
        metric="cosine",
        method="barnes_hut",
        n_components=2,
        n_jobs=1,
        perplexity=min(30.0, max(1.0, (len(vectors) - 1) / 3)),
        random_state=EXPLORER_RANDOM_STATE,
    ).fit_transform(vectors)


def _separate_overlaps(
    positions: np.ndarray, rank_percentiles: list[float]
) -> np.ndarray:
    """Resolve rectangular collisions without changing semantic neighbors."""
    result = positions.astype(np.float64, copy=True)
    sizes = [node_dimensions(percentile) for percentile in rank_percentiles]
    for _ in range(160):
        moved = False
        for left in range(len(result)):
            for right in range(left + 1, len(result)):
                dx = float(result[right, 0] - result[left, 0])
                dy = float(result[right, 1] - result[left, 1])
                required_x = (
                    (sizes[left][0] + sizes[right][0]) / 2
                    + EXPLORER_COLLISION_PADDING
                )
                required_y = (
                    (sizes[left][1] + sizes[right][1]) / 2
                    + EXPLORER_COLLISION_PADDING
                )
                overlap_x = required_x - abs(dx)
                overlap_y = required_y - abs(dy)
                if overlap_x <= 0 or overlap_y <= 0:
                    continue
                moved = True
                if overlap_x / required_x < overlap_y / required_y:
                    direction = 1.0 if dx >= 0 else -1.0
                    if dx == 0:
                        direction = 1.0 if (left + right) % 2 == 0 else -1.0
                    adjustment = (overlap_x + 0.01) / 2
                    result[left, 0] -= direction * adjustment
                    result[right, 0] += direction * adjustment
                else:
                    direction = 1.0 if dy >= 0 else -1.0
                    if dy == 0:
                        direction = 1.0 if (left + right) % 2 == 0 else -1.0
                    adjustment = (overlap_y + 0.01) / 2
                    result[left, 1] -= direction * adjustment
                    result[right, 1] += direction * adjustment
        if not moved:
            break
    return result


def build_explorer_projection(
    rows: list[dict[str, Any]], projector: Projector | None = None
) -> dict[str, Any]:
    """Project reviewed storyline centroids and retain exact cosine neighbors."""
    ordered = sorted(rows, key=lambda row: str(row["id"]))
    if not ordered:
        return {"nodes": [], "version": "empty"}

    vectors = [unpack_fp16(row["centroid"]) for row in ordered]
    dimensions = {len(vector) for vector in vectors}
    if len(dimensions) != 1:
        raise ValueError(
            f"explorer centroids have mixed embedding dimensions {sorted(dimensions)}"
        )
    matrix = np.stack(vectors).astype(np.float32)
    norms = np.linalg.norm(matrix, axis=1)
    if np.any(norms == 0):
        bad = [
            str(ordered[index]["id"])
            for index, norm in enumerate(norms)
            if norm == 0
        ]
        raise ValueError("explorer centroids contain zero vectors: " + ", ".join(bad))
    normalized = matrix / norms[:, np.newaxis]
    similarities = np.clip(normalized @ normalized.T, -1.0, 1.0)

    ranked = sorted(
        range(len(ordered)),
        key=lambda index: (
            float(ordered[index]["rank_key"]),
            str(ordered[index]["id"]),
        ),
    )
    denominator = max(1, len(ordered) - 1)
    rank_percentiles = [0.0] * len(ordered)
    for position, index in enumerate(ranked):
        rank_percentiles[index] = position / denominator

    raw_positions = (projector or _default_projector)(normalized)
    if raw_positions.shape != (len(ordered), 2):
        raise ValueError(
            "explorer projector must return one two-dimensional point per storyline"
        )
    centered = raw_positions - np.median(raw_positions, axis=0)
    spread = np.std(centered, axis=0)
    spread[spread < 1e-6] = 1.0
    density_scale = max(1.0, math.sqrt(len(ordered) / 25))
    scaled = centered / spread * EXPLORER_PROJECTION_SCALE * density_scale
    positions = _separate_overlaps(scaled, rank_percentiles)

    version_hash = hashlib.sha256()
    version_hash.update(
        json.dumps(
            {
                "collision_padding": EXPLORER_COLLISION_PADDING,
                "neighbors": EXPLORER_NEIGHBORS,
                "projection": EXPLORER_PROJECTION_ALGORITHM,
                "projection_scale": EXPLORER_PROJECTION_SCALE,
                "random_state": EXPLORER_RANDOM_STATE,
            },
            sort_keys=True,
        ).encode()
    )
    for row in ordered:
        version_hash.update(str(row["id"]).encode())
        version_hash.update(row["centroid"])
        version_hash.update(str(float(row["rank_key"])).encode())
    version = version_hash.hexdigest()[:20]

    nodes = []
    for index, row in enumerate(ordered):
        neighbor_indices = sorted(
            (candidate for candidate in range(len(ordered)) if candidate != index),
            key=lambda candidate: (
                -float(similarities[index, candidate]),
                str(ordered[candidate]["id"]),
            ),
        )[:EXPLORER_NEIGHBORS]
        nodes.append(
            {
                "neighbors": [
                    {
                        "similarity": round(
                            float(similarities[index, candidate]), 6
                        ),
                        "storylineId": str(ordered[candidate]["id"]),
                    }
                    for candidate in neighbor_indices
                ],
                "rankPercentile": round(rank_percentiles[index], 6),
                "storylineId": str(row["id"]),
                "x": round(float(positions[index, 0]), 3),
                "y": round(float(positions[index, 1]), 3),
            }
        )
    return {"nodes": nodes, "version": version}


def refresh_golden_explorer_layout(db) -> dict[str, Any]:
    """Replace the golden explorer artifact from the reviewed render mirror."""
    rows = db.all(
        """
        select storyline.id, storyline.centroid, card.rank_key
        from public.golden_storylines storyline
        join public.golden_event_cards card
          on card.id = storyline.latest_card_id
        where storyline.merged_into is null
          and storyline.centroid is not null
          and storyline.entry_count = (
              select count(*)::integer
              from public.golden_news_entries membership
              where membership.gold_storyline_id = storyline.id
                and membership.review_status = 'reviewed'
          )
        order by storyline.id
        """
    )
    projection = build_explorer_projection(rows)
    db.conn.execute("delete from public.golden_storyline_explorer_nodes")
    for node in projection["nodes"]:
        db.conn.execute(
            """
            insert into public.golden_storyline_explorer_nodes (
                storyline_id, projection_version, x, y, rank_percentile, neighbors
            ) values (
                %(storyline_id)s, %(version)s, %(x)s, %(y)s,
                %(rank_percentile)s, %(neighbors)s::jsonb
            )
            """,
            {
                "neighbors": json.dumps(node["neighbors"]),
                "rank_percentile": node["rankPercentile"],
                "storyline_id": node["storylineId"],
                "version": projection["version"],
                "x": node["x"],
                "y": node["y"],
            },
        )
    return {
        "nodes": len(projection["nodes"]),
        "version": projection["version"],
    }
