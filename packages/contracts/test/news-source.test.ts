import { describe, expect, it } from "vitest";

import {
  CompleteNewsSourceDiscoverySchema,
  NEWS_SOURCE_TYPES,
  NewsSourceTypeSchema,
} from "../src/news-source";

const completion = {
  p_site_id: "20000000-0000-4000-8000-000000000001",
  p_lease_token: "21000000-0000-4000-8000-000000000001",
  p_result: "succeeded",
  p_site_health: {
    duration_ms: 250,
    final_url: "https://example.gov/news",
    http_status: 200,
  },
  p_sources: [
    {
      adapter_config: { page_parameter: "page" },
      backfill_supported: true,
      canonical_url: "https://example.gov/api/news",
      discovery_method: "api_documentation",
      discovery_url: "https://example.gov/developers",
      earliest_available_at: "2020-01-01T00:00:00.000Z",
      latest_observed_at: "2026-07-18T00:00:00.000Z",
      source_type: "publisher_api",
    },
  ],
  p_policy_version: 8,
} as const;

describe("news-source contracts", () => {
  it("supports every generalized source adapter", () => {
    expect(NEWS_SOURCE_TYPES).toEqual([
      "rss",
      "atom",
      "json_feed",
      "publisher_api",
      "html_archive",
      "sitemap",
    ]);
    for (const sourceType of NEWS_SOURCE_TYPES) {
      expect(NewsSourceTypeSchema.parse(sourceType)).toBe(sourceType);
    }
  });

  it("accepts a generalized discovery completion", () => {
    expect(CompleteNewsSourceDiscoverySchema.parse(completion)).toEqual(
      completion,
    );
  });

  it("only accepts no-news-source after a generalized empty discovery", () => {
    expect(
      CompleteNewsSourceDiscoverySchema.safeParse({
        ...completion,
        p_result: "no_news_source",
        p_site_health: {
          ...completion.p_site_health,
          checked_source_types: NEWS_SOURCE_TYPES,
        },
        p_sources: [],
      }).success,
    ).toBe(true);
    expect(
      CompleteNewsSourceDiscoverySchema.safeParse({
        ...completion,
        p_result: "no_news_source",
      }).success,
    ).toBe(false);
  });

  it("rejects no-source evidence from a syndication-only crawl", () => {
    expect(
      CompleteNewsSourceDiscoverySchema.safeParse({
        ...completion,
        p_result: "no_news_source",
        p_site_health: {
          ...completion.p_site_health,
          checked_source_types: ["rss", "atom", "json_feed"],
        },
        p_sources: [],
      }).success,
    ).toBe(false);
  });

  it("does not admit the legacy bounded-crawl result", () => {
    expect(
      CompleteNewsSourceDiscoverySchema.safeParse({
        ...completion,
        p_result: "no_" + "feed",
        p_sources: [],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate canonical source URLs", () => {
    expect(
      CompleteNewsSourceDiscoverySchema.safeParse({
        ...completion,
        p_sources: [completion.p_sources[0], completion.p_sources[0]],
      }).success,
    ).toBe(false);
  });
});
