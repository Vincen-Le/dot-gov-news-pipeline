// @vitest-environment node

import type {
  DemoRepository,
  DemoStorylineDetail,
  DemoStorylineListItem,
} from "@dot-gov-news/demo-api";
import { describe, expect, it, vi } from "vitest";

import { createVercelDemoHandler } from "../api/lab/[...path]";

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
    getCardThumbnailAsset: vi.fn().mockResolvedValue(null),
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
        "https://demo.example/api/lab/storylines?limit=500&sort=rank",
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
    const handler = createVercelDemoHandler(
      configuredEnvironment,
      () => data,
    );

    const response = await handler(
      new Request(
        "https://demo.example/api/lab/storylines?limit=500&sort=rank&path=storylines",
      ),
    );

    expect(response.status).toBe(200);
    expect(data.listStorylines).toHaveBeenCalledWith(500);
  });

  it("continues to reject unknown public query parameters", async () => {
    const data = repository();
    const handler = createVercelDemoHandler(
      configuredEnvironment,
      () => data,
    );

    const response = await handler(
      new Request(
        "https://demo.example/api/lab/storylines?limit=500&unknown=value",
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
      new Request(`https://demo.example/api/lab/storylines/${storylineId}`),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("reuses one repository client within a warm function instance", async () => {
    const factory = vi.fn(() => repository());
    const handler = createVercelDemoHandler(configuredEnvironment, factory);

    await handler(new Request("https://demo.example/api/lab/storylines"));
    await handler(new Request("https://demo.example/api/lab/agencies"));

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("serves only the card-scoped R2 object selected by the repository", async () => {
    const cardId = crypto.randomUUID();
    const data = repository({
      getCardThumbnailAsset: vi.fn().mockResolvedValue({
        key: `golden/event-cards/${cardId}/private-card.webp`,
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
        `https://demo.example/api/lab/assets/event-cards/${cardId}/card`,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("image-bytes");
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("etag")).toBe('"asset-etag"');
    expect(get).toHaveBeenCalledWith(
      `golden/event-cards/${cardId}/private-card.webp`,
    );
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
      new Request(
        "https://demo.example/api/lab/assets/event-cards/not-a-uuid/card",
      ),
    );

    expect(response.status).toBe(400);
    expect(data.getCardThumbnailAsset).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
