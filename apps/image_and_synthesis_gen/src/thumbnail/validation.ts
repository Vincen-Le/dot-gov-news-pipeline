import { opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import sharp, { type Metadata } from "sharp";
import { z } from "zod";

import { assertNoPromptLeak, assertWords } from "../legacy/validation.js";
import { fingerprint, sha256 } from "../shared/fingerprint.js";
import { loadTrustedTasks } from "../shared/manifests.js";
import {
  SHA256_PATTERN,
  UUID_PATTERN,
  type OverviewTask,
} from "../shared/types.js";

const NonBlankString = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() !== "", "must not be blank");

export const ImageGenerationSchema = z
  .object({
    altText: NonBlankString(512),
    contrastMode: NonBlankString(128).optional(),
    eventCardId: z.string().regex(UUID_PATTERN),
    focalPoint: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      })
      .strict(),
    generatedAt: z.iso.datetime({ offset: true }),
    imageConcept: NonBlankString(2048),
    imageModel: NonBlankString(256),
    inputHash: z.string().regex(SHA256_PATTERN),
    masterPath: NonBlankString(1024).optional(),
    prompt: NonBlankString(32_768),
  })
  .strict();

export type ImageGeneration = z.infer<typeof ImageGenerationSchema>;

export interface ImageValidationOptions {
  artifactInputs: string[];
  limit?: number;
  manifestDirectory: string;
}

export interface ValidatedImageArtifact {
  artifact: ImageGeneration;
  artifactPath: string;
  masterBytes: Buffer;
  masterMetadata: Metadata;
  masterPath: string;
  masterSha256: string;
  promptHash: string;
  task: OverviewTask;
}

async function* filesBelow(directory: string): AsyncGenerator<string> {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* filesBelow(filePath);
    else if (entry.isFile() && entry.name === "image-generation.json") {
      yield filePath;
    }
  }
}

/**
 * Directory discovery deliberately accepts only the canonical metadata name.
 * An alternate JSON filename is considered only when the caller passes that
 * exact file, which keeps proof variants out of bulk publication.
 */
export async function findImageGenerationArtifacts(
  inputs: readonly string[],
): Promise<string[]> {
  const artifacts: string[] = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    const inputStat = await stat(resolved);
    if (inputStat.isFile()) {
      if (!resolved.endsWith(".json")) {
        throw new Error(
          `image artifact input must be a JSON file: ${resolved}`,
        );
      }
      artifacts.push(resolved);
      continue;
    }
    if (!inputStat.isDirectory()) {
      throw new Error(
        `image artifact input is not a file or directory: ${resolved}`,
      );
    }
    for await (const filePath of filesBelow(resolved)) artifacts.push(filePath);
  }
  return [...new Set(artifacts)].sort((left, right) =>
    left.localeCompare(right),
  );
}

async function resolveMasterPath(
  artifactPath: string,
  configuredPath: string | undefined,
): Promise<string> {
  const bundleDirectory = path.dirname(artifactPath);
  const masterPath = path.resolve(
    bundleDirectory,
    configuredPath ?? "storyline-master.png",
  );
  const relative = path.relative(bundleDirectory, masterPath);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "masterPath must resolve to a file within its image bundle",
    );
  }
  const [realBundleDirectory, realMasterPath] = await Promise.all([
    realpath(bundleDirectory),
    realpath(masterPath),
  ]);
  const realRelative = path.relative(realBundleDirectory, realMasterPath);
  if (
    realRelative === "" ||
    realRelative.startsWith(`..${path.sep}`) ||
    realRelative === ".." ||
    path.isAbsolute(realRelative)
  ) {
    throw new Error(
      "masterPath must resolve to a file within its image bundle",
    );
  }
  return realMasterPath;
}

async function validateOne(
  artifactPath: string,
  trustedTasks: ReadonlyMap<string, OverviewTask>,
): Promise<ValidatedImageArtifact> {
  const artifact = ImageGenerationSchema.parse(
    JSON.parse(await readFile(artifactPath, "utf8")),
  );
  const bundleCardId = path.basename(path.dirname(artifactPath));
  if (bundleCardId !== artifact.eventCardId) {
    throw new Error(
      `image bundle directory does not match card ${artifact.eventCardId}`,
    );
  }
  const task = trustedTasks.get(artifact.eventCardId);
  if (task === undefined) {
    throw new Error(`no trusted manifest for card ${artifact.eventCardId}`);
  }
  if (
    task.inputHash !== fingerprint(task.inputBasis) ||
    artifact.inputHash !== task.inputHash
  ) {
    throw new Error(`input hash mismatch for card ${artifact.eventCardId}`);
  }
  assertWords("image alt text", artifact.altText, 15, 30);
  assertNoPromptLeak("image alt text", artifact.altText);
  assertNoPromptLeak("image concept", artifact.imageConcept);
  assertNoPromptLeak("image prompt", artifact.prompt);

  const masterPath = await resolveMasterPath(artifactPath, artifact.masterPath);
  const masterBytes = await readFile(masterPath);
  const masterMetadata = await sharp(masterBytes).metadata();
  if (
    masterMetadata.format !== "png" ||
    masterMetadata.width !== 1536 ||
    masterMetadata.height !== 1024
  ) {
    throw new Error(
      `master image must be a 1536x1024 PNG for card ${artifact.eventCardId}`,
    );
  }
  return {
    artifact,
    artifactPath,
    masterBytes,
    masterMetadata,
    masterPath,
    masterSha256: sha256(masterBytes),
    promptHash: sha256(artifact.prompt),
    task,
  };
}

export async function validateImageArtifacts(
  options: ImageValidationOptions,
): Promise<ValidatedImageArtifact[]> {
  const trustedTasks = await loadTrustedTasks(options.manifestDirectory);
  const artifactPaths = (
    await findImageGenerationArtifacts(options.artifactInputs)
  ).slice(0, options.limit);
  if (artifactPaths.length === 0) {
    throw new Error("no image-generation.json artifacts found");
  }
  const validated: ValidatedImageArtifact[] = [];
  const cardIds = new Set<string>();
  for (const artifactPath of artifactPaths) {
    const artifact = await validateOne(artifactPath, trustedTasks);
    if (cardIds.has(artifact.artifact.eventCardId)) {
      throw new Error(
        `multiple image artifacts selected for card ${artifact.artifact.eventCardId}`,
      );
    }
    cardIds.add(artifact.artifact.eventCardId);
    validated.push(artifact);
  }
  return validated;
}
