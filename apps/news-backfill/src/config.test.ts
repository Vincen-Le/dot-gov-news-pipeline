import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifest } from "./config";

describe("backfill manifests", () => {
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

  it("loads an additive event-chain cohort", async () => {
    const manifest = await loadManifest(
      path.resolve(
        import.meta.dirname,
        "../../../config/news-backfill/event-chain-expansion-v1.json",
      ),
    );

    expect(manifest.publishers).toHaveLength(6);
    expect(
      new Set(manifest.publishers.map(({ publisherKey }) => publisherKey)).size,
    ).toBe(6);
    expect(manifest.windowStart).toBe("2025-07-18T00:00:00.000Z");
    expect(manifest.windowEnd).toBe("2026-07-18T00:00:00.000Z");
  });

  it.each([
    ["chain-rich-curation-v1.json", 5],
    ["wildfire-recent-curation-v1.json", 1],
  ])("loads curated chain-rich manifest %s", async (file, publishers) => {
    const manifest = await loadManifest(
      path.resolve(import.meta.dirname, "../../../config/news-backfill", file),
    );

    expect(manifest.publishers).toHaveLength(publishers);
    expect(manifest.publishers.every(({ sources }) => sources.length > 0)).toBe(
      true,
    );
  });
});
