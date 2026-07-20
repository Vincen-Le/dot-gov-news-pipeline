import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { fingerprint, sha256 } from "../src/fingerprint.js";
import {
  type OverviewEnrichment,
  type OverviewInputBasis,
  type OverviewTask,
} from "../src/types.js";
import { validateArtifacts } from "../src/validation.js";

const CARD_ID = "66b2b179-f85b-440a-a804-9c4ec6741a49";
const ENTRY_ID = "08fd7905-1015-4edc-9b3c-2cc16a5c214e";
const STORYLINE_ID = "11ae6748-ab78-428a-966a-2c285ecc08db";
const temporaryDirectories: string[] = [];

function words(count: number, word: string): string {
  return Array.from({ length: count }, () => word).join(" ");
}

function inputBasis(): OverviewInputBasis {
  return {
    card: {
      headline: "Agencies request comments on a shared food definition",
      interestReason: "The definition could shape later research and policy.",
      newestEntryAt: "2025-07-23T04:00:00Z",
      summary: "Agencies opened a joint request for information.",
      timeline: null,
      version: 1,
    },
    enrichmentVersion: 1,
    imagePromptInput: {
      agencies: ["U.S. Department of Agriculture"],
      category: "Food & Drug Safety",
      entities: ["food"],
      eventKeys: [],
      headline: "Agencies request comments on a shared food definition",
      summary: "Agencies opened a joint request for information.",
      theme: null,
    },
    promptVersion: 1,
    schemaVersion: "overview-enrichment-input.v1",
    sources: [
      {
        agency: "U.S. Department of Agriculture",
        bodyText: "Reviewed source content.",
        contentHash: "a".repeat(64),
        entitySet: [],
        eventKeys: [],
        isSyndicated: false,
        newsEntryId: ENTRY_ID,
        publishedAt: "2025-07-23T00:00:00Z",
        publisherKey: "usda",
        publisherSummary: null,
        sourceTitle: "USDA releases",
        title: "Agencies request information",
        url: "https://example.gov/release",
      },
    ],
    storyline: {
      category: "Food & Drug Safety",
      entities: ["food"],
      eventKeys: [],
      storylineId: STORYLINE_ID,
      theme: null,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
  );
});

async function fixture(): Promise<{
  artifact: OverviewEnrichment;
  artifactPath: string;
  manifestDirectory: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "golden-enrichment-"));
  temporaryDirectories.push(root);
  const manifestDirectory = path.join(root, "export");
  const artifactDirectory = path.join(root, "generated");
  await Promise.all([
    mkdir(path.join(manifestDirectory, "cards"), { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ]);
  const basis = inputBasis();
  const inputHash = fingerprint(basis);
  const task: OverviewTask = {
    eventCardId: CARD_ID,
    inputBasis: basis,
    inputHash,
    partition: 0,
    taskKey: `overview/${CARD_ID}/v1`,
  };
  await writeFile(
    path.join(manifestDirectory, "cards", "part-000-of-001.jsonl"),
    `${JSON.stringify(task)}\n`,
  );
  const master = await sharp({
    create: {
      background: "#f4f1e9",
      channels: 3,
      height: 1024,
      width: 1536,
    },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(artifactDirectory, "master.png"), master);
  const artifact: OverviewEnrichment = {
    articleOverview: {
      keyDetails: [
        { sourceEntryIds: [ENTRY_ID], text: words(15, "detail") },
        { sourceEntryIds: [ENTRY_ID], text: words(15, "quantity") },
        { sourceEntryIds: [ENTRY_ID], text: words(15, "deadline") },
      ],
      whatChangedAcrossUpdates: {
        sourceEntryIds: [ENTRY_ID],
        text: words(30, "change"),
      },
      whatRemainsUnresolved: {
        sourceEntryIds: [ENTRY_ID],
        text: words(35, "unresolved"),
      },
      whatSourcesEstablish: {
        sourceEntryIds: [ENTRY_ID],
        text: words(75, "established"),
      },
    },
    enrichmentVersion: 1,
    eventCardId: CARD_ID,
    generatedAt: "2026-07-20T02:03:29Z",
    image: {
      altText: words(15, "illustration"),
      focalPoint: { x: 0.5, y: 0.5 },
      height: 1024,
      imageConcept: "Layered paper forms converge around one shared outline.",
      imageModel: "test-image-model",
      masterPath: "master.png",
      masterSha256: sha256(master),
      mediaType: "image/png",
      promptHash: "c".repeat(64),
      promptVersion: 1,
      width: 1536,
    },
    inputHash,
    model: "test-content-model",
    promptHash: "b".repeat(64),
    promptVersion: 1,
    schemaVersion: "overview-enrichment.v1",
    sourceEntryIds: [ENTRY_ID],
  };
  const artifactPath = path.join(artifactDirectory, "overview.json");
  await writeFile(artifactPath, JSON.stringify(artifact));
  return { artifact, artifactPath, manifestDirectory };
}

describe("artifact validation", () => {
  it("accepts a fully sourced artifact with a verified master image", async () => {
    const value = await fixture();
    const validated = await validateArtifacts({
      artifactInputs: [value.artifactPath],
      manifestDirectory: value.manifestDirectory,
    });
    expect(validated).toHaveLength(1);
    expect(validated[0]?.artifact.eventCardId).toBe(CARD_ID);
  });

  it("rejects citations outside the trusted source set", async () => {
    const value = await fixture();
    value.artifact.articleOverview.keyDetails[0]!.sourceEntryIds = [
      "a269af69-9911-4b94-9450-fd0a1fabb954",
    ];
    await writeFile(value.artifactPath, JSON.stringify(value.artifact));
    await expect(
      validateArtifacts({
        artifactInputs: [value.artifactPath],
        manifestDirectory: value.manifestDirectory,
      }),
    ).rejects.toThrow("trusted source IDs");
  });
});
