import { describe, expect, it } from "vitest";

import { objectKey } from "../src/images.js";

describe("R2 object keys", () => {
  it("are variant-scoped and content-addressed", () => {
    const hash = "a".repeat(64);
    expect(objectKey("master", hash, "image/png")).toBe(
      `golden-enrichment/images/master/sha256/${hash}.png`,
    );
    expect(objectKey("card", hash, "image/webp")).toBe(
      `golden-enrichment/images/card/sha256/${hash}.webp`,
    );
    expect(objectKey("social", hash, "image/jpeg")).toBe(
      `golden-enrichment/images/social/sha256/${hash}.jpg`,
    );
  });
});
