import { describe, expect, it, vi } from "vitest";

import { reusableImageByKey } from "../../src/reusable/catalog.js";
import { COMPLETED_REUSABLE_IMAGES } from "../../src/reusable/completed.js";
import {
  publishReusableImages,
  reusableImageRecord,
  type PreparedReusableImage,
} from "../../src/reusable/publisher.js";
import { type PreparedImage } from "../../src/thumbnail/images.js";

function image(
  variant: PreparedImage["variant"],
  sha: string,
  width: number,
  height: number,
  mediaType: string,
): PreparedImage {
  return {
    bytes: Buffer.from(variant),
    height,
    key: `golden-enrichment/images/${variant}/sha256/${sha}`,
    mediaType,
    sha256: sha,
    variant,
    width,
  };
}

describe("reusable image publishing", () => {
  it("catalogs exactly the completed renders without duplicate files or keys", () => {
    expect(COMPLETED_REUSABLE_IMAGES).toHaveLength(54);
    expect(new Set(COMPLETED_REUSABLE_IMAGES.map(({ key }) => key)).size).toBe(
      54,
    );
    expect(
      new Set(
        COMPLETED_REUSABLE_IMAGES.map(
          ({ generatedFileName }) => generatedFileName,
        ),
      ).size,
    ).toBe(54);
    for (const completed of COMPLETED_REUSABLE_IMAGES) {
      expect(reusableImageByKey(completed.key)).toBeDefined();
    }
  });

  it("builds deterministic reusable provenance with the catalog image id", () => {
    const definition = reusableImageByKey("education")!;
    const images = [
      image("master", "a".repeat(64), 1536, 1024, "image/png"),
      image("card", "b".repeat(64), 1200, 480, "image/webp"),
      image("social", "c".repeat(64), 1200, 630, "image/webp"),
    ] as const;
    expect(reusableImageRecord(definition, images)).toMatchObject({
      card_sha256: "b".repeat(64),
      id: definition.imageId,
      image_concept: {
        key: "education",
        scope: "category",
      },
      master_sha256: "a".repeat(64),
      social_sha256: "c".repeat(64),
      source_card_version: null,
      source_entry_ids: [],
    });
  });

  it("uploads every variant before registering and verifies persisted hashes", async () => {
    const definition = reusableImageByKey("education")!;
    const images = [
      image("master", "a".repeat(64), 1536, 1024, "image/png"),
      image("card", "b".repeat(64), 1200, 480, "image/webp"),
      image("social", "c".repeat(64), 1200, 630, "image/webp"),
    ] as const;
    const prepared: PreparedReusableImage = {
      definition,
      images,
      record: reusableImageRecord(definition, images),
      sourcePath: "/tmp/education.png",
    };
    const uploadAndVerify = vi.fn().mockResolvedValue(undefined);
    const rpc = vi.fn().mockResolvedValue(undefined);
    const select = vi.fn().mockResolvedValue([
      {
        card_sha256: prepared.record.card_sha256,
        id: definition.imageId,
        master_sha256: prepared.record.master_sha256,
        social_sha256: prepared.record.social_sha256,
      },
    ]);

    await expect(
      publishReusableImages([prepared], {
        database: { rpc, select },
        dryRun: false,
        imageStore: { uploadAndVerify },
      }),
    ).resolves.toMatchObject({ published: 1 });

    expect(uploadAndVerify).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenCalledWith("publish_reusable_image", {
      p_display_name: "Education",
      p_image: prepared.record,
      p_scope: "category",
      p_scope_key: "education",
    });
    expect(uploadAndVerify.mock.invocationCallOrder.at(-1)).toBeLessThan(
      rpc.mock.invocationCallOrder[0]!,
    );
  });
});
