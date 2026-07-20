import { assertImmutableInputHashes } from "../legacy/publisher.js";
import { type SupabaseRestClient } from "../shared/database.js";
import { prepareImages, type PreparedImage } from "./images.js";
import { R2ImageStore } from "./r2.js";
import { type ValidatedImageArtifact } from "./validation.js";

export interface PreparedImageArtifact {
  images: readonly [PreparedImage, PreparedImage, PreparedImage];
  record: Record<string, unknown>;
  validated: ValidatedImageArtifact;
}

export interface ImagePublishResult {
  cardCount: number;
  imageKeys: string[];
  thumbnailRows: number;
}

type ImageDatabase = Pick<SupabaseRestClient, "insertImmutable" | "select">;
type ImageStore = Pick<R2ImageStore, "uploadAndVerify">;

export interface ExistingThumbnailRow extends Record<string, unknown> {
  event_card_id: unknown;
  input_hash: unknown;
}

const THUMBNAIL_COLUMNS = [
  "alt_text",
  "card_height",
  "card_mime_type",
  "card_sha256",
  "card_width",
  "enrichment_version",
  "event_card_id",
  "focal_x",
  "focal_y",
  "generated_at",
  "image_concept",
  "input_hash",
  "master_height",
  "master_mime_type",
  "master_sha256",
  "master_width",
  "model",
  "prompt_hash",
  "prompt_version",
  "r2_card_key",
  "r2_master_key",
  "r2_social_key",
  "social_height",
  "social_mime_type",
  "social_sha256",
  "social_width",
  "source_card_version",
  "source_entry_ids",
].join(",");

export function imageThumbnailRecord(
  validated: ValidatedImageArtifact,
  images: readonly [PreparedImage, PreparedImage, PreparedImage],
): Record<string, unknown> {
  const { artifact, task } = validated;
  const [master, card, social] = images;
  return {
    alt_text: artifact.altText,
    card_height: card.height,
    card_mime_type: card.mediaType,
    card_sha256: card.sha256,
    card_width: card.width,
    enrichment_version: task.inputBasis.enrichmentVersion,
    event_card_id: artifact.eventCardId,
    focal_x: artifact.focalPoint.x,
    focal_y: artifact.focalPoint.y,
    generated_at: artifact.generatedAt,
    image_concept: { description: artifact.imageConcept },
    input_hash: artifact.inputHash,
    master_height: master.height,
    master_mime_type: master.mediaType,
    master_sha256: master.sha256,
    master_width: master.width,
    model: artifact.imageModel,
    prompt_hash: validated.promptHash,
    prompt_version: task.inputBasis.promptVersion,
    r2_card_key: card.key,
    r2_master_key: master.key,
    r2_social_key: social.key,
    social_height: social.height,
    social_mime_type: social.mediaType,
    social_sha256: social.sha256,
    social_width: social.width,
    source_card_version: task.inputBasis.card.version,
    source_entry_ids: task.inputBasis.sources.map(
      (source) => source.newsEntryId,
    ),
  };
}

export async function prepareImageArtifacts(
  artifacts: readonly ValidatedImageArtifact[],
): Promise<PreparedImageArtifact[]> {
  const prepared: PreparedImageArtifact[] = [];
  for (const validated of artifacts) {
    const images = await prepareImages({
      focalX: validated.artifact.focalPoint.x,
      focalY: validated.artifact.focalPoint.y,
      master: validated.masterBytes,
      masterHeight: 1024,
      masterMediaType: "image/png",
      masterSha256: validated.masterSha256,
      masterWidth: 1536,
    });
    prepared.push({
      images,
      record: imageThumbnailRecord(validated, images),
      validated,
    });
  }
  return prepared;
}

function normalized(field: string, value: unknown): unknown {
  if (field === "generated_at" && typeof value === "string") {
    const milliseconds = Date.parse(value);
    return Number.isNaN(milliseconds)
      ? value
      : new Date(milliseconds).toISOString();
  }
  if (field === "focal_x" || field === "focal_y") return Number(value);
  if (Array.isArray(value)) return value.map((item) => normalized("", item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalized(key, item)]),
    );
  }
  return value;
}

export function assertThumbnailRowsMatch(
  existingRows: readonly ExistingThumbnailRow[],
  expectedByCard: ReadonlyMap<string, PreparedImageArtifact>,
): void {
  for (const row of existingRows) {
    if (
      typeof row.event_card_id !== "string" ||
      typeof row.input_hash !== "string"
    ) {
      throw new Error("golden_event_card_thumbnails returned an invalid row");
    }
    const expected = expectedByCard.get(row.event_card_id);
    if (
      expected === undefined ||
      row.input_hash !== expected.record.input_hash
    ) {
      throw new Error(
        `golden_event_card_thumbnails already contains a different input hash for card ${row.event_card_id}`,
      );
    }
    for (const [field, expectedValue] of Object.entries(expected.record)) {
      if (
        JSON.stringify(normalized(field, row[field])) !==
        JSON.stringify(normalized(field, expectedValue))
      ) {
        throw new Error(
          `golden_event_card_thumbnails already contains different ${field} for card ${row.event_card_id}`,
        );
      }
    }
  }
}

async function selectThumbnailRows(
  database: Pick<SupabaseRestClient, "select">,
  cardIds: readonly string[],
): Promise<ExistingThumbnailRow[]> {
  if (cardIds.length === 0) return [];
  return (await database.select(
    "golden_event_card_thumbnails",
    THUMBNAIL_COLUMNS,
    { filters: { event_card_id: `in.(${cardIds.join(",")})` } },
  )) as ExistingThumbnailRow[];
}

export async function assertPersistedImageRows(
  database: Pick<SupabaseRestClient, "select">,
  artifacts: readonly PreparedImageArtifact[],
): Promise<void> {
  const expectedByCard = new Map(
    artifacts.map((artifact) => [
      artifact.validated.artifact.eventCardId,
      artifact,
    ]),
  );
  const rows = await selectThumbnailRows(database, [...expectedByCard.keys()]);
  assertThumbnailRowsMatch(rows, expectedByCard);
  const persistedCardIds = new Set(rows.map((row) => row.event_card_id));
  for (const cardId of expectedByCard.keys()) {
    if (!persistedCardIds.has(cardId)) {
      throw new Error(
        `golden_event_card_thumbnails is missing card ${cardId} after insert`,
      );
    }
  }
}

export async function assertImageRowsCompatible(
  database: Pick<SupabaseRestClient, "select">,
  artifacts: readonly PreparedImageArtifact[],
): Promise<void> {
  const expectedByCard = new Map(
    artifacts.map((artifact) => [
      artifact.validated.artifact.eventCardId,
      artifact,
    ]),
  );
  const cardIds = [...expectedByCard.keys()];
  if (cardIds.length === 0) return;
  const filters = { event_card_id: `in.(${cardIds.join(",")})` };
  const overviewRows = (await database.select(
    "golden_event_card_article_overviews",
    "event_card_id,input_hash",
    { filters },
  )) as Array<{ event_card_id: unknown; input_hash: unknown }>;
  assertImmutableInputHashes(
    "golden_event_card_article_overviews",
    overviewRows,
    new Map(
      artifacts.map(({ validated }) => [
        validated.artifact.eventCardId,
        validated.artifact.inputHash,
      ]),
    ),
  );
  const thumbnailRows = await selectThumbnailRows(database, cardIds);
  assertThumbnailRowsMatch(thumbnailRows, expectedByCard);
}

export async function publishImageArtifacts(
  artifacts: readonly PreparedImageArtifact[],
  options: {
    database: ImageDatabase;
    dryRun: boolean;
    imageStore?: ImageStore;
  },
): Promise<ImagePublishResult> {
  const imageKeys = artifacts.flatMap(({ images }) =>
    images.map((image) => image.key),
  );
  if (!options.dryRun) {
    const imageStore = options.imageStore ?? new R2ImageStore();
    for (const artifact of artifacts) {
      await Promise.all(
        artifact.images.map(async (image) => imageStore.uploadAndVerify(image)),
      );
      await options.database.insertImmutable("golden_event_card_thumbnails", [
        artifact.record,
      ]);
      await assertPersistedImageRows(options.database, [artifact]);
    }
  }
  return {
    cardCount: artifacts.length,
    imageKeys,
    thumbnailRows: options.dryRun ? 0 : artifacts.length,
  };
}
