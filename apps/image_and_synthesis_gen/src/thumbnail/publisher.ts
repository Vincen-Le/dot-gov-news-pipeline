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

type ImageDatabase = Pick<SupabaseRestClient, "rpc" | "select">;
type ImageStore = Pick<R2ImageStore, "uploadAndVerify">;

export interface ExistingThumbnailRow extends Record<string, unknown> {
  storyline_id: unknown;
  input_hash: unknown;
}

const THUMBNAIL_COLUMNS = [
  "alt_text",
  "card_height",
  "card_mime_type",
  "card_sha256",
  "card_width",
  "enrichment_version",
  "focal_x",
  "focal_y",
  "generated_at",
  "id",
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
  expectedByStoryline: ReadonlyMap<string, PreparedImageArtifact>,
): void {
  for (const row of existingRows) {
    if (
      typeof row.storyline_id !== "string" ||
      typeof row.input_hash !== "string"
    ) {
      throw new Error("golden_storyline_thumbnails returned an invalid row");
    }
    const expected = expectedByStoryline.get(row.storyline_id);
    if (
      expected === undefined ||
      row.input_hash !== expected.record.input_hash
    ) {
      throw new Error(
        `storyline ${row.storyline_id} already has a different immutable thumbnail`,
      );
    }
    for (const [field, expectedValue] of Object.entries(expected.record)) {
      if (
        JSON.stringify(normalized(field, row[field])) !==
        JSON.stringify(normalized(field, expectedValue))
      ) {
        throw new Error(
          `storyline ${row.storyline_id} already has different thumbnail ${field}`,
        );
      }
    }
  }
}

async function selectThumbnailRows(
  database: Pick<SupabaseRestClient, "select">,
  storylineIds: readonly string[],
): Promise<ExistingThumbnailRow[]> {
  if (storylineIds.length === 0) return [];
  const associations = (await database.select(
    "golden_storyline_thumbnails",
    "storyline_id,image_id",
    { filters: { storyline_id: `in.(${storylineIds.join(",")})` } },
  )) as Array<{ image_id: unknown; storyline_id: unknown }>;
  const imageIds = associations.flatMap((row) =>
    typeof row.image_id === "string" ? [row.image_id] : [],
  );
  if (imageIds.length === 0) return [];
  const images = (await database.select("images", THUMBNAIL_COLUMNS, {
    filters: { id: `in.(${imageIds.join(",")})` },
  })) as Array<Record<string, unknown> & { id: unknown }>;
  const imageById = new Map(images.map((row) => [row.id, row]));
  return associations.map((association) => {
    if (
      typeof association.storyline_id !== "string" ||
      typeof association.image_id !== "string"
    ) {
      throw new Error("golden_storyline_thumbnails returned an invalid row");
    }
    const image = imageById.get(association.image_id);
    if (image === undefined || typeof image.input_hash !== "string") {
      throw new Error(
        `storyline ${association.storyline_id} references a missing image`,
      );
    }
    return {
      ...image,
      input_hash: image.input_hash,
      storyline_id: association.storyline_id,
    };
  });
}

function storylineId(artifact: PreparedImageArtifact): string {
  return artifact.validated.task.inputBasis.storyline.storylineId;
}

export async function assertPersistedImageRows(
  database: Pick<SupabaseRestClient, "select">,
  artifacts: readonly PreparedImageArtifact[],
): Promise<void> {
  const expectedByStoryline = new Map(
    artifacts.map((artifact) => [storylineId(artifact), artifact]),
  );
  const rows = await selectThumbnailRows(database, [
    ...expectedByStoryline.keys(),
  ]);
  assertThumbnailRowsMatch(rows, expectedByStoryline);
  const persistedStorylineIds = new Set(rows.map((row) => row.storyline_id));
  for (const id of expectedByStoryline.keys()) {
    if (!persistedStorylineIds.has(id)) {
      throw new Error(
        `golden_storyline_thumbnails is missing storyline ${id} after insert`,
      );
    }
  }
}

export async function assertImageRowsCompatible(
  database: Pick<SupabaseRestClient, "select">,
  artifacts: readonly PreparedImageArtifact[],
): Promise<void> {
  const expectedByStoryline = new Map(
    artifacts.map((artifact) => [storylineId(artifact), artifact]),
  );
  const ids = [...expectedByStoryline.keys()];
  if (ids.length === 0) return;
  const thumbnailRows = await selectThumbnailRows(database, ids);
  assertThumbnailRowsMatch(thumbnailRows, expectedByStoryline);
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
      await options.database.rpc("publish_golden_storyline_thumbnail", {
        p_image: artifact.record,
        p_selection_source: "generated",
        p_storyline_id: storylineId(artifact),
      });
      await assertPersistedImageRows(options.database, [artifact]);
    }
  }
  return {
    cardCount: artifacts.length,
    imageKeys,
    thumbnailRows: options.dryRun ? 0 : artifacts.length,
  };
}
