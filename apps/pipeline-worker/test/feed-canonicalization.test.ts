import { describe, expect, it } from "vitest";

import { canonicalizeFeedUrl } from "../src/discovery/canonicalize-feed-url";

describe("feed URL canonicalization", () => {
  it("normalizes only transport identity and preserves path/query semantics", () => {
    expect(
      canonicalizeFeedUrl("HTTPS://Agency.GOV:443/Feed/?b=2&a=1#section"),
    ).toBe("https://agency.gov/Feed/?b=2&a=1");
  });
});
