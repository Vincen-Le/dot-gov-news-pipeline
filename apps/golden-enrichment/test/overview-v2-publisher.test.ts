import { describe, expect, it } from "vitest";

import {
  articleOverviewV2Record,
  assertArticleOverviewRowsUpgradeable,
} from "../src/overview-v2-publisher.js";
import { type ValidatedArticleOverviewV2 } from "../src/overview-v2-validation.js";

const CARD_ID = "66b2b179-f85b-440a-a804-9c4ec6741a49";
const ENTRY_ID = "08fd7905-1015-4edc-9b3c-2cc16a5c214e";
const ENTRY_ID_TWO = "a269af69-9911-4b94-9450-fd0a1fabb954";

function validated(): ValidatedArticleOverviewV2 {
  return {
    artifact: {
      articleOverview: {
        keyPoints: [
          { sourceEntryIds: [ENTRY_ID], text: "First public key point." },
          { sourceEntryIds: [ENTRY_ID], text: "Second public key point." },
        ],
        summary: {
          sourceEntryIds: [ENTRY_ID],
          text: "A concise public synthesis.",
        },
      },
      enrichmentVersion: 2,
      eventCardId: CARD_ID,
      generatedAt: "2026-07-20T02:03:29Z",
      inputHash: "a".repeat(64),
      model: "test-model",
      promptHash: "b".repeat(64),
      promptVersion: 2,
      schemaVersion: "article-overview.v2",
      sourceCutoffAt: "2025-07-23T04:00:00Z",
      sourceEntryIds: [ENTRY_ID, ENTRY_ID_TWO],
    },
    artifactPath: "/tmp/article-overview.v2.json",
    task: {
      inputBasis: {
        card: { version: 3 },
        sources: [
          { contentHash: "c".repeat(64), newsEntryId: ENTRY_ID_TWO },
          { contentHash: "d".repeat(64), newsEntryId: ENTRY_ID },
        ],
      },
    } as unknown as ValidatedArticleOverviewV2["task"],
  };
}

describe("article overview v2 publishing", () => {
  it("allows a matching v1 row to be upgraded", () => {
    const value = validated();
    expect(() =>
      assertArticleOverviewRowsUpgradeable(
        [
          {
            article_overview: { legacy: true },
            enrichment_version: 1,
            event_card_id: CARD_ID,
            input_hash: value.artifact.inputHash,
            model: "old-model",
            prompt_hash: "d".repeat(64),
            prompt_version: 1,
          },
        ],
        new Map([[CARD_ID, value]]),
      ),
    ).not.toThrow();
  });

  it("keeps an existing v2 row immutable", () => {
    const value = validated();
    expect(() =>
      assertArticleOverviewRowsUpgradeable(
        [
          {
            article_overview: {
              ...value.artifact.articleOverview,
              summary: {
                sourceEntryIds: [ENTRY_ID],
                text: "Different synthesis.",
              },
            },
            enrichment_version: 2,
            event_card_id: CARD_ID,
            input_hash: value.artifact.inputHash,
            model: value.artifact.model,
            prompt_hash: value.artifact.promptHash,
            prompt_version: 2,
          },
        ],
        new Map([[CARD_ID, value]]),
      ),
    ).toThrow("v2 is immutable");
  });

  it("rejects an existing row for a different source snapshot", () => {
    const value = validated();
    expect(() =>
      assertArticleOverviewRowsUpgradeable(
        [
          {
            article_overview: value.artifact.articleOverview,
            enrichment_version: 1,
            event_card_id: CARD_ID,
            input_hash: "f".repeat(64),
            model: value.artifact.model,
            prompt_hash: value.artifact.promptHash,
            prompt_version: 1,
          },
        ],
        new Map([[CARD_ID, value]]),
      ),
    ).toThrow("different input hash");
  });

  it("maps provenance without any image fields", () => {
    const record = articleOverviewV2Record(validated());
    expect(record).toMatchObject({
      enrichment_version: 2,
      event_card_id: CARD_ID,
      prompt_version: 2,
      source_card_version: 3,
      source_content_hashes: ["c".repeat(64), "d".repeat(64)],
      source_entry_ids: [ENTRY_ID_TWO, ENTRY_ID],
    });
    expect(record).not.toHaveProperty("r2_card_key");
  });
});
