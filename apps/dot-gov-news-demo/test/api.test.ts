// @vitest-environment node

import type {
  DemoRepository,
  DemoStorylineDetail,
  DemoStorylineListItem,
} from "@dot-gov-news/demo-api";
import { describe, expect, it, vi } from "vitest";

import { createVercelDemoHandler } from "../api/_lab.js";

const storylineId = "00000000-0000-4000-8000-000000000021";

function storyline(
  overrides: Partial<DemoStorylineListItem> = {},
): DemoStorylineListItem {
  return {
    agencies: ["fda"],
    categoryName: "Public Health",
    distinctFeeds: 1,
    entities: [],
    entryCount: 1,
    episodeCount: 1,
    eventKeys: [],
    firstEntryAt: "2026-07-18T12:00:00.000Z",
    firstOverviewAt: "2026-07-18T12:00:00.000Z",
    headline: "Reviewed public-health update",
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

const configuredEnvironment = {
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  R2_ACCESS_KEY_ID: "r2-access-key",
  R2_BUCKET_NAME: "demo-assets",
  R2_SECRET_ACCESS_KEY: "r2-secret-key",
  SUPABASE_DEMO_KEY: "restricted-demo-key",
  SUPABASE_URL: "https://project.supabase.co",
};

describe("the Vercel demo API", () => {
  it("fails closed when its server-side Supabase configuration is absent", async () => {
    const response = await createVercelDemoHandler({})(
      new Request("https://demo.example/api/lab/storylines"),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "api_not_configured" },
    });
  });

  it("queries Supabase directly and filters any unreviewed list item", async () => {
    const data = repository({
      listStorylines: vi.fn().mockResolvedValue({
        hasMore: false,
        items: [
          storyline(),
          storyline({ id: crypto.randomUUID(), unreviewedEntryCount: 1 }),
        ],
      }),
    });
    const factory = vi.fn(() => data);
    const handler = createVercelDemoHandler(configuredEnvironment, factory);

    const response = await handler(
      new Request(
        "https://demo.example/api/lab/storylines?limit=500&sort=rank&revision=7",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { items: [{ id: storylineId, unreviewedEntryCount: 0 }] },
    });
    expect(factory).toHaveBeenCalledWith({
      supabaseKey: "restricted-demo-key",
      supabaseUrl: "https://project.supabase.co",
    });
    expect(data.listStorylines).toHaveBeenCalledWith(500);
  });

  it("ignores Vercel catch-all route metadata when validating a query", async () => {
    const data = repository();
    const handler = createVercelDemoHandler(configuredEnvironment, () => data);

    const response = await handler(
      new Request(
        "https://demo.example/api/lab/storylines?limit=500&sort=rank&revision=7&path=storylines",
      ),
    );

    expect(response.status).toBe(200);
    expect(data.listStorylines).toHaveBeenCalledWith(500);
  });

  it("restores a nested public path from Vercel rewrite metadata", async () => {
    const data = repository();
    const handler = createVercelDemoHandler(configuredEnvironment, () => data);

    const response = await handler(
      new Request(
        "https://demo.example/api/lab?limit=500&sort=rank&revision=7&path=storylines",
      ),
    );

    expect(response.status).toBe(200);
    expect(data.listStorylines).toHaveBeenCalledWith(500);
  });

  it("continues to reject unknown public query parameters", async () => {
    const data = repository();
    const handler = createVercelDemoHandler(configuredEnvironment, () => data);

    const response = await handler(
      new Request(
        "https://demo.example/api/lab/storylines?limit=500&unknown=value&revision=7",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_query" },
    });
    expect(data.listStorylines).not.toHaveBeenCalled();
  });

  it("conceals a detail response that is not fully reviewed", async () => {
    const data = repository({
      getStoryline: vi
        .fn()
        .mockResolvedValue(detail({ unreviewedEntryCount: 2 })),
    });
    const handler = createVercelDemoHandler(configuredEnvironment, () => data);

    const response = await handler(
      new Request(
        `https://demo.example/api/lab/storylines/${storylineId}?revision=7`,
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("reuses one repository client within a warm function instance", async () => {
    const factory = vi.fn(() => repository());
    const handler = createVercelDemoHandler(configuredEnvironment, factory);

    await handler(
      new Request("https://demo.example/api/lab/storylines?revision=7"),
    );
    await handler(
      new Request("https://demo.example/api/lab/agencies?revision=7"),
    );

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("serves the immutable image-scoped R2 object selected by its image ID", async () => {
    const imageId = crypto.randomUUID();
    const data = repository({
      getThumbnailAsset: vi.fn().mockResolvedValue({
        key: `golden/images/${imageId}/private-card.webp`,
        mimeType: "image/webp",
      }),
    });
    const get = vi.fn().mockResolvedValue({
      body: new Response("image-bytes").body,
      etag: '"asset-etag"',
      size: 11,
    });
    const assetFactory = vi.fn(() => ({ get }));
    const handler = createVercelDemoHandler(
      configuredEnvironment,
      () => data,
      assetFactory,
    );

    const response = await handler(
      new Request(
        `https://demo.example/api/lab?path=assets/images/${imageId}/card`,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("image-bytes");
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("etag")).toBe('"asset-etag"');
    expect(response.headers.get("vercel-cdn-cache-control")).toBe(
      "public, s-maxage=31536000, immutable",
    );
    expect(get).toHaveBeenCalledWith(
      `golden/images/${imageId}/private-card.webp`,
    );
    expect(data.getThumbnailAsset).toHaveBeenCalledWith(imageId);
    expect(assetFactory).toHaveBeenCalledWith({
      accessKeyId: "r2-access-key",
      bucket: "demo-assets",
      endpoint: "https://account-id.r2.cloudflarestorage.com",
      secretAccessKey: "r2-secret-key",
    });
  });

  it("rejects malformed asset IDs before reading Supabase or R2", async () => {
    const data = repository();
    const get = vi.fn();
    const handler = createVercelDemoHandler(
      configuredEnvironment,
      () => data,
      () => ({ get }),
    );

    const response = await handler(
      new Request("https://demo.example/api/lab/assets/images/not-a-uuid/card"),
    );

    expect(response.status).toBe(400);
    expect(data.getThumbnailAsset).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
