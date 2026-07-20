import { describe, expect, it } from "vitest";

import {
  isFullyReviewedAtCutoff,
  isReviewedHashMatch,
} from "../src/eligibility.js";

const reviewed = {
  contentHash: "a".repeat(64),
  contentHashAtReview: "a".repeat(64),
  publishedAt: "2025-07-01T00:00:00Z",
  reviewStatus: "reviewed",
};

describe("golden eligibility", () => {
  it("requires both human review and an unchanged content hash", () => {
    expect(isReviewedHashMatch(reviewed)).toBe(true);
    expect(isReviewedHashMatch({ ...reviewed, reviewStatus: "pending" })).toBe(
      false,
    );
    expect(
      isReviewedHashMatch({ ...reviewed, contentHash: "b".repeat(64) }),
    ).toBe(false);
  });

  it("does not let a future pending row block a historical card", () => {
    const future = {
      ...reviewed,
      publishedAt: "2025-07-03T00:00:00Z",
      reviewStatus: "pending",
    };
    expect(
      isFullyReviewedAtCutoff([reviewed, future], "2025-07-02T00:00:00Z"),
    ).toBe(true);
    expect(
      isFullyReviewedAtCutoff([reviewed, future], "2025-07-04T00:00:00Z"),
    ).toBe(false);
  });
});
