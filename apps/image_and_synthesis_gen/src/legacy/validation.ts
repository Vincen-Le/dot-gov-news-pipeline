import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp, { type Metadata } from "sharp";

import { fingerprint, sha256 } from "../shared/fingerprint.js";
import { findJsonArtifacts, loadTrustedTasks } from "../shared/manifests.js";
import {
  OverviewEnrichmentSchema,
  type OverviewEnrichment,
  type OverviewTask,
} from "../shared/types.js";

const PROMPT_LEAK_PATTERNS = [
  /as an ai(?: language model)?/iu,
  /developer message/iu,
  /ignore (?:all|any|the|these|previous|prior) instructions/iu,
  /prompt injection/iu,
  /system prompt/iu,
  /you are (?:chatgpt|an ai|a language model)/iu,
];

export interface ValidationOptions {
  artifactInputs: string[];
  limit?: number;
  manifestDirectory: string;
}

export interface ValidatedArtifact {
  artifact: OverviewEnrichment;
  artifactPath: string;
  masterBytes: Buffer;
  masterMetadata: Metadata;
  masterPath: string;
  task: OverviewTask;
}

export function wordCount(value: string): number {
  return value.match(/[\p{L}\p{N}]+(?:[’'–-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function assertWords(
  label: string,
  value: string,
  minimum: number,
  maximum: number,
): void {
  const count = wordCount(value);
  if (count < minimum || count > maximum) {
    throw new Error(
      `${label} must be ${minimum}-${maximum} words (received ${count})`,
    );
  }
}

export function assertNoPromptLeak(label: string, value: string): void {
  const matched = PROMPT_LEAK_PATTERNS.find((pattern) => pattern.test(value));
  if (matched !== undefined) {
    throw new Error(`${label} contains prompt-leak language`);
  }
}

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function validateCitations(
  artifact: OverviewEnrichment,
  task: OverviewTask,
): void {
  const trustedSourceIds = task.inputBasis.sources.map(
    (source) => source.newsEntryId,
  );
  if (!exactSet(artifact.sourceEntryIds, trustedSourceIds)) {
    throw new Error("sourceEntryIds must exactly match trusted card sources");
  }
  const cutoff = Date.parse(task.inputBasis.card.newestEntryAt);
  if (
    task.inputBasis.sources.some(
      (source) => Date.parse(source.publishedAt) > cutoff,
    )
  ) {
    throw new Error(
      "trusted card includes a source after its event-time cutoff",
    );
  }
  const sections = [
    artifact.articleOverview.whatSourcesEstablish,
    ...artifact.articleOverview.keyDetails,
    artifact.articleOverview.whatChangedAcrossUpdates,
    ...(artifact.articleOverview.whatRemainsUnresolved === null
      ? []
      : [artifact.articleOverview.whatRemainsUnresolved]),
  ];
  const allowed = new Set(trustedSourceIds);
  for (const section of sections) {
    if (
      section.sourceEntryIds.length === 0 ||
      section.sourceEntryIds.some((id) => !allowed.has(id))
    ) {
      throw new Error("every overview section must cite trusted source IDs");
    }
    assertNoPromptLeak("overview text", section.text);
  }
}

function validateContentShape(artifact: OverviewEnrichment): void {
  assertWords(
    "whatSourcesEstablish",
    artifact.articleOverview.whatSourcesEstablish.text,
    70,
    110,
  );
  const overviewText = [
    artifact.articleOverview.whatSourcesEstablish.text,
    ...artifact.articleOverview.keyDetails.map((detail) => detail.text),
    artifact.articleOverview.whatChangedAcrossUpdates.text,
    artifact.articleOverview.whatRemainsUnresolved?.text ?? "",
  ].join(" ");
  assertWords("articleOverview", overviewText, 180, 300);
  assertWords("image alt text", artifact.image.altText, 15, 30);
  assertNoPromptLeak("image alt text", artifact.image.altText);
  assertNoPromptLeak("image concept", artifact.image.imageConcept);
}

function mimeTypeForFormat(format: string | undefined): string | null {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

async function validateOne(
  artifactPath: string,
  trustedTasks: ReadonlyMap<string, OverviewTask>,
): Promise<ValidatedArtifact> {
  const artifact = OverviewEnrichmentSchema.parse(
    JSON.parse(await readFile(artifactPath, "utf8")),
  );
  const task = trustedTasks.get(artifact.eventCardId);
  if (task === undefined) {
    throw new Error(`no trusted manifest for card ${artifact.eventCardId}`);
  }
  const calculatedInputHash = fingerprint(task.inputBasis);
  if (
    task.inputHash !== calculatedInputHash ||
    artifact.inputHash !== task.inputHash
  ) {
    throw new Error(`input hash mismatch for card ${artifact.eventCardId}`);
  }
  if (
    artifact.enrichmentVersion !== task.inputBasis.enrichmentVersion ||
    artifact.promptVersion !== task.inputBasis.promptVersion
  ) {
    throw new Error(`version mismatch for card ${artifact.eventCardId}`);
  }
  validateCitations(artifact, task);
  validateContentShape(artifact);
  const masterPath = path.resolve(
    path.dirname(artifactPath),
    artifact.image.masterPath,
  );
  const masterBytes = await readFile(masterPath);
  if (sha256(masterBytes) !== artifact.image.masterSha256) {
    throw new Error(
      `master image hash mismatch for card ${artifact.eventCardId}`,
    );
  }
  const masterMetadata = await sharp(masterBytes).metadata();
  if (
    masterMetadata.width !== artifact.image.width ||
    masterMetadata.height !== artifact.image.height ||
    mimeTypeForFormat(masterMetadata.format) !== artifact.image.mediaType
  ) {
    throw new Error(
      `master image metadata mismatch for card ${artifact.eventCardId}`,
    );
  }
  return {
    artifact,
    artifactPath,
    masterBytes,
    masterMetadata,
    masterPath,
    task,
  };
}

export async function validateArtifacts(
  options: ValidationOptions,
): Promise<ValidatedArtifact[]> {
  const trustedTasks = await loadTrustedTasks(options.manifestDirectory);
  const artifactPaths = (await findJsonArtifacts(options.artifactInputs)).slice(
    0,
    options.limit,
  );
  if (artifactPaths.length === 0) {
    throw new Error("no overview-enrichment.v1 artifacts found");
  }
  const validated: ValidatedArtifact[] = [];
  for (const artifactPath of artifactPaths) {
    validated.push(await validateOne(artifactPath, trustedTasks));
  }
  return validated;
}
