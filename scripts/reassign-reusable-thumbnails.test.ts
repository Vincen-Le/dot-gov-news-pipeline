import { describe, expect, it } from "vitest";

import {
  planReusableThumbnailAssignments,
  type ReusableThumbnailStoryline,
} from "./reassign-reusable-thumbnails.js";

function storyline(
  id: string,
  position: number,
  candidates: ReusableThumbnailStoryline["candidates"],
): ReusableThumbnailStoryline {
  return { candidates, position, storylineId: id };
}

describe("reusable thumbnail assignment planning", () => {
  it("uses every candidate once per shuffled bag without adjacent pool repeats", () => {
    const candidates = [
      { imageId: "category", selectionSource: "category_fallback" as const },
      { imageId: "agency", selectionSource: "agency_fallback" as const },
    ];
    const rows = Array.from({ length: 6 }, (_, index) =>
      storyline(`storyline-${index}`, index + 1, candidates),
    );

    const first = planReusableThumbnailAssignments(rows);
    const second = planReusableThumbnailAssignments(rows);

    expect(second).toEqual(first);
    expect(first.map(({ imageId }) => imageId).sort()).toEqual([
      "agency",
      "agency",
      "agency",
      "category",
      "category",
      "category",
    ]);
    for (let index = 1; index < first.length; index += 1) {
      expect(first[index]?.imageId).not.toBe(first[index - 1]?.imageId);
    }
  });

  it("avoids the globally previous image when the current bag has an alternative", () => {
    const category = {
      imageId: "category",
      selectionSource: "category_fallback" as const,
    };
    const rows = [
      storyline("first", 1, [category]),
      storyline("second", 2, [
        category,
        { imageId: "agency", selectionSource: "agency_fallback" },
      ]),
    ];

    expect(
      planReusableThumbnailAssignments(rows).map((row) => row.imageId),
    ).toEqual(["category", "agency"]);
  });

  it("retains the only eligible fallback when no alternative exists", () => {
    const rows = [
      storyline("first", 1, [
        { imageId: "category", selectionSource: "category_fallback" },
      ]),
      storyline("second", 2, [
        { imageId: "category", selectionSource: "category_fallback" },
      ]),
    ];

    expect(
      planReusableThumbnailAssignments(rows).map((row) => row.imageId),
    ).toEqual(["category", "category"]);
  });
});
