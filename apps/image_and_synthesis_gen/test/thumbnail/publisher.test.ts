import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { sha256 } from "../../src/shared/fingerprint.js";
import {
  assertPersistedImageRows,
  assertThumbnailRowsMatch,
  imageThumbnailRecord,
  prepareImageArtifacts,
  publishImageArtifacts,
  type ExistingThumbnailRow,
} from "../../src/thumbnail/publisher.js";
import { type ValidatedImageArtifact } from "../../src/thumbnail/validation.js";

const CARD_ID = "66b2b179-f85b-440a-a804-9c4ec6741a49";
const ENTRY_ID = "08fd7905-1015-4edc-9b3c-2cc16a5c214e";
const STORYLINE_ID = "11ae6748-ab78-428a-966a-2c285ecc08db";
const IMAGE_ID = "9c537f67-907f-484b-b2a1-69646f71cf6e";

async function validated(): Promise<ValidatedImageArtifact> {
  const masterBytes = await sharp({
    create: {
      background: "#f4f1e9",
      channels: 3,
      height: 1024,
      width: 1536,
    },
  })
    .png()
    .toBuffer();
  return {
    artifact: {
      altText:
        "Layered cream and cobalt paper forms create a clear civic pathway around one bright orange center shape.",
      eventCardId: CARD_ID,
      focalPoint: { x: 0.5, y: 0.5 },
      generatedAt: "2026-07-20T02:03:29Z",
      imageConcept: "Layered paper forms converge around one shared outline.",
      imageModel: "test-image-model",
      inputHash: "a".repeat(64),
      prompt: "Create one crop-safe civic editorial collage.",
    },
    artifactPath: `/tmp/${CARD_ID}/image-generation.json`,
    masterBytes,
    masterMetadata: await sharp(masterBytes).metadata(),
    masterPath: `/tmp/${CARD_ID}/storyline-master.png`,
    masterSha256: sha256(masterBytes),
    promptHash: sha256("Create one crop-safe civic editorial collage."),
    task: {
      eventCardId: CARD_ID,
      inputBasis: {
        card: { version: 3 },
        enrichmentVersion: 1,
        promptVersion: 1,
        sources: [{ newsEntryId: ENTRY_ID }],
        storyline: { storylineId: STORYLINE_ID },
      },
    } as unknown as ValidatedImageArtifact["task"],
  };
}

describe("image-only publishing", () => {
  it("maps image provenance without article overview fields", async () => {
    const value = await validated();
    const [prepared] = await prepareImageArtifacts([value]);
    const record = imageThumbnailRecord(value, prepared!.images);
    expect(record).toMatchObject({
      enrichment_version: 1,
      master_sha256: value.masterSha256,
      model: "test-image-model",
      prompt_hash: value.promptHash,
      prompt_version: 1,
      source_card_version: 3,
      source_entry_ids: [ENTRY_ID],
    });
    expect(record).not.toHaveProperty("event_card_id");
    expect(record).not.toHaveProperty("article_overview");
  });

  it("accepts an exactly matching immutable retry", async () => {
    const [prepared] = await prepareImageArtifacts([await validated()]);
    const existing = {
      ...prepared!.record,
      focal_x: "0.50000",
      focal_y: "0.50000",
      generated_at: "2026-07-20T02:03:29+00:00",
      storyline_id: STORYLINE_ID,
    } as unknown as ExistingThumbnailRow;
    expect(() =>
      assertThumbnailRowsMatch(
        [existing],
        new Map([[STORYLINE_ID, prepared!]]),
      ),
    ).not.toThrow();
  });

  it("rejects different image content for the same storyline", async () => {
    const [prepared] = await prepareImageArtifacts([await validated()]);
    const existing = {
      ...prepared!.record,
      master_sha256: "f".repeat(64),
      storyline_id: STORYLINE_ID,
    } as unknown as ExistingThumbnailRow;
    expect(() =>
      assertThumbnailRowsMatch(
        [existing],
        new Map([[STORYLINE_ID, prepared!]]),
      ),
    ).toThrow("different thumbnail master_sha256");
  });

  it("dry-run prepares keys without writing or constructing R2", async () => {
    const prepared = await prepareImageArtifacts([await validated()]);
    const rpc = vi.fn();
    const uploadAndVerify = vi.fn();
    const result = await publishImageArtifacts(prepared, {
      database: { rpc, select: vi.fn() },
      dryRun: true,
      imageStore: { uploadAndVerify },
    });
    expect(result.cardCount).toBe(1);
    expect(result.imageKeys).toHaveLength(3);
    expect(result.thumbnailRows).toBe(0);
    expect(uploadAndVerify).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("uploads and verifies every R2 object before inserting the row", async () => {
    const prepared = await prepareImageArtifacts([await validated()]);
    const events: string[] = [];
    const uploadAndVerify = vi.fn(async () => {
      events.push("upload");
    });
    const rpc = vi.fn(async () => {
      events.push("publish");
    });
    const select = vi.fn(async (table: string) => {
      if (table === "golden_storyline_thumbnails") {
        return [{ image_id: IMAGE_ID, storyline_id: STORYLINE_ID }];
      }
      if (table === "images") {
        return [{ id: IMAGE_ID, ...prepared[0]!.record }];
      }
      return [];
    });
    const result = await publishImageArtifacts(prepared, {
      database: { rpc, select },
      dryRun: false,
      imageStore: { uploadAndVerify },
    });
    expect(events).toEqual(["upload", "upload", "upload", "publish"]);
    expect(rpc).toHaveBeenCalledWith("publish_golden_storyline_thumbnail", {
      p_image: prepared[0]!.record,
      p_selection_source: "generated",
      p_storyline_id: STORYLINE_ID,
    });
    expect(result.thumbnailRows).toBe(1);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("fails if an ignored duplicate insert does not match the selected image", async () => {
    const prepared = await prepareImageArtifacts([await validated()]);
    const rpc = vi.fn();
    await expect(
      publishImageArtifacts(prepared, {
        database: { rpc, select: vi.fn(async () => []) },
        dryRun: false,
        imageStore: { uploadAndVerify: vi.fn() },
      }),
    ).rejects.toThrow(`missing storyline ${STORYLINE_ID}`);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("requires every expected card during post-insert verification", async () => {
    const prepared = await prepareImageArtifacts([await validated()]);
    await expect(
      assertPersistedImageRows({ select: vi.fn(async () => []) }, prepared),
    ).rejects.toThrow(`missing storyline ${STORYLINE_ID}`);
  });

  it("does not insert when an R2 verification fails", async () => {
    const prepared = await prepareImageArtifacts([await validated()]);
    const rpc = vi.fn();
    const uploadAndVerify = vi.fn(async () => {
      throw new Error("R2 verification failed");
    });
    await expect(
      publishImageArtifacts(prepared, {
        database: { rpc, select: vi.fn() },
        dryRun: false,
        imageStore: { uploadAndVerify },
      }),
    ).rejects.toThrow("R2 verification failed");
    expect(rpc).not.toHaveBeenCalled();
  });
});
