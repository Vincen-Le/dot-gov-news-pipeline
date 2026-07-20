import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { type SupabaseRestClient } from "./database.js";
import {
  isFullyReviewedAtCutoff,
  isReviewedHashMatch,
  visibleAtCutoff,
} from "./eligibility.js";
import { canonicalJson, fingerprint, partitionFor } from "./fingerprint.js";
import {
  type ExportIndex,
  type OverviewInputBasis,
  type OverviewTask,
} from "./types.js";

const UuidSchema = z.string().uuid();
const GoldenRowSchema = z.object({
  batch_number: z.number().int(),
  content_hash_at_review: z.string(),
  gold_storyline_id: UuidSchema.nullable(),
  is_syndicated: z.boolean(),
  news_entry_id: UuidSchema,
  ordinal: z.number().int(),
  review_status: z.string(),
});
const NewsEntryRowSchema = z.object({
  body_text: z.string().nullable(),
  content_hash: z.string(),
  entity_set: z.array(z.string()),
  event_keys: z.array(z.string()),
  id: UuidSchema,
  news_source_id: UuidSchema,
  published_at: z.string().nullable(),
  summary: z.string().nullable(),
  title: z.string().nullable(),
  url: z.string(),
});
const CardRowSchema = z.object({
  generated_at: z.string(),
  headline: z.string(),
  id: UuidSchema,
  interest_reason: z.string().nullable(),
  kind: z.literal("overview"),
  newest_entry_at: z.string(),
  storyline_id: UuidSchema,
  summary: z.string(),
  timeline: z.unknown().nullable(),
  version: z.number().int(),
});
const StorylineRowSchema = z.object({
  category_id: UuidSchema.nullable(),
  entity_set: z.array(z.string()),
  event_keys: z.array(z.string()),
  id: UuidSchema,
  theme_id: UuidSchema.nullable(),
});
const TaxonomyRowSchema = z.object({
  display_name: z.string(),
  id: UuidSchema,
});
const PublisherRowSchema = z.object({
  news_source_id: UuidSchema,
  publisher_key: z.string(),
});
const SourceRowSchema = z.object({
  id: UuidSchema,
  title: z.string().nullable(),
});

interface EnrichedGoldenRow {
  agency: string;
  bodyText: string | null;
  contentHash: string;
  contentHashAtReview: string;
  entitySet: string[];
  eventKeys: string[];
  goldStorylineId: string | null;
  isSyndicated: boolean;
  newsEntryId: string;
  newsSourceId: string;
  publishedAt: string | null;
  publisherKey: string;
  publisherSummary: string | null;
  reviewStatus: string;
  sourceTitle: string | null;
  title: string | null;
  url: string;
}

export interface ExportOptions {
  dryRun: boolean;
  expectedTasks?: readonly TaskIdentity[];
  limit?: number;
  outputDirectory: string;
  partitionCount: number;
}

export interface TaskIdentity {
  eventCardId: string;
  inputHash: string;
}

export interface ExportResult extends ExportIndex {
  outputDirectory: string;
}

export function assertExpectedTasksStillCurrent(
  currentTasks: readonly TaskIdentity[],
  expectedTasks: readonly TaskIdentity[],
): void {
  const currentByCard = new Map(
    currentTasks.map((task) => [task.eventCardId, task.inputHash]),
  );
  for (const expected of expectedTasks) {
    const currentHash = currentByCard.get(expected.eventCardId);
    if (currentHash === undefined) {
      throw new Error(
        `card ${expected.eventCardId} is no longer eligible for enrichment`,
      );
    }
    if (currentHash !== expected.inputHash) {
      throw new Error(
        `card ${expected.eventCardId} changed after its enrichment manifest was exported`,
      );
    }
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function selectByIds(
  database: SupabaseRestClient,
  table: string,
  columns: string,
  ids: readonly string[],
  idColumn = "id",
): Promise<unknown[]> {
  const output: unknown[] = [];
  for (const batch of chunks(sortedUnique(ids), 100)) {
    if (batch.length === 0) continue;
    output.push(
      ...(await database.select(table, columns, {
        filters: { [idColumn]: `in.(${batch.join(",")})` },
      })),
    );
  }
  return output;
}

function normalizeTimeline(
  value: unknown,
): OverviewInputBasis["card"]["timeline"] {
  if (!Array.isArray(value)) return null;
  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("golden card has invalid timeline item");
    }
    const record = item as Record<string, unknown>;
    const date = typeof record.date === "string" ? record.date : "";
    const rawEpisodeId = record.episodeId ?? record.episode_id;
    const episodeId = typeof rawEpisodeId === "string" ? rawEpisodeId : null;
    const text = typeof record.text === "string" ? record.text : undefined;
    return text === undefined ? { date, episodeId } : { date, episodeId, text };
  });
}

async function writeManifest(
  outputDirectory: string,
  tasks: readonly OverviewTask[],
  index: ExportIndex,
): Promise<void> {
  const temporary = `${outputDirectory}.tmp-${process.pid}`;
  await rm(temporary, { force: true, recursive: true });
  await mkdir(path.join(temporary, "cards"), { recursive: true });
  for (let partition = 0; partition < index.partitionCount; partition += 1) {
    const suffix = `${String(partition).padStart(3, "0")}-of-${String(index.partitionCount).padStart(3, "0")}.jsonl`;
    const lines = tasks
      .filter((task) => task.partition === partition)
      .map((task) => canonicalJson(task))
      .join("\n");
    await writeFile(
      path.join(temporary, "cards", `part-${suffix}`),
      lines === "" ? "" : `${lines}\n`,
    );
  }
  await writeFile(
    path.join(temporary, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  await rm(outputDirectory, { force: true, recursive: true });
  await rename(temporary, outputDirectory);
}

export async function exportTrustedManifests(
  database: SupabaseRestClient,
  options: ExportOptions,
): Promise<ExportResult> {
  const [rawGoldenRows, rawCards, rawStorylines, rawCategories, rawThemes] =
    await Promise.all([
      database.select(
        "golden_news_entries",
        "news_entry_id,content_hash_at_review,ordinal,batch_number,review_status,gold_storyline_id,is_syndicated",
        { order: "ordinal.asc" },
      ),
      database.select(
        "golden_event_cards",
        "id,storyline_id,kind,version,headline,summary,timeline,interest_reason,newest_entry_at,generated_at",
        {
          filters: { kind: "eq.overview" },
          order: "storyline_id.asc,version.asc",
        },
      ),
      database.select(
        "golden_storylines",
        "id,entity_set,event_keys,theme_id,category_id",
      ),
      database.select("golden_topic_categories", "id,display_name"),
      database.select("golden_topic_themes", "id,display_name"),
    ]);
  const goldenRows = z.array(GoldenRowSchema).parse(rawGoldenRows);
  const rawEntries = await selectByIds(
    database,
    "news_entries",
    "id,news_source_id,url,title,summary,body_text,published_at,content_hash,entity_set,event_keys",
    goldenRows.map((row) => row.news_entry_id),
  );
  const entries = z.array(NewsEntryRowSchema).parse(rawEntries);
  const sourceIds = entries.map((row) => row.news_source_id);
  const [rawPublishers, rawSources] = await Promise.all([
    selectByIds(
      database,
      "news_source_publishers",
      "news_source_id,publisher_key",
      sourceIds,
      "news_source_id",
    ),
    selectByIds(database, "news_sources", "id,title", sourceIds),
  ]);
  const publishers = z.array(PublisherRowSchema).parse(rawPublishers);
  const sources = z.array(SourceRowSchema).parse(rawSources);
  const publisherBySource = new Map(
    publishers.map((row) => [row.news_source_id, row.publisher_key]),
  );
  const sourceById = new Map(sources.map((row) => [row.id, row]));
  const entryById = new Map(entries.map((row) => [row.id, row]));
  const enrichedRows = goldenRows.map((golden): EnrichedGoldenRow => {
    const entry = entryById.get(golden.news_entry_id);
    if (entry === undefined) {
      throw new Error(`golden entry ${golden.news_entry_id} is missing`);
    }
    const publisherKey = publisherBySource.get(entry.news_source_id);
    if (publisherKey === undefined) {
      throw new Error(
        `entry ${entry.id} is missing curated publisher identity`,
      );
    }
    const sourceTitle = sourceById.get(entry.news_source_id)?.title ?? null;
    return {
      agency: sourceTitle ?? publisherKey,
      bodyText: entry.body_text,
      contentHash: entry.content_hash,
      contentHashAtReview: golden.content_hash_at_review,
      entitySet: entry.entity_set,
      eventKeys: entry.event_keys,
      goldStorylineId: golden.gold_storyline_id,
      isSyndicated: golden.is_syndicated,
      newsEntryId: entry.id,
      newsSourceId: entry.news_source_id,
      publishedAt: entry.published_at,
      publisherKey,
      publisherSummary: entry.summary,
      reviewStatus: golden.review_status,
      sourceTitle,
      title: entry.title,
      url: entry.url,
    };
  });
  const storylines = z.array(StorylineRowSchema).parse(rawStorylines);
  const storylineById = new Map(storylines.map((row) => [row.id, row]));
  const categoryById = new Map(
    z
      .array(TaxonomyRowSchema)
      .parse(rawCategories)
      .map((row) => [row.id, row.display_name]),
  );
  const themeById = new Map(
    z
      .array(TaxonomyRowSchema)
      .parse(rawThemes)
      .map((row) => [row.id, row.display_name]),
  );
  const allTasks = z
    .array(CardRowSchema)
    .parse(rawCards)
    .flatMap((card): OverviewTask[] => {
      const storyline = storylineById.get(card.storyline_id);
      if (storyline === undefined) return [];
      const members = enrichedRows.filter(
        (row) => row.goldStorylineId === card.storyline_id,
      );
      if (!isFullyReviewedAtCutoff(members, card.newest_entry_at)) return [];
      const visible = visibleAtCutoff(members, card.newest_entry_at);
      if (visible.some((row) => !isReviewedHashMatch(row))) return [];
      const category =
        storyline.category_id === null
          ? null
          : (categoryById.get(storyline.category_id) ?? null);
      const theme =
        storyline.theme_id === null
          ? null
          : (themeById.get(storyline.theme_id) ?? null);
      const agencies = sortedUnique(visible.map((row) => row.agency));
      const inputBasis: OverviewInputBasis = {
        card: {
          headline: card.headline,
          interestReason: card.interest_reason,
          newestEntryAt: card.newest_entry_at,
          summary: card.summary,
          timeline: normalizeTimeline(card.timeline),
          version: card.version,
        },
        enrichmentVersion: 1,
        imagePromptInput: {
          agencies,
          category,
          entities: sortedUnique(storyline.entity_set),
          eventKeys: sortedUnique(storyline.event_keys),
          headline: card.headline,
          summary: card.summary,
          theme,
        },
        promptVersion: 1,
        schemaVersion: "overview-enrichment-input.v1",
        sources: visible.map((row) => ({
          agency: row.agency,
          bodyText: row.bodyText,
          contentHash: row.contentHashAtReview,
          entitySet: sortedUnique(row.entitySet),
          eventKeys: sortedUnique(row.eventKeys),
          isSyndicated: row.isSyndicated,
          newsEntryId: row.newsEntryId,
          publishedAt: row.publishedAt ?? "",
          publisherKey: row.publisherKey,
          publisherSummary: row.publisherSummary,
          sourceTitle: row.sourceTitle,
          title: row.title ?? "Untitled government source",
          url: row.url,
        })),
        storyline: {
          category,
          entities: sortedUnique(storyline.entity_set),
          eventKeys: sortedUnique(storyline.event_keys),
          storylineId: storyline.id,
          theme,
        },
      };
      const inputHash = fingerprint(inputBasis);
      return [
        {
          eventCardId: card.id,
          inputBasis,
          inputHash,
          partition: partitionFor(inputHash, options.partitionCount),
          taskKey: `overview/${card.id}/v1`,
        },
      ];
    })
    .sort((left, right) => left.taskKey.localeCompare(right.taskKey));
  const tasks = allTasks.slice(0, options.limit);
  if (options.expectedTasks !== undefined) {
    assertExpectedTasksStillCurrent(allTasks, options.expectedTasks);
  }
  const index: ExportIndex = {
    cardCount: tasks.length,
    exportedAt: new Date().toISOString(),
    partitionCount: options.partitionCount,
    schemaVersion: "golden-enrichment-export.v1",
  };
  if (!options.dryRun) {
    await writeManifest(options.outputDirectory, tasks, index);
  }
  return { ...index, outputDirectory: options.outputDirectory };
}
