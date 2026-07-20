import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateArticleOverviewV2Artifacts } from "../../src/article_synthesis/validation.js";
import { fingerprint, sha256 } from "../../src/shared/fingerprint.js";
import {
  type ArticleOverviewEnrichmentV2,
  type OverviewInputBasis,
  type OverviewTask,
} from "../../src/shared/types.js";

const CARD_ID = "66b2b179-f85b-440a-a804-9c4ec6741a49";
const ENTRY_A = "08fd7905-1015-4edc-9b3c-2cc16a5c214e";
const ENTRY_B = "a269af69-9911-4b94-9450-fd0a1fabb954";
const STORYLINE_ID = "11ae6748-ab78-428a-966a-2c285ecc08db";
const temporaryDirectories: string[] = [];

function sentence(count: number, word: string): string {
  return `${Array.from({ length: count }, () => word).join(" ")}.`;
}

function basis(): OverviewInputBasis {
  return {
    card: {
      headline: "Agencies request comments on a shared food definition",
      interestReason: "The definition could shape research and food policy.",
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
        bodyText: "The agencies requested public comments.",
        contentHash: "a".repeat(64),
        entitySet: [],
        eventKeys: [],
        isSyndicated: false,
        newsEntryId: ENTRY_A,
        publishedAt: "2025-07-22T18:00:00Z",
        publisherKey: "usda",
        publisherSummary: null,
        sourceTitle: "USDA release",
        title: "Agencies request information",
        url: "https://example.gov/release-a",
      },
      {
        agency: "U.S. Food and Drug Administration",
        bodyText: "The request describes the questions under review.",
        contentHash: "b".repeat(64),
        entitySet: [],
        eventKeys: [],
        isSyndicated: false,
        newsEntryId: ENTRY_B,
        publishedAt: "2025-07-23T01:00:00Z",
        publisherKey: "fda",
        publisherSummary: null,
        sourceTitle: "FDA release",
        title: "Federal agencies seek public input",
        url: "https://example.gov/release-b",
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
  artifact: ArticleOverviewEnrichmentV2;
  artifactPath: string;
  manifestDirectory: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "overview-v2-"));
  temporaryDirectories.push(root);
  const manifestDirectory = path.join(root, "export");
  const artifactDirectory = path.join(root, "generated");
  await Promise.all([
    mkdir(path.join(manifestDirectory, "cards"), { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ]);
  const inputBasis = basis();
  const inputHash = fingerprint(inputBasis);
  const task: OverviewTask = {
    eventCardId: CARD_ID,
    inputBasis,
    inputHash,
    partition: 0,
    taskKey: `overview/${CARD_ID}/v1`,
  };
  await writeFile(
    path.join(manifestDirectory, "cards", "part-000-of-001.jsonl"),
    `${JSON.stringify(task)}\n`,
  );
  const artifact: ArticleOverviewEnrichmentV2 = {
    articleOverview: {
      keyPoints: [
        {
          sourceEntryIds: [ENTRY_A],
          text: sentence(20, "participation"),
        },
        {
          sourceEntryIds: [ENTRY_B],
          text: sentence(20, "impact"),
        },
      ],
      summary: {
        sourceEntryIds: [ENTRY_A, ENTRY_B],
        text: sentence(35, "context"),
      },
    },
    enrichmentVersion: 2,
    eventCardId: CARD_ID,
    generatedAt: "2026-07-20T02:03:29Z",
    inputHash,
    model: "test-content-model",
    promptHash: sha256(
      await readFile(
        new URL(
          "../../docs/article_synthesis/article-overview-v2.md",
          import.meta.url,
        ),
      ),
    ),
    promptVersion: 2,
    schemaVersion: "article-overview.v2",
    sourceCutoffAt: inputBasis.card.newestEntryAt,
    sourceEntryIds: [ENTRY_A, ENTRY_B],
  };
  const artifactPath = path.join(artifactDirectory, "article-overview.v2.json");
  await writeFile(artifactPath, JSON.stringify(artifact));
  return { artifact, artifactPath, manifestDirectory };
}

describe("article overview v2 validation", () => {
  it("accepts a structured overview covering the historical source set", async () => {
    const value = await fixture();
    const validated = await validateArticleOverviewV2Artifacts({
      artifactInputs: [value.artifactPath],
      manifestDirectory: value.manifestDirectory,
    });
    expect(validated).toHaveLength(1);
    expect(validated[0]?.artifact.articleOverview.keyPoints).toHaveLength(2);
  });

  it("rejects a key point longer than two sentences", async () => {
    const value = await fixture();
    value.artifact.articleOverview.keyPoints[0]!.text =
      "One useful public impact is clear. Another practical consequence remains easy to understand. A third distinct sentence is here.";
    await writeFile(value.artifactPath, JSON.stringify(value.artifact));
    await expect(
      validateArticleOverviewV2Artifacts({
        artifactInputs: [value.artifactPath],
        manifestDirectory: value.manifestDirectory,
      }),
    ).rejects.toThrow("1-2 sentences");
  });

  it("does not count periods inside common civic abbreviations as sentences", async () => {
    const value = await fixture();
    value.artifact.articleOverview.keyPoints = [
      {
        sourceEntryIds: [ENTRY_A],
        text: "The phaseout covers Blue No. 1, Blue No. 2, Green No. 3, Red No. 40, Yellow No. 5, and Yellow No. 6 by the end of 2027.",
      },
      {
        sourceEntryIds: [ENTRY_B],
        text: "StudentAid.gov will be unavailable from 5 p.m. ET on Aug. 2 until approximately noon ET on Aug. 3 for scheduled maintenance.",
      },
      {
        sourceEntryIds: [ENTRY_A],
        text: "Officials identified Ahmed M. M. Alaqad in the civil complaint while emphasizing that the filing contains allegations the government must prove.",
      },
      {
        sourceEntryIds: [ENTRY_B],
        text: "Recruiters plan to attend the U.S. Psych Congress from Sept. 17 through Sept. 21 to discuss federal clinical careers.",
      },
    ];
    await writeFile(value.artifactPath, JSON.stringify(value.artifact));
    await expect(
      validateArticleOverviewV2Artifacts({
        artifactInputs: [value.artifactPath],
        manifestDirectory: value.manifestDirectory,
      }),
    ).resolves.toHaveLength(1);
  });

  it("rejects an overview that does not collectively cite every source", async () => {
    const value = await fixture();
    value.artifact.articleOverview.summary.sourceEntryIds = [ENTRY_A];
    value.artifact.articleOverview.keyPoints[1]!.sourceEntryIds = [ENTRY_A];
    await writeFile(value.artifactPath, JSON.stringify(value.artifact));
    await expect(
      validateArticleOverviewV2Artifacts({
        artifactInputs: [value.artifactPath],
        manifestDirectory: value.manifestDirectory,
      }),
    ).rejects.toThrow("collectively cite every source");
  });

  it("rejects output from a different writer contract", async () => {
    const value = await fixture();
    value.artifact.promptHash = "f".repeat(64);
    await writeFile(value.artifactPath, JSON.stringify(value.artifact));
    await expect(
      validateArticleOverviewV2Artifacts({
        artifactInputs: [value.artifactPath],
        manifestDirectory: value.manifestDirectory,
      }),
    ).rejects.toThrow("prompt hash mismatch");
  });

  it("rejects duplicate artifacts for one event card", async () => {
    const value = await fixture();
    await writeFile(
      path.join(path.dirname(value.artifactPath), "duplicate.json"),
      JSON.stringify(value.artifact),
    );
    await expect(
      validateArticleOverviewV2Artifacts({
        artifactInputs: [path.dirname(value.artifactPath)],
        manifestDirectory: value.manifestDirectory,
      }),
    ).rejects.toThrow("duplicate article-overview.v2 artifact");
  });
});
