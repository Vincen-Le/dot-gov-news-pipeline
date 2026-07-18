import { describe, expect, it } from "vitest";

import {
  canonicalizeUrl,
  extractArticleMetadata,
  normalizeCandidate,
} from "./extract";

describe("article extraction", () => {
  it("prefers structured metadata and normalizes tracking URLs", () => {
    const html = `
      <html><head>
        <link rel="canonical" href="https://agency.gov/news/example/?utm_source=test">
        <script type="application/ld+json">{
          "@type": "NewsArticle",
          "headline": "Agency announcement",
          "datePublished": "2026-02-03T10:00:00-05:00",
          "description": "A useful summary."
        }</script>
      </head><body></body></html>`;

    expect(extractArticleMetadata(html, "https://agency.gov/fallback")).toEqual(
      {
        canonicalUrl: "https://agency.gov/news/example/?utm_source=test",
        publishedAt: "2026-02-03T15:00:00.000Z",
        summary: "A useful summary.",
        title: "Agency announcement",
      },
    );
    expect(
      canonicalizeUrl("https://AGENCY.gov/news/example/?utm_source=test#top"),
    ).toBe("https://agency.gov/news/example");
  });

  it("rejects entries outside the fixed backfill window", () => {
    expect(
      normalizeCandidate({
        artifactKey: "artifact",
        candidate: {
          externalItemId: "old",
          publishedAt: "2024-01-01T00:00:00Z",
          rawBody: "",
          rawContentType: "text/html",
          sourceUrl: "https://agency.gov/feed",
          summary: "Summary",
          title: "Old item",
          url: "https://agency.gov/news/old",
        },
        fetchedAt: "2026-07-18T00:00:00Z",
        newsSubtype: "agency_news",
        windowEnd: "2026-07-18T00:00:00Z",
        windowStart: "2025-07-18T00:00:00Z",
      }),
    ).toBeNull();
  });
});
