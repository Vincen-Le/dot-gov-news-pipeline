"""Deterministic average-linkage clustering for storyline centroids."""

from __future__ import annotations

import numpy as np

from pipeline.shared.vectors import cosine


def cluster_storylines(vecs: list, link_sim: float) -> list[list[int]]:
    clusters = [[i] for i in range(len(vecs))]
    if len(vecs) < 2:
        return clusters
    dims = sorted({len(v) for v in vecs})
    if len(dims) > 1:
        # storylines.centroid holds mixed embedding dimensions -- almost
        # always a --stub replay run over a db that also has real
        # (e.g. bge-m3, 1024-dim) embeddings from a prior real run. A
        # pairwise cosine over mismatched-length vectors crashes with an
        # opaque numpy shape error three frames down; fail here instead with
        # actionable remediation.
        raise ValueError(
            f"storylines.centroid has mixed embedding dimensions {dims} -- "
            "cannot cluster. This usually means a --stub run wrote overview "
            "cards on top of a corpus with real embeddings. Fix by "
            "regenerating a consistent corpus: `pipeline reset --features` "
            "then `pipeline prepare --stub`.")
    sims = np.array([[cosine(a, b) for b in vecs] for a in vecs])
    while len(clusters) > 1:
        best, best_pair = -1.0, None
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                avg = float(np.mean(
                    [sims[a][b] for a in clusters[i] for b in clusters[j]]))
                if avg > best:
                    best, best_pair = avg, (i, j)
        if best < link_sim:
            break
        i, j = best_pair
        clusters[i] = clusters[i] + clusters[j]
        del clusters[j]
    return clusters
