import { afterEach, describe, expect, it, vi } from "vitest";

import { dotGovApi } from "../src/api/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the revisioned demo client", () => {
  it("deduplicates concurrent uncached revision lookups", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: { revision: "7" } }, { status: 200 }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { agencies: [] } }, { status: 200 }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { themes: [] } }, { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      Promise.all([dotGovApi.agencies(), dotGovApi.themes()]),
    ).resolves.toEqual([{ agencies: [] }, { themes: [] }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledWith(
      "/api/lab/agencies?revision=7",
      expect.any(Object),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/lab/topics/themes?revision=7",
      expect.any(Object),
    );
  });

  it("resolves the current revision before requesting mutable JSON", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: { revision: "7" } }, { status: 200 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              agencies: [],
              categories: [],
              previews: [],
              storylines: { hasMore: false, items: [] },
              themes: [],
            },
          },
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(dotGovApi.bootstrap()).resolves.toMatchObject({
      storylines: { items: [] },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/lab/revision",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/lab/bootstrap?limit=500&sort=rank&revision=7",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("resolves a new revision and retries once after a publication race", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: { revision: "7" } }, { status: 200 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "stale_revision",
              message: "Content changed",
            },
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { revision: "8" } }, { status: 200 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              agencies: [],
              categories: [],
              previews: [],
              storylines: { hasMore: false, items: [] },
              themes: [],
            },
          },
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(dotGovApi.bootstrap()).resolves.toBeDefined();
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      "/api/lab/bootstrap?limit=500&sort=rank&revision=8",
      expect.any(Object),
    );
  });
});
