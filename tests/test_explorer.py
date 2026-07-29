import numpy as np
import pytest

from pipeline.explorer import build_explorer_projection, node_dimensions
from pipeline.shared.vectors import pack_fp16


def row(identifier: str, vector: list[float], rank_key: float) -> dict:
    return {
        "centroid": pack_fp16(vector),
        "id": identifier,
        "rank_key": rank_key,
    }


def projector(vectors: np.ndarray) -> np.ndarray:
    return vectors[:, :2]


def test_projection_is_deterministic_and_orders_exact_cosine_neighbors():
    rows = [
        row("story-c", [0.0, 1.0, 0.0], 30),
        row("story-a", [1.0, 0.0, 0.0], 10),
        row("story-b", [0.9, 0.1, 0.0], 20),
    ]

    first = build_explorer_projection(rows, projector)
    second = build_explorer_projection(list(reversed(rows)), projector)

    assert first == second
    assert [node["storylineId"] for node in first["nodes"]] == [
        "story-a",
        "story-b",
        "story-c",
    ]
    assert first["nodes"][0]["neighbors"][0]["storylineId"] == "story-b"
    assert first["nodes"][2]["rankPercentile"] == 1


def test_projection_rejects_mixed_dimensions_and_zero_vectors():
    with pytest.raises(ValueError, match="mixed embedding dimensions"):
        build_explorer_projection(
            [row("a", [1.0, 0.0], 1), row("b", [1.0, 0.0, 0.0], 2)],
            projector,
        )

    with pytest.raises(ValueError, match="zero vectors"):
        build_explorer_projection([row("a", [0.0, 0.0], 1)], projector)


def test_rank_percentile_increases_node_area():
    smallest = node_dimensions(0)
    largest = node_dimensions(1)

    assert largest[0] > smallest[0]
    assert largest[1] > smallest[1]


def test_default_projection_keeps_separated_semantic_clusters_local():
    rows = [
        row(
            f"health-{index}",
            [1.0, 0.02 * index, 0.01 * (index % 2), 0.0],
            index,
        )
        for index in range(6)
    ] + [
        row(
            f"climate-{index}",
            [0.01 * (index % 2), 0.0, 1.0, 0.02 * index],
            index + 6,
        )
        for index in range(6)
    ]

    projection = build_explorer_projection(rows)
    points = {
        node["storylineId"]: np.asarray([node["x"], node["y"]])
        for node in projection["nodes"]
    }
    for node in projection["nodes"]:
        prefix = node["storylineId"].split("-")[0]
        nearest = sorted(
            (
                (float(np.linalg.norm(points[node["storylineId"]] - point)), identifier)
                for identifier, point in points.items()
                if identifier != node["storylineId"]
            )
        )[:3]
        assert sum(identifier.startswith(prefix) for _, identifier in nearest) >= 2
