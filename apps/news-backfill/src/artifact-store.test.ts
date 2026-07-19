import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DryRunArtifactStore } from "./artifact-store";

describe("DryRunArtifactStore", () => {
  it("returns the production content-addressed key without writing", async () => {
    const body = "complete source response";
    const sha256 = createHash("sha256").update(body).digest("hex");
    const store = new DryRunArtifactStore();

    await expect(store.archive("agency", body, "text/html")).resolves.toBe(
      `news-backfill/objects/${sha256}`,
    );
  });

  it("deduplicates identical bytes across publisher and content type", async () => {
    const body = "one immutable response";
    const store = new DryRunArtifactStore();

    await expect(store.archive("agency-a", body, "text/html")).resolves.toBe(
      await store.archive("agency-b", body, "application/json"),
    );
  });
});
