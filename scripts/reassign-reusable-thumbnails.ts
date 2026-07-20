import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  hostedDatabase,
  type SupabaseRestClient,
} from "../apps/image_and_synthesis_gen/src/shared/database.js";

export type FallbackSelectionSource = "agency_fallback" | "category_fallback";

export interface ReusableThumbnailCandidate {
  imageId: string;
  selectionSource: FallbackSelectionSource;
}

export interface ReusableThumbnailStoryline {
  candidates: readonly ReusableThumbnailCandidate[];
  position: number;
  storylineId: string;
}

export interface PlannedReusableThumbnailAssignment {
  imageId: string;
  position: number;
  selectionSource: FallbackSelectionSource;
  storylineId: string;
}

interface BagState {
  cycle: number;
  lastImageId: string | null;
  remaining: ReusableThumbnailCandidate[];
}

interface StorylineRow {
  agency_ids: string[];
  category_id: string | null;
  id: string;
}

interface ThumbnailRow {
  image_id: string;
  selection_source: "agency_fallback" | "category_fallback" | "generated";
  storyline_id: string;
}

interface CategoryRow {
  id: string;
  image_id: string | null;
}

interface AgencyRow {
  image_id: string;
  publisher_key: string;
}

interface CardRow {
  source_run_id: string;
}

interface RankRow {
  position: number;
  storyline_id: string;
}

interface ReplacementRecord {
  image_id: string;
  position: number;
  previous_image_id: string;
  previous_selection_source: FallbackSelectionSource;
  selection_source: FallbackSelectionSource;
  storyline_id: string;
}

const ALGORITHM = "deterministic-shuffle-bag-v1";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateKey(candidate: ReusableThumbnailCandidate): string {
  return `${candidate.imageId}:${candidate.selectionSource}`;
}

function poolKey(candidates: readonly ReusableThumbnailCandidate[]): string {
  return candidates.map(candidateKey).sort().join("|");
}

function refillBag(
  candidates: readonly ReusableThumbnailCandidate[],
  key: string,
  cycle: number,
): ReusableThumbnailCandidate[] {
  return [...candidates].sort((left, right) =>
    hash(`${ALGORITHM}:${key}:${cycle}:${candidateKey(left)}`).localeCompare(
      hash(`${ALGORITHM}:${key}:${cycle}:${candidateKey(right)}`),
    ),
  );
}

function selectFromBag(
  state: BagState,
  globalPreviousImageId: string | null,
): ReusableThumbnailCandidate {
  const withoutBoth = state.remaining.filter(
    ({ imageId }) =>
      imageId !== state.lastImageId && imageId !== globalPreviousImageId,
  );
  const withoutPoolRepeat = state.remaining.filter(
    ({ imageId }) => imageId !== state.lastImageId,
  );
  const withoutGlobalRepeat = state.remaining.filter(
    ({ imageId }) => imageId !== globalPreviousImageId,
  );
  const eligible =
    withoutBoth.length > 0
      ? withoutBoth
      : withoutPoolRepeat.length > 0
        ? withoutPoolRepeat
        : withoutGlobalRepeat.length > 0
          ? withoutGlobalRepeat
          : state.remaining;
  const selected = eligible[0];
  if (selected === undefined) throw new Error("candidate bag is empty");
  state.remaining = state.remaining.filter(
    (candidate) => candidateKey(candidate) !== candidateKey(selected),
  );
  state.lastImageId = selected.imageId;
  return selected;
}

export function planReusableThumbnailAssignments(
  storylines: readonly ReusableThumbnailStoryline[],
): PlannedReusableThumbnailAssignment[] {
  const bags = new Map<string, BagState>();
  let globalPreviousImageId: string | null = null;
  return [...storylines]
    .sort(
      (left, right) =>
        left.position - right.position ||
        left.storylineId.localeCompare(right.storylineId),
    )
    .map((storyline) => {
      const deduplicated = [
        ...new Map(
          storyline.candidates.map((candidate) => [
            candidate.imageId,
            candidate,
          ]),
        ).values(),
      ];
      if (deduplicated.length === 0) {
        throw new Error(
          `storyline ${storyline.storylineId} has no fallback candidates`,
        );
      }
      const key = poolKey(deduplicated);
      const state = bags.get(key) ?? {
        cycle: 0,
        lastImageId: null,
        remaining: [],
      };
      if (state.remaining.length === 0) {
        state.remaining = refillBag(deduplicated, key, state.cycle);
        state.cycle += 1;
      }
      const selected = selectFromBag(state, globalPreviousImageId);
      bags.set(key, state);
      globalPreviousImageId = selected.imageId;
      return {
        imageId: selected.imageId,
        position: storyline.position,
        selectionSource: selected.selectionSource,
        storylineId: storyline.storylineId,
      };
    });
}

function records<T>(rows: unknown[], description: string): T[] {
  if (!rows.every((row) => typeof row === "object" && row !== null)) {
    throw new Error(`${description} returned invalid rows`);
  }
  return rows as T[];
}

async function buildReplacementPlan(database: SupabaseRestClient): Promise<{
  generated: ThumbnailRow[];
  replacements: ReplacementRecord[];
}> {
  const [storylines, thumbnails, categories, agencies, cards] =
    await Promise.all([
      database.select("golden_storylines", "id,category_id,agency_ids"),
      database.select(
        "golden_storyline_thumbnails",
        "storyline_id,image_id,selection_source",
      ),
      database.select("golden_topic_categories", "id,image_id"),
      database.select("agency_thumbnail_images", "publisher_key,image_id"),
      database.select("golden_event_cards", "source_run_id"),
    ]);
  const storylineRows = records<StorylineRow>(storylines, "storylines");
  const thumbnailRows = records<ThumbnailRow>(thumbnails, "thumbnails");
  const categoryRows = records<CategoryRow>(categories, "categories");
  const agencyRows = records<AgencyRow>(agencies, "agencies");
  const sourceRunIds = [
    ...new Set(
      records<CardRow>(cards, "cards").map((row) => row.source_run_id),
    ),
  ];
  if (sourceRunIds.length !== 1 || sourceRunIds[0] === undefined) {
    throw new Error(
      `expected one golden source run, found ${sourceRunIds.length}`,
    );
  }
  const rankRows = records<RankRow>(
    await database.select("simple_v1_rank_snapshots", "position,storyline_id", {
      filters: {
        facet_key: "eq.",
        facet_type: "eq.global",
        run_id: `eq.${sourceRunIds[0]}`,
      },
      order: "position.asc",
    }),
    "rank snapshots",
  );
  const positionByStoryline = new Map(
    rankRows.map((row) => [row.storyline_id, row.position]),
  );
  const categoryImageById = new Map(
    categoryRows.flatMap((row) =>
      row.image_id === null ? [] : [[row.id, row.image_id] as const],
    ),
  );
  const agencyImageByKey = new Map(
    agencyRows.map((row) => [row.publisher_key, row.image_id]),
  );
  const fallbackByStoryline = new Map(
    thumbnailRows
      .filter((row) => row.selection_source !== "generated")
      .map((row) => [row.storyline_id, row]),
  );
  const inputs = storylineRows.flatMap((storyline) => {
    if (!fallbackByStoryline.has(storyline.id)) return [];
    const position = positionByStoryline.get(storyline.id);
    if (position === undefined) {
      throw new Error(`storyline ${storyline.id} has no global rank position`);
    }
    const candidates: ReusableThumbnailCandidate[] = [];
    const categoryImageId =
      storyline.category_id === null
        ? undefined
        : categoryImageById.get(storyline.category_id);
    if (categoryImageId !== undefined) {
      candidates.push({
        imageId: categoryImageId,
        selectionSource: "category_fallback",
      });
    }
    for (const agencyId of storyline.agency_ids) {
      const imageId = agencyImageByKey.get(agencyId);
      if (
        imageId !== undefined &&
        !candidates.some((row) => row.imageId === imageId)
      ) {
        candidates.push({ imageId, selectionSource: "agency_fallback" });
      }
    }
    return [{ candidates, position, storylineId: storyline.id }];
  });
  const plan = planReusableThumbnailAssignments(inputs);
  const replacements = plan.map((assignment): ReplacementRecord => {
    const previous = fallbackByStoryline.get(assignment.storylineId);
    if (previous === undefined || previous.selection_source === "generated") {
      throw new Error(
        `storyline ${assignment.storylineId} lost its fallback row`,
      );
    }
    return {
      image_id: assignment.imageId,
      position: assignment.position,
      previous_image_id: previous.image_id,
      previous_selection_source: previous.selection_source,
      selection_source: assignment.selectionSource,
      storyline_id: assignment.storylineId,
    };
  });
  if (replacements.length !== fallbackByStoryline.size) {
    throw new Error(
      "replacement plan does not cover every fallback association",
    );
  }
  return {
    generated: thumbnailRows.filter(
      (row) => row.selection_source === "generated",
    ),
    replacements,
  };
}

function summarize(replacements: readonly ReplacementRecord[]): object {
  const counts = replacements.reduce<Record<string, number>>((result, row) => {
    result[row.selection_source] = (result[row.selection_source] ?? 0) + 1;
    return result;
  }, {});
  return {
    algorithm: ALGORITHM,
    changed: replacements.filter(
      (row) =>
        row.image_id !== row.previous_image_id ||
        row.selection_source !== row.previous_selection_source,
    ).length,
    planned: replacements.length,
    selectionSources: counts,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  const database = hostedDatabase();
  const { generated, replacements } = await buildReplacementPlan(database);
  process.stdout.write(
    `${JSON.stringify({ event: "reusable_thumbnail_plan", generatedPreserved: generated.length, ...summarize(replacements) })}\n`,
  );
  if (!apply) return;
  await database.rpc("replace_golden_storyline_fallback_thumbnails", {
    p_algorithm: ALGORITHM,
    p_assignments: replacements,
  });
  const persisted = records<ThumbnailRow>(
    await database.select(
      "golden_storyline_thumbnails",
      "storyline_id,image_id,selection_source",
    ),
    "persisted thumbnails",
  );
  const persistedByStoryline = new Map(
    persisted.map((row) => [row.storyline_id, row]),
  );
  for (const replacement of replacements) {
    const row = persistedByStoryline.get(replacement.storyline_id);
    if (
      row?.image_id !== replacement.image_id ||
      row.selection_source !== replacement.selection_source
    ) {
      throw new Error(
        `persisted assignment mismatch for ${replacement.storyline_id}`,
      );
    }
  }
  for (const original of generated) {
    const row = persistedByStoryline.get(original.storyline_id);
    if (
      row?.image_id !== original.image_id ||
      row.selection_source !== "generated"
    ) {
      throw new Error(
        `generated thumbnail changed for ${original.storyline_id}`,
      );
    }
  }
  process.stdout.write(
    `${JSON.stringify({ event: "reusable_thumbnail_assignment_complete", generatedPreserved: generated.length, ...summarize(replacements) })}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
