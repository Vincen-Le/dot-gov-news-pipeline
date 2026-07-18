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

  it("reads publisher-specific dates before unrelated navigation times", () => {
    const treasury = extractArticleMetadata(
      `<time datetime="2026-06-23T14:30:00Z">Featured</time>
       <h1>Treasury release</h1>
       <div class="field--name-field-news-publication-date"><time datetime="2026-07-15T20:15:00Z">July 15</time></div>`,
      "https://home.treasury.gov/news/press-releases/sb0565",
    );
    const fsa = extractArticleMetadata(
      `<h1>Student aid update</h1>
       <div class="field--name-field-publication-date-for-dis"><div class="field__item">July 18, 2025</div></div>`,
      "https://fsapartners.ed.gov/knowledge-center/library/dear-colleague-letters/2025-07-18/update",
    );
    const nps = extractArticleMetadata(
      `<h1>Park update</h1><strong>News Release Date:</strong> June 24, 2026`,
      "https://www.nps.gov/park/learn/news/update.htm",
    );
    const state = extractArticleMetadata(
      `<h1>Diplomatic update</h1><p class="article-meta__publish-date">July 17, 2026</p>`,
      "https://www.state.gov/releases/office-of-the-spokesperson/2026/07/diplomatic-update/",
    );

    expect(treasury.publishedAt).toBe("2026-07-15T20:15:00.000Z");
    expect(fsa.publishedAt?.slice(0, 10)).toBe("2025-07-18");
    expect(nps.publishedAt?.slice(0, 10)).toBe("2026-06-24");
    expect(state.publishedAt?.slice(0, 10)).toBe("2026-07-17");
  });

  it("reads IRS JSON dates and compact BLS archive dates", () => {
    const irs = extractArticleMetadata(
      `<h1>Tax update</h1><script type="application/ld+json">{
        "@graph": [{"name":"Tax update","datePosted":"2026-01-31T08:29:11-0500"}]
      }</script>`,
      "https://www.irs.gov/newsroom/tax-update",
    );
    const bls = extractArticleMetadata(
      "<h1>Consumer Price Index</h1>",
      "https://www.bls.gov/news.release/archives/cpi_07152025.htm",
    );

    expect(irs.publishedAt).toBe("2026-01-31T13:29:11.000Z");
    expect(bls.publishedAt).toBe("2025-07-15T00:00:00.000Z");
  });
});
