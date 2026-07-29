import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import "@xyflow/react/dist/style.css";

import { dotGovApi } from "./api/client";
import type {
  ExplorerNode,
  StorylineListItem,
  StorylinePreview,
} from "./api/contracts";
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
      <Handle
        className="explorer-handle"
        position={Position.Left}
        type="target"
      />
      <span className="explorer-node-category">{data.category}</span>
      <strong>{data.headline}</strong>
      <span className="explorer-node-meta">
        {data.theme ?? "Independent storyline"}
      </span>
      <Handle
        className="explorer-handle"
        position={Position.Right}
        type="source"
      />
    </button>
  );
});

const nodeTypes = { storyline: StorylineMapNode };

function mapNode(
  point: ExplorerNode,
  item: StorylineListItem,
  focusedId: string | null,
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
      x: point.x - dimensions.width / 2,
      y: point.y - dimensions.height / 2,
    },
    selectable: true,
    style: dimensions,
    type: "storyline",
  };
}

export function ExplorerView({
  asOf,
  focusedId,
  items,
  onFocus,
  onOpen,
  previewByStoryline,
  rankItems,
}: {
  asOf: string;
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
  const [instance, setInstance] = useState<ReactFlowInstance<
    StorylineFlowNode,
    Edge
  > | null>(null);
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
  const nodes = useMemo(
    () =>
      items.flatMap((item) => {
        const point = pointById.get(item.id);
        return point === undefined
          ? []
          : [
              mapNode(
                point,
                item,
                focusedId,
                rankPercentileById.get(item.id) ?? 0,
              ),
            ];
      }),
    [focusedId, items, pointById, rankPercentileById],
  );
  const focusedPoint =
    focusedId === null ? undefined : pointById.get(focusedId);
  const edges = useMemo<Edge[]>(
    () =>
      focusedPoint?.neighbors.flatMap((neighbor) =>
        itemById.has(neighbor.storylineId)
          ? [
              {
                animated: false,
                id: `${focusedPoint.storylineId}:${neighbor.storylineId}`,
                source: focusedPoint.storylineId,
                style: {
                  opacity: 0.2 + Math.max(0, neighbor.similarity) * 0.55,
                  strokeWidth: 1 + Math.max(0, neighbor.similarity) * 2,
                },
                target: neighbor.storylineId,
                type: "straight",
              },
            ]
          : [],
      ) ?? [],
    [focusedPoint, itemById],
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
    const first = nodes[0];
    if (focusedId === null && first !== undefined) {
      onFocus(first.id);
    }
  }, [focusedId, nodes, onFocus]);

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
        <ReactFlow<StorylineFlowNode, Edge>
          edges={edges}
          elementsSelectable
          fitView
          fitViewOptions={{ maxZoom: 0.9, padding: 0.16 }}
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
          <Controls showInteractive={false} />
          <MiniMap
            maskColor="color-mix(in srgb, var(--canvas) 76%, transparent)"
            nodeColor={(node) => String(node.data?.color ?? "var(--muted)")}
            nodeStrokeWidth={2}
            pannable
            zoomable
          />
        </ReactFlow>
        <div className="explorer-legend">
          <strong>Semantic Explorer · Beta</strong>
          <span>Nearby means similar language and subject matter.</span>
          <span>Larger nodes have a higher current rank.</span>
        </div>
      </div>
      <aside className="explorer-inspector" aria-live="polite">
        <label className="explorer-jump">
          <span>Jump to storyline</span>
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
              Pan in any direction and select a storyline to reveal its nearest
              semantic neighbors.
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
