import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import "@xyflow/react/dist/style.css";

import { dotGovApi } from "./api/client";
import type { StorylineListItem, StorylinePreview } from "./api/contracts";
import { cardAsOf } from "./domain/as-of";

interface ExplorerNodeData extends Record<string, unknown> {
  category: string;
  color: string;
  focused: boolean;
  headline: string;
  rankKey: number | null;
  rankPercentile: number;
  theme: string | null;
}

type StorylineFlowNode = Node<ExplorerNodeData, "storyline">;

interface ExplorerLayoutNode {
  height: number;
  id: string;
  width: number;
  x: number;
  y: number;
}

export function nodeDimensions(rankPercentile: number): {
  height: number;
  width: number;
} {
  const scale = Math.sqrt(Math.min(1, Math.max(0, rankPercentile)));
  return {
    height: 64 + 48 * scale,
    width: 120 + 100 * scale,
  };
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? 0);
}

export function compactExplorerLayout(
  nodes: ExplorerLayoutNode[],
): Map<string, { x: number; y: number }> {
  if (nodes.length === 0) return new Map();

  const ordered = [...nodes].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const centerX = median(ordered.map((node) => node.x));
  const centerY = median(ordered.map((node) => node.y));
  const compression = Math.min(1, Math.max(0.12, ordered.length / 300));
  const positions = ordered.map((node) => ({
    x: (node.x - centerX) * compression,
    y: (node.y - centerY) * compression,
  }));

  for (let iteration = 0; iteration < 160; iteration += 1) {
    let moved = false;
    for (let leftIndex = 0; leftIndex < positions.length; leftIndex += 1) {
      const left = ordered[leftIndex]!;
      const leftPosition = positions[leftIndex]!;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < positions.length;
        rightIndex += 1
      ) {
        const right = ordered[rightIndex]!;
        const rightPosition = positions[rightIndex]!;
        const dx = rightPosition.x - leftPosition.x;
        const dy = rightPosition.y - leftPosition.y;
        const requiredX = (left.width + right.width) / 2 + 20;
        const requiredY = (left.height + right.height) / 2 + 20;
        const overlapX = requiredX - Math.abs(dx);
        const overlapY = requiredY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        moved = true;
        if (overlapX / requiredX < overlapY / requiredY) {
          const direction =
            dx === 0
              ? (leftIndex + rightIndex) % 2 === 0
                ? 1
                : -1
              : Math.sign(dx);
          const adjustment = (overlapX + 0.01) / 2;
          leftPosition.x -= direction * adjustment;
          rightPosition.x += direction * adjustment;
        } else {
          const direction =
            dy === 0
              ? (leftIndex + rightIndex) % 2 === 0
                ? 1
                : -1
              : Math.sign(dy);
          const adjustment = (overlapY + 0.01) / 2;
          leftPosition.y -= direction * adjustment;
          rightPosition.y += direction * adjustment;
        }
      }
    }
    if (!moved) break;
  }

  return new Map(
    ordered.map((node, index) => [node.id, positions[index]!] as const),
  );
}

export function rankPercentiles(
  items: StorylineListItem[],
): Map<string, number> {
  const percentiles = new Map<string, number>(
    items
      .filter((item) => item.rankKey === null)
      .map((item) => [item.id, 0] as const),
  );
  const ranked = items
    .filter(
      (item): item is StorylineListItem & { rankKey: number } =>
        item.rankKey !== null,
    )
    .sort(
      (left, right) =>
        left.rankKey - right.rankKey || left.id.localeCompare(right.id),
    );
  const denominator = Math.max(1, ranked.length - 1);
  for (const [index, item] of ranked.entries()) {
    percentiles.set(item.id, ranked.length === 1 ? 1 : index / denominator);
  }
  return percentiles;
}

function categoryColor(category: string): string {
  let hash = 0;
  for (const character of category) {
    hash = (hash * 31 + character.codePointAt(0)!) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 54% 52%)`;
}

const StorylineMapNode = memo(function StorylineMapNode({
  data,
}: NodeProps<StorylineFlowNode>) {
  return (
    <button
      aria-label={`${data.headline}${data.rankKey === null ? "" : `, rank score ${data.rankKey.toFixed(1)}`}`}
      className={`explorer-node${data.focused ? " is-focused" : ""}`}
      style={{ "--explorer-color": data.color } as React.CSSProperties}
      type="button"
    >
      <span className="explorer-node-category">{data.category}</span>
      <strong>{data.headline}</strong>
      <span className="explorer-node-meta">
        {data.theme ?? "Independent storyline"}
      </span>
    </button>
  );
});

const nodeTypes = { storyline: StorylineMapNode };

function mapNode(
  item: StorylineListItem,
  focusedId: string | null,
  position: { x: number; y: number },
  rankPercentile: number,
): StorylineFlowNode {
  const dimensions = nodeDimensions(rankPercentile);
  const category = item.categoryName ?? "Government";
  return {
    data: {
      category,
      color: categoryColor(category),
      focused: item.id === focusedId,
      headline: item.headline ?? "Untitled storyline",
      rankKey: item.rankKey,
      rankPercentile,
      theme: item.themeName,
    },
    draggable: false,
    id: item.id,
    position: {
      x: position.x - dimensions.width / 2,
      y: position.y - dimensions.height / 2,
    },
    selectable: true,
    style: dimensions,
    type: "storyline",
  };
}

export function ExplorerView({
  asOf,
  entryId,
  focusedId,
  items,
  onFocus,
  onOpen,
  previewByStoryline,
  rankItems,
}: {
  asOf: string;
  entryId: string | null;
  focusedId: string | null;
  items: StorylineListItem[];
  onFocus: (storylineId: string) => void;
  onOpen: (item: StorylineListItem) => void;
  previewByStoryline: Map<string, StorylinePreview>;
  rankItems: StorylineListItem[];
}) {
  const explorer = useQuery({
    queryFn: ({ signal }) => dotGovApi.explorer(signal),
    queryKey: ["explorer"],
  });
  const [instance, setInstance] =
    useState<ReactFlowInstance<StorylineFlowNode> | null>(null);
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  const pointById = useMemo(
    () =>
      new Map(
        (explorer.data?.nodes ?? []).map((point) => [point.storylineId, point]),
      ),
    [explorer.data],
  );
  const rankPercentileById = useMemo(
    () => rankPercentiles(rankItems),
    [rankItems],
  );
  const compactedLayout = useMemo(
    () =>
      compactExplorerLayout(
        items.flatMap((item) => {
          const point = pointById.get(item.id);
          if (point === undefined) return [];
          const dimensions = nodeDimensions(
            rankPercentileById.get(item.id) ?? 0,
          );
          return [{ ...dimensions, id: item.id, x: point.x, y: point.y }];
        }),
      ),
    [items, pointById, rankPercentileById],
  );
  const nodes = useMemo(
    () =>
      items.flatMap((item) => {
        const position = compactedLayout.get(item.id);
        return position === undefined
          ? []
          : [
              mapNode(
                item,
                focusedId,
                position,
                rankPercentileById.get(item.id) ?? 0,
              ),
            ];
      }),
    [compactedLayout, focusedId, items, rankPercentileById],
  );
  const layoutVersion = useMemo(
    () =>
      `${explorer.data?.version ?? "loading"}|${items
        .map((item) => `${item.id}:${item.rankKey ?? "unranked"}`)
        .join("|")}`,
    [explorer.data?.version, items],
  );
  const focusedItem = focusedId === null ? undefined : itemById.get(focusedId);
  const focusedCard =
    focusedItem === undefined
      ? null
      : cardAsOf(
          previewByStoryline.get(focusedItem.id)?.overviewCards ?? [],
          asOf,
        );

  const focusNode = useCallback(
    (storylineId: string) => {
      onFocus(storylineId);
      void instance?.fitView({
        duration: 420,
        maxZoom: 1.35,
        nodes: [{ id: storylineId }],
        padding: 1.6,
      });
    },
    [instance, onFocus],
  );

  useEffect(() => {
    if (
      instance === null ||
      entryId === null ||
      compactedLayout.has(entryId) === false
    ) {
      return;
    }
    onFocus(entryId);
    void instance.fitView({
      duration: 520,
      maxZoom: 1.05,
      nodes: [{ id: entryId }],
      padding: 2.2,
    });
  }, [compactedLayout, entryId, instance, layoutVersion, onFocus]);

  if (explorer.isLoading) {
    return (
      <div className="explorer-state" role="status">
        Building the semantic map…
      </div>
    );
  }
  if (explorer.error) {
    return (
      <div className="explorer-state" role="alert">
        The Explorer map is unavailable. Card and table views are still ready.
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <div className="explorer-state">
        No mapped storylines match the current filters.
      </div>
    );
  }

  return (
    <section
      className="explorer-shell"
      aria-label="Semantic storyline explorer"
    >
      <div className="explorer-map">
        <ReactFlow<StorylineFlowNode>
          edges={[]}
          elementsSelectable
          maxZoom={1.8}
          minZoom={0.16}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          nodeTypes={nodeTypes}
          onInit={setInstance}
          onNodeClick={(_event, node) => focusNode(node.id)}
          onlyRenderVisibleElements
          panOnDrag
          panOnScroll
          preventScrolling
          proOptions={{ hideAttribution: false }}
          selectionOnDrag={false}
          zoomOnDoubleClick
          zoomOnPinch
          zoomOnScroll={false}
        >
          <Background
            color="var(--rule)"
            gap={28}
            size={1}
            variant={BackgroundVariant.Dots}
          />
          <Controls showFitView={false} showInteractive={false} />
        </ReactFlow>
        <div className="explorer-legend">
          <strong>Semantic Explorer · Beta</strong>
          <span>Drag or scroll to roam in any direction.</span>
          <span>Nearby stories share language and subject matter.</span>
          <span>Larger stories have a higher current rank.</span>
        </div>
        <div className="explorer-roam-hint" aria-hidden="true">
          <span>←</span>
          <span>Explore freely</span>
          <span>→</span>
        </div>
      </div>
      <aside className="explorer-inspector" aria-live="polite">
        <label className="explorer-jump">
          <span>Jump anywhere</span>
          <select
            onChange={(event) => focusNode(event.target.value)}
            value={focusedId ?? ""}
          >
            <option disabled value="">
              Select a storyline
            </option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.headline ?? "Untitled storyline"}
              </option>
            ))}
          </select>
        </label>
        {focusedItem === undefined ? (
          <>
            <p className="eyebrow">Choose a landmark</p>
            <h3>Explore the current brief</h3>
            <p>
              Pan in any direction and select any storyline to continue
              exploring from there.
            </p>
          </>
        ) : (
          <>
            <p className="eyebrow">
              {focusedItem.categoryName ?? "Government"}
            </p>
            <h3>{focusedCard?.headline ?? focusedItem.headline}</h3>
            <p>
              {focusedCard?.summary ??
                `${focusedItem.entryCount} reviewed sources across ${focusedItem.episodeCount} episodes.`}
            </p>
            <dl>
              <div>
                <dt>Rank score</dt>
                <dd>{focusedItem.rankKey?.toFixed(1) ?? "Unranked"}</dd>
              </div>
              <div>
                <dt>Theme</dt>
                <dd>{focusedItem.themeName ?? "Not yet themed"}</dd>
              </div>
              <div>
                <dt>Sources</dt>
                <dd>{focusedItem.entryCount}</dd>
              </div>
            </dl>
            <button
              className="primary-button"
              onClick={() => onOpen(focusedItem)}
              type="button"
            >
              Open full storyline
            </button>
          </>
        )}
      </aside>
    </section>
  );
}
