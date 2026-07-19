import { describe, expect, it } from "vitest";

import { backfillRunKey } from "./run-key";

describe("backfillRunKey", () => {
  it("changes when the extractor version changes", () => {
    const input = {
      cohortId: "top-20",
      manifestSha256: "abcdef0123456789",
      windowEnd: "2026-07-18T00:00:00Z",
      windowStart: "2025-07-18T00:00:00Z",
    };

    expect(backfillRunKey({ ...input, extractorVersion: 3 })).toBe(
      "top-20-2025-07-18-2026-07-18-abcdef012345-extractor-v3",
    );
    expect(backfillRunKey({ ...input, extractorVersion: 4 })).not.toBe(
      backfillRunKey({ ...input, extractorVersion: 3 }),
    );
  });
});
