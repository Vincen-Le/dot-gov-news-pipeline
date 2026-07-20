"""Match reclustered storyline groups to stable persisted theme IDs."""

from __future__ import annotations


def reconcile(clusters: list[list[str]], existing: dict[str, set[str]],
              keep_overlap: float) -> list[tuple[str | None, list[str]]]:
    pairs = []
    for ci, cluster in enumerate(clusters):
        members = set(cluster)
        for theme_id, theme_members in existing.items():
            jaccard = (len(members & theme_members)
                       / len(members | theme_members))
            if jaccard >= keep_overlap:
                pairs.append((jaccard, ci, theme_id))
    pairs.sort(key=lambda p: (-p[0], p[1], p[2]))
    cluster_theme: dict[int, str] = {}
    used: set[str] = set()
    for _jaccard, ci, theme_id in pairs:
        if ci not in cluster_theme and theme_id not in used:
            cluster_theme[ci] = theme_id
            used.add(theme_id)
    return [(cluster_theme.get(ci), cluster) for ci, cluster in
            enumerate(clusters)]
