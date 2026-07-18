import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifest } from "./config";

describe("top-20 manifest", () => {
  it("loads one unique, fixed-window source cohort", async () => {
    const manifest = await loadManifest(
      path.resolve(
        import.meta.dirname,
        "../../../config/news-backfill/top-20-diversity-v2.json",
      ),
    );

    expect(manifest.publishers).toHaveLength(20);
    expect(
      new Set(manifest.publishers.map(({ publisherKey }) => publisherKey)).size,
    ).toBe(20);
    expect(manifest.windowStart).toBe("2025-07-18T00:00:00.000Z");
    expect(manifest.windowEnd).toBe("2026-07-18T00:00:00.000Z");
  });
});
