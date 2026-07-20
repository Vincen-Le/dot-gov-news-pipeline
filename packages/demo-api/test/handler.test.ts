import { describe, expect, it, vi } from "vitest";

import { handleDemoRequest } from "../src/handler";
import type {
  DemoRepository,
  DemoStorylineDetail,
  DemoStorylineListItem,
} from "../src/repository";

const storylineId = "00000000-0000-4000-8000-000000000021";

function storyline(
  overrides: Partial<DemoStorylineListItem> = {},
): DemoStorylineListItem {
  return {
    agencies: ["fda"],
    categoryName: null,
    distinctFeeds: 1,
    entities: [],
    entryCount: 1,
    episodeCount: 1,
    eventKeys: [],
    firstEntryAt: "2026-07-18T12:00:00.000Z",
    firstOverviewAt: "2026-07-18T12:00:00.000Z",
    headline: "Reviewed update",
    id: storylineId,
    newestEntryAt: "2026-07-19T12:00:00.000Z",
    rankKey: 8,
    themeId: null,
    themeName: null,
    unreviewedEntryCount: 0,
    ...overrides,
  };
}

function detail(
  overrides: Partial<DemoStorylineDetail> = {},
): DemoStorylineDetail {
  return {
    ...storyline(),
    categoryId: null,
    episodes: [],
    overviewCards: [],
    ...overrides,
  };
}

function repository(overrides: Partial<DemoRepository> = {}): DemoRepository {
  return {
    getBootstrap: vi.fn().mockResolvedValue({
      agencies: [],
      categories: [],
      previews: [],
      storylines: { hasMore: false, items: [storyline()] },
      themes: [],
    }),
    getContentRevision: vi.fn().mockResolvedValue("7"),
    getThumbnailAsset: vi.fn().mockResolvedValue(null),
    getRankOverview: vi.fn().mockResolvedValue(null),
    getStoryline: vi.fn().mockResolvedValue(detail()),
    listAgencies: vi.fn().mockResolvedValue([]),
    listCategories: vi.fn().mockResolvedValue([]),
    listRankRows: vi.fn().mockResolvedValue([]),
    listStorylines: vi.fn().mockResolvedValue({
      hasMore: false,
      items: [storyline()],
    }),
    listThemes: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("demo read handler", () => {
  it("resolves an uncached revision and serves immutable revisioned JSON", async () => {
    const data = repository();
    const revision = await handleDemoRequest(
      new Request("https://demo.example/api/lab/revision"),
      { repository: data },
    );
    const response = await handleDemoRequest(
      new Request(
        "https://demo.example/api/lab/bootstrap?limit=500&sort=rank&revision=7",
      ),
      { repository: data },
    );

    expect(revision.headers.get("cache-control")).toBe("no-store");
    expect(await revision.json()).toMatchObject({ data: { revision: "7" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.get("vercel-cdn-cache-control")).toBe(
      "public, s-maxage=31536000, immutable",
    );
    expect(data.getBootstrap).toHaveBeenCalledWith(500);
  });

  it("rejects missing and stale revisions without caching the error", async () => {
    const data = repository();
    const missing = await handleDemoRequest(
      new Request("https://demo.example/api/lab/bootstrap?limit=500"),
      { repository: data },
    );
    const stale = await handleDemoRequest(
      new Request(
        "https://demo.example/api/lab/bootstrap?limit=500&revision=6",
      ),
      { repository: data },
    );

    expect(missing.status).toBe(400);
    expect(stale.status).toBe(409);
    expect(stale.headers.get("cache-control")).toBe("no-store");
    expect(await stale.json()).toMatchObject({
      error: { code: "stale_revision", retryable: true },
    });
    expect(data.getBootstrap).not.toHaveBeenCalled();
  });

  it("rejects a response when content changes while it is assembled", async () => {
    const data = repository({
      getContentRevision: vi
        .fn()
        .mockResolvedValueOnce("7")
        .mockResolvedValueOnce("8"),
    });
    const response = await handleDemoRequest(
      new Request(
        "https://demo.example/api/lab/bootstrap?limit=500&revision=7",
      ),
      { repository: data },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("filters unreviewed items even when a repository returns one", async () => {
    const data = repository({
      listStorylines: vi.fn().mockResolvedValue({
        hasMore: false,
        items: [
          storyline(),
          storyline({ id: crypto.randomUUID(), unreviewedEntryCount: 1 }),
        ],
      }),
    });

    const response = await handleDemoRequest(
      new Request(
        "https://demo.example/api/lab/storylines?limit=10&revision=7",
      ),
      { repository: data },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { items: [{ id: storylineId }] },
    });
    expect(data.listStorylines).toHaveBeenCalledWith(10);
  });

  it("validates query parameters and storyline identifiers", async () => {
    const data = repository();
    const duplicate = await handleDemoRequest(
      new Request("https://demo.example/api/lab/storylines?limit=1&limit=2"),
      { repository: data },
    );
    const malformed = await handleDemoRequest(
      new Request("https://demo.example/api/lab/storylines/not-a-uuid"),
      { repository: data },
    );

    expect(duplicate.status).toBe(400);
    expect(malformed.status).toBe(400);
  });

  it("fails closed for an unreviewed detail", async () => {
    const data = repository({
      getStoryline: vi
        .fn()
        .mockResolvedValue(detail({ unreviewedEntryCount: 1 })),
    });

    const response = await handleDemoRequest(
      new Request(
        `https://demo.example/api/lab/storylines/${storylineId}?revision=7`,
      ),
      { repository: data },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects mutation methods and strips bodies from HEAD responses", async () => {
    const data = repository();
    const mutation = await handleDemoRequest(
      new Request("https://demo.example/api/lab/storylines", {
        method: "POST",
      }),
      { repository: data },
    );
    const head = await handleDemoRequest(
      new Request("https://demo.example/api/lab/agencies?revision=7", {
        method: "HEAD",
      }),
      { repository: data },
    );

    expect(mutation.status).toBe(405);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("returns a safe provider error without leaking implementation details", async () => {
    const data = repository({
      listThemes: vi.fn().mockRejectedValue(new Error("secret database error")),
    });

    const response = await handleDemoRequest(
      new Request("https://demo.example/api/lab/topics/themes?revision=7"),
      { repository: data },
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("provider_unavailable");
    expect(body).not.toContain("secret database error");
  });
});
