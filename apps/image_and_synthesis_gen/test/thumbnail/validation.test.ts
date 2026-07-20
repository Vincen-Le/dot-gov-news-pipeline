import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { fingerprint, sha256 } from "../../src/shared/fingerprint.js";
import {
  findImageGenerationArtifacts,
  type ImageGeneration,
  validateImageArtifacts,
} from "../../src/thumbnail/validation.js";
import {
  type OverviewInputBasis,
  type OverviewTask,
} from "../../src/shared/types.js";

const CARD_ID = "66b2b179-f85b-440a-a804-9c4ec6741a49";
const SECOND_CARD_ID = "49f0ca47-ce98-4dad-aa7d-686c19143b91";
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
  artifact: ImageGeneration;
  artifactDirectory: string;
  artifactPath: string;
  manifestDirectory: string;
  master: Buffer;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "golden-images-"));
  temporaryDirectories.push(root);
  const manifestDirectory = path.join(root, "export");
  const artifactDirectory = path.join(root, "generated", CARD_ID);
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
  await writeFile(path.join(artifactDirectory, "storyline-master.png"), master);
  const artifact: ImageGeneration = {
    altText: words(15, "illustration"),
    contrastMode: "warm-paper collage",
    eventCardId: CARD_ID,
    focalPoint: { x: 0.5, y: 0.5 },
    generatedAt: "2026-07-20T02:03:29Z",
    imageConcept: "Layered paper forms converge around one shared outline.",
    imageModel: "test-image-model",
    inputHash,
    prompt:
      "Create one crop-safe civic editorial collage from the trusted image brief.",
  };
  const artifactPath = path.join(artifactDirectory, "image-generation.json");
  await writeFile(artifactPath, JSON.stringify(artifact));
  return {
    artifact,
    artifactDirectory,
    artifactPath,
    manifestDirectory,
    master,
  };
}

describe("image artifact validation", () => {
  it("accepts a canonical bundle and derives exact provenance hashes", async () => {
    const value = await fixture();
    const [validated] = await validateImageArtifacts({
      artifactInputs: [value.artifactDirectory],
      manifestDirectory: value.manifestDirectory,
    });
    expect(validated?.artifact.eventCardId).toBe(CARD_ID);
    expect(validated?.masterSha256).toBe(sha256(value.master));
    expect(validated?.promptHash).toBe(sha256(value.artifact.prompt));
  });

  it("accepts legacy metadata without a contrastMode", async () => {
    const value = await fixture();
    const legacyArtifact = { ...value.artifact };
    delete legacyArtifact.contrastMode;
    await writeFile(value.artifactPath, JSON.stringify(legacyArtifact));
    await expect(
      validateImageArtifacts({
        artifactInputs: [value.artifactPath],
        manifestDirectory: value.manifestDirectory,
      }),
    ).resolves.toHaveLength(1);
  });

  it("rejects multiple generated images for one storyline", async () => {
    const value = await fixture();
    const secondDirectory = path.join(
      path.dirname(value.artifactDirectory),
      SECOND_CARD_ID,
    );
    await mkdir(secondDirectory, { recursive: true });
    await writeFile(
      path.join(secondDirectory, "storyline-master.png"),
      value.master,
    );
    const secondBasis = inputBasis();
    secondBasis.card = { ...secondBasis.card, version: 2 };
    const secondHash = fingerprint(secondBasis);
    const firstTask: OverviewTask = {
      eventCardId: CARD_ID,
      inputBasis: inputBasis(),
      inputHash: fingerprint(inputBasis()),
      partition: 0,
      taskKey: `overview/${CARD_ID}/v1`,
    };
    const secondTask: OverviewTask = {
      eventCardId: SECOND_CARD_ID,
      inputBasis: secondBasis,
      inputHash: secondHash,
      partition: 0,
      taskKey: `overview/${SECOND_CARD_ID}/v1`,
    };
    await writeFile(
      path.join(value.manifestDirectory, "cards", "part-000-of-001.jsonl"),
      `${JSON.stringify(firstTask)}\n${JSON.stringify(secondTask)}\n`,
    );
    await writeFile(
      path.join(secondDirectory, "image-generation.json"),
      JSON.stringify({
        ...value.artifact,
        eventCardId: SECOND_CARD_ID,
        inputHash: secondHash,
      }),
    );

    await expect(
      validateImageArtifacts({
        artifactInputs: [path.dirname(value.artifactDirectory)],
        manifestDirectory: value.manifestDirectory,
      }),
    ).rejects.toThrow(`multiple image artifacts selected for storyline`);
  });

  it("ignores alternate metadata during directory discovery", async () => {
    const value = await fixture();
    const alternate = path.join(
      value.artifactDirectory,
      "image-generation-proof.json",
    );
    await writeFile(alternate, JSON.stringify(value.artifact));
    await expect(
      findImageGenerationArtifacts([value.artifactDirectory]),
    ).resolves.toEqual([value.artifactPath]);
  });

  it("honors an explicitly passed alternate metadata file and masterPath", async () => {
    const value = await fixture();
    const alternateMaster = path.join(
      value.artifactDirectory,
      "storyline-master-v2.png",
    );
    const alternateArtifact = path.join(
      value.artifactDirectory,
      "image-generation-v2.json",
    );
    await writeFile(alternateMaster, value.master);
    await writeFile(
      alternateArtifact,
      JSON.stringify({
        ...value.artifact,
        masterPath: "storyline-master-v2.png",
      }),
    );
    const [validated] = await validateImageArtifacts({
      artifactInputs: [alternateArtifact],
      manifestDirectory: value.manifestDirectory,
    });
    expect(path.basename(validated!.masterPath)).toBe(
      path.basename(alternateMaster),
    );
  });

  it("rejects a masterPath that escapes the card bundle", async () => {
    const value = await fixture();
    await writeFile(
      value.artifactPath,
      JSON.stringify({ ...value.artifact, masterPath: "../outside.png" }),
    );
    await expect(
      validateImageArtifacts({
        artifactInputs: [value.artifactPath],
        manifestDirectory: value.manifestDirectory,
      }),
    ).rejects.toThrow("within its image bundle");
  });

  it("rejects a stale input hash", async () => {
    const value = await fixture();
    await writeFile(
      value.artifactPath,
      JSON.stringify({ ...value.artifact, inputHash: "f".repeat(64) }),
    );
    await expect(
      validateImageArtifacts({
        artifactInputs: [value.artifactPath],
        manifestDirectory: value.manifestDirectory,
      }),
    ).rejects.toThrow("input hash mismatch");
  });

  it("rejects a master with noncanonical dimensions", async () => {
    const value = await fixture();
    const wrongSize = await sharp({
      create: {
        background: "#f4f1e9",
        channels: 3,
        height: 768,
        width: 1024,
      },
    })
      .png()
      .toBuffer();
    await writeFile(
      path.join(value.artifactDirectory, "storyline-master.png"),
      wrongSize,
    );
    await expect(
      validateImageArtifacts({
        artifactInputs: [value.artifactPath],
        manifestDirectory: value.manifestDirectory,
      }),
    ).rejects.toThrow("1536x1024 PNG");
  });

  it.each(["imageModel", "prompt"] as const)(
    "rejects a blank %s",
    async (field) => {
      const value = await fixture();
      await writeFile(
        value.artifactPath,
        JSON.stringify({ ...value.artifact, [field]: "   " }),
      );
      await expect(
        validateImageArtifacts({
          artifactInputs: [value.artifactPath],
          manifestDirectory: value.manifestDirectory,
        }),
      ).rejects.toThrow();
    },
  );
});
