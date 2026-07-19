import { describe, expect, it } from "vitest";

import { allowsTitle, ingestChunks, mapWithConcurrency } from "./runner";
import type { NormalizedEntry, SourceProfile } from "./types";

function entry(index: number, bodyLength = 10): NormalizedEntry {
  return {
    body_text: "b".repeat(bodyLength),
    candidate_key: String(index).padStart(64, "0"),
    content_hash: String(index).padStart(64, "a"),
    external_item_id: String(index),
    extractor_version: 4,
    fetched_at: "2026-07-18T00:00:00.000Z",
    news_subtype: "release",
    published_at: "2026-06-01T00:00:00.000Z",
    raw_artifact_key: `news-backfill/test/${index}.html`,
    summary: "Publisher summary",
    title: `Entry ${index}`,
    url: `https://agency.gov/news/${index}`,
    url_canonical: `https://agency.gov/news/${index}`,
  };
}

describe("backfill runner", () => {
  it("chunks complete article bodies by serialized request size", () => {
    const entries = [entry(1, 400_000), entry(2, 400_000), entry(3, 10)];
    const chunks = ingestChunks(entries, 750_000);

    expect(chunks.map((chunk) => chunk.length)).toEqual([1, 2]);
    expect(chunks.flat().map((item) => item.body_text?.length)).toEqual([
      400_000, 400_000, 10,
    ]);
  });

  it("never puts more than 50 entries in one database call", () => {
    expect(
      ingestChunks(Array.from({ length: 101 }, (_, index) => entry(index))).map(
        (chunk) => chunk.length,
      ),
    ).toEqual([50, 50, 1]);
  });

  it("bounds hydration concurrency and preserves candidate order", async () => {
    let active = 0;
    let maximumActive = 0;
    const output = await mapWithConcurrency(
      [0, 1, 2, 3, 4, 5],
      3,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5 - (value % 3)));
        active -= 1;
        return `item-${value}`;
      },
    );

    expect(maximumActive).toBe(3);
    expect(output).toEqual([
      "item-0",
      "item-1",
      "item-2",
      "item-3",
      "item-4",
      "item-5",
    ]);
  });

  it("applies manifest title curation after article hydration", () => {
    const profile = {
      excludeTitlePattern: "(?:appointment|public meeting)",
      includeTitlePattern: "(?:investigation|citation|settlement)",
    } as SourceProfile;

    expect(allowsTitle(profile, "Agency Opens Investigation")).toBe(true);
    expect(allowsTitle(profile, "Agency Announces Public Meeting")).toBe(false);
    expect(allowsTitle(profile, "Agency Announces Grant Program")).toBe(false);
  });
});
