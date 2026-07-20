import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { type SupabaseRestClient } from "../shared/database.js";
import { canonicalJson, sha256 } from "../shared/fingerprint.js";
import { prepareImages, type PreparedImage } from "../thumbnail/images.js";
import { R2ImageStore } from "../thumbnail/r2.js";
import {
  generationPrompt,
  reusableImageByKey,
  type ReusableImageDefinition,
} from "./catalog.js";
import { COMPLETED_REUSABLE_IMAGES } from "./completed.js";

const GENERATED_AT = "2026-07-20T00:00:00.000Z";

export interface PreparedReusableImage {
  definition: ReusableImageDefinition;
  images: readonly [PreparedImage, PreparedImage, PreparedImage];
  record: Record<string, unknown>;
  sourcePath: string;
}

type ReusableDatabase = Pick<SupabaseRestClient, "rpc" | "select">;
type ReusableStore = Pick<R2ImageStore, "uploadAndVerify">;

async function pngFiles(input: string): Promise<string[]> {
  const metadata = await stat(input);
  if (metadata.isFile()) return path.extname(input) === ".png" ? [input] : [];
  if (!metadata.isDirectory()) return [];
  const entries = await readdir(input, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      pngFiles(path.join(input, entry.name)).catch(() => []),
    ),
  );
  return nested.flat();
}

export function reusableImageRecord(
  definition: ReusableImageDefinition,
  images: readonly [PreparedImage, PreparedImage, PreparedImage],
): Record<string, unknown> {
  const [master, card, social] = images;
  return {
    alt_text: definition.altText,
    card_height: card.height,
    card_mime_type: card.mediaType,
    card_sha256: card.sha256,
    card_width: card.width,
    enrichment_version: 1,
    focal_x: 0.5,
    focal_y: 0.5,
    generated_at: GENERATED_AT,
    id: definition.imageId,
    image_concept: {
      description: definition.description,
      displayName: definition.displayName,
      key: definition.key,
      scope: definition.scope,
    },
    input_hash: sha256(
      canonicalJson({
        key: definition.key,
        schemaVersion: "reusable-image.v1",
        scope: definition.scope,
      }),
    ),
    master_height: master.height,
    master_mime_type: master.mediaType,
    master_sha256: master.sha256,
    master_width: master.width,
    model: "gpt-image",
    prompt_hash: sha256(generationPrompt(definition)),
    prompt_version: 1,
    r2_card_key: card.key,
    r2_master_key: master.key,
    r2_social_key: social.key,
    social_height: social.height,
    social_mime_type: social.mediaType,
    social_sha256: social.sha256,
    social_width: social.width,
    source_card_version: null,
    source_entry_ids: [],
  };
}

export async function prepareCompletedReusableImages(
  inputs: readonly string[],
): Promise<PreparedReusableImage[]> {
  const paths = (await Promise.all(inputs.map(pngFiles))).flat();
  const pathsByName = new Map<string, string[]>();
  for (const sourcePath of paths) {
    const name = path.basename(sourcePath);
    pathsByName.set(name, [...(pathsByName.get(name) ?? []), sourcePath]);
  }

  const output: PreparedReusableImage[] = [];
  for (const completed of COMPLETED_REUSABLE_IMAGES) {
    const matches = pathsByName.get(completed.generatedFileName) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one ${completed.generatedFileName}, found ${matches.length}`,
      );
    }
    const definition = reusableImageByKey(completed.key);
    if (definition === undefined) {
      throw new Error(`reusable image catalog is missing ${completed.key}`);
    }
    const master = await readFile(matches[0]!);
    const metadata = await sharp(master).metadata();
    if (
      metadata.format !== "png" ||
      metadata.width !== 1536 ||
      metadata.height !== 1024
    ) {
      throw new Error(
        `${completed.generatedFileName} must be a 1536x1024 PNG`,
      );
    }
    const images = await prepareImages({
      focalX: 0.5,
      focalY: 0.5,
      master,
      masterHeight: 1024,
      masterMediaType: "image/png",
      masterSha256: sha256(master),
      masterWidth: 1536,
    });
    output.push({
      definition,
      images,
      record: reusableImageRecord(definition, images),
      sourcePath: matches[0]!,
    });
  }
  return output;
}

export async function publishReusableImages(
  prepared: readonly PreparedReusableImage[],
  options: {
    database: ReusableDatabase;
    dryRun: boolean;
    imageStore?: ReusableStore;
  },
): Promise<{ imageKeys: string[]; published: number }> {
  if (!options.dryRun) {
    const imageStore = options.imageStore ?? new R2ImageStore();
    for (const artifact of prepared) {
      await Promise.all(
        artifact.images.map((image) => imageStore.uploadAndVerify(image)),
      );
      await options.database.rpc("publish_reusable_image", {
        p_display_name: artifact.definition.displayName,
        p_image: artifact.record,
        p_scope: artifact.definition.scope,
        p_scope_key: artifact.definition.key,
      });
    }
    const persisted = (await options.database.select(
      "images",
      "id,master_sha256,card_sha256,social_sha256",
      {
        filters: {
          id: `in.(${prepared.map(({ definition }) => definition.imageId).join(",")})`,
        },
      },
    )) as Array<Record<string, unknown>>;
    if (persisted.length !== prepared.length) {
      throw new Error(
        `expected ${prepared.length} persisted reusable images, found ${persisted.length}`,
      );
    }
    const persistedById = new Map(persisted.map((row) => [row.id, row]));
    for (const artifact of prepared) {
      const row = persistedById.get(artifact.definition.imageId);
      for (const field of [
        "master_sha256",
        "card_sha256",
        "social_sha256",
      ]) {
        if (row?.[field] !== artifact.record[field]) {
          throw new Error(
            `persisted reusable image ${artifact.definition.key} has different ${field}`,
          );
        }
      }
    }
  }
  return {
    imageKeys: prepared.flatMap(({ images }) =>
      images.map((image) => image.key),
    ),
    published: options.dryRun ? 0 : prepared.length,
  };
}
