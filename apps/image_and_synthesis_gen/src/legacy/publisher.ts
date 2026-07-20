import { type SupabaseRestClient } from "../shared/database.js";
import { prepareImages, type PreparedImage } from "../thumbnail/images.js";
import { R2ImageStore } from "../thumbnail/r2.js";
import { type ValidatedArtifact } from "./validation.js";

export interface PublishOptions {
  database: SupabaseRestClient;
  dryRun: boolean;
  imageStore?: R2ImageStore;
}

export interface PublishResult {
  cardCount: number;
  imageKeys: string[];
  overviewRows: number;
  thumbnailRows: number;
}

interface ImmutableRowIdentity {
  event_card_id: unknown;
  input_hash: unknown;
}

export function assertImmutableInputHashes(
  table: string,
  existingRows: readonly ImmutableRowIdentity[],
  expectedByCard: ReadonlyMap<string, string>,
): void {
  for (const row of existingRows) {
    if (
      typeof row.event_card_id !== "string" ||
      typeof row.input_hash !== "string"
    ) {
      throw new Error(`${table} returned an invalid immutable identity row`);
    }
    const expectedHash = expectedByCard.get(row.event_card_id);
    if (expectedHash === undefined || expectedHash !== row.input_hash) {
      throw new Error(
        `${table} already contains a different input hash for card ${row.event_card_id}`,
      );
    }
  }
}

export async function assertImmutableRowsCompatible(
  database: SupabaseRestClient,
  artifacts: readonly ValidatedArtifact[],
): Promise<void> {
  const expectedByCard = new Map(
    artifacts.map(({ artifact }) => [artifact.eventCardId, artifact.inputHash]),
  );
  const cardIds = [...expectedByCard.keys()];
  if (cardIds.length === 0) return;
  const filters = { event_card_id: `in.(${cardIds.join(",")})` };
  const tables = ["golden_event_card_article_overviews"];
  for (const table of tables) {
    const existingRows = (await database.select(
      table,
      "event_card_id,input_hash",
      { filters },
    )) as ImmutableRowIdentity[];
    assertImmutableInputHashes(table, existingRows, expectedByCard);
  }
}

export function overviewRecord(
  validated: ValidatedArtifact,
): Record<string, unknown> {
  const { artifact, task } = validated;
  return {
    article_overview: artifact.articleOverview,
    enrichment_version: artifact.enrichmentVersion,
    generated_at: artifact.generatedAt,
    input_hash: artifact.inputHash,
    model: artifact.model,
    prompt_hash: artifact.promptHash,
    prompt_version: artifact.promptVersion,
    source_card_version: task.inputBasis.card.version,
    source_content_hashes: task.inputBasis.sources.map(
      (source) => source.contentHash,
    ),
    source_entry_ids: task.inputBasis.sources.map(
      (source) => source.newsEntryId,
    ),
  };
}

export function thumbnailRecord(
  validated: ValidatedArtifact,
  images: readonly [PreparedImage, PreparedImage, PreparedImage],
): Record<string, unknown> {
  const { artifact, task } = validated;
  const [master, card, social] = images;
  return {
    alt_text: artifact.image.altText,
    card_height: card.height,
    card_mime_type: card.mediaType,
    card_sha256: card.sha256,
    card_width: card.width,
    enrichment_version: artifact.enrichmentVersion,
    event_card_id: artifact.eventCardId,
    focal_x: artifact.image.focalPoint.x,
    focal_y: artifact.image.focalPoint.y,
    generated_at: artifact.generatedAt,
    image_concept: { description: artifact.image.imageConcept },
    input_hash: artifact.inputHash,
    master_height: master.height,
    master_mime_type: master.mediaType,
    master_sha256: master.sha256,
    master_width: master.width,
    model: artifact.image.imageModel,
    prompt_hash: artifact.image.promptHash,
    prompt_version: artifact.image.promptVersion,
    r2_card_key: card.key,
    r2_master_key: master.key,
    r2_social_key: social.key,
    social_height: social.height,
    social_mime_type: social.mediaType,
    social_sha256: social.sha256,
    social_width: social.width,
    source_card_version: task.inputBasis.card.version,
    source_entry_ids: artifact.sourceEntryIds,
  };
}

export async function publishArtifacts(
  artifacts: readonly ValidatedArtifact[],
  options: PublishOptions,
): Promise<PublishResult> {
  const imageKeys: string[] = [];
  let overviewRows = 0;
  let thumbnailRows = 0;
  for (const validated of artifacts) {
    const { artifact } = validated;
    const images = await prepareImages({
      focalX: artifact.image.focalPoint.x,
      focalY: artifact.image.focalPoint.y,
      master: validated.masterBytes,
      masterHeight: artifact.image.height,
      masterMediaType: artifact.image.mediaType,
      masterSha256: artifact.image.masterSha256,
      masterWidth: artifact.image.width,
    });
    imageKeys.push(...images.map((image) => image.key));
    if (options.dryRun) continue;

    // The content lane is intentionally independent from image processing and
    // publication. A later thumbnail failure never rolls back valid synthesis.
    await options.database.insertImmutable(
      "golden_event_card_article_overviews",
      [overviewRecord(validated)],
    );
    overviewRows += 1;

    const imageStore = options.imageStore ?? new R2ImageStore();
    await Promise.all(
      images.map(async (image) => imageStore.uploadAndVerify(image)),
    );
    await options.database.rpc("publish_golden_storyline_thumbnail", {
      p_image: thumbnailRecord(validated, images),
      p_selection_source: "generated",
      p_storyline_id: validated.task.inputBasis.storyline.storylineId,
    });
    thumbnailRows += 1;
  }
  return {
    cardCount: artifacts.length,
    imageKeys,
    overviewRows,
    thumbnailRows,
  };
}
