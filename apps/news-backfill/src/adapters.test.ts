import { describe, expect, it } from "vitest";

import { enumerateBatches } from "./adapters";
import type { CandidateBatch, SourceProfile } from "./types";

async function collect(
  input: AsyncGenerator<CandidateBatch>,
): Promise<CandidateBatch[]> {
  const batches: CandidateBatch[] = [];
  for await (const batch of input) batches.push(batch);
  return batches;
}

function profile(overrides: Partial<SourceProfile>): SourceProfile {
  return {
    adapter: "sitemap",
    allowedHosts: ["agency.gov"],
    maxPages: 10,
    newsSubtype: "agency_news",
    sourceKey: "test",
    sourceType: "sitemap",
    sourceUrl: "https://agency.gov/sitemap.xml",
    title: "Test",
    ...overrides,
  };
}

describe("source adapters", () => {
  it("continues WordPress pagination when a short page advertises more pages", async () => {
    const requested: string[] = [];
    const batches = await collect(
      enumerateBatches({
        cursor: {},
        fetchDocument: async (url) => {
          requested.push(url);
          const page = Number(new URL(url).searchParams.get("page"));
          return {
            body: JSON.stringify([
              {
                id: page,
                link: `https://agency.gov/news/page-${page}`,
                date_gmt:
                  page === 1 ? "2026-07-01T12:00:00" : "2025-08-01T12:00:00",
                title: { rendered: `Page ${page}` },
                excerpt: { rendered: "Summary" },
              },
            ]),
            contentType: "application/json",
            finalUrl: url,
            status: 200,
            totalPages: 2,
          };
        },
        profile: profile({
          adapter: "wordpress",
          maxPages: 10,
          pageSize: 100,
          sourceType: "publisher_api",
          sourceUrl: "https://agency.gov/wp-json/wp/v2/posts",
        }),
        windowEnd: "2026-07-18T00:00:00Z",
        windowStart: "2025-07-18T00:00:00Z",
      }),
    );

    expect(requested).toHaveLength(2);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.stopReason).toBeUndefined();
    expect(batches[1]?.stopReason).toBe("source_exhausted");
  });

  it("extracts dates from archive listing link text before hydration", async () => {
    const body = `<p class="archive"><a href="https://agency.gov/news/update">
      <strong>March 31st, 2026 - Service update</strong>
    </a></p>`;
    const batches = await collect(
      enumerateBatches({
        cursor: {},
        fetchDocument: async (url) => ({
          body,
          contentType: "text/html",
          finalUrl: url,
          status: 200,
        }),
        profile: profile({
          adapter: "html_archive",
          includeUrlPattern: "/news/",
          maxPages: 1,
          sourceType: "html_archive",
          urlTemplate: "https://agency.gov/news/?page={page}",
        }),
        windowEnd: "2026-07-18T00:00:00Z",
        windowStart: "2025-07-18T00:00:00Z",
      }),
    );

    expect(batches[0]?.candidates[0]).toMatchObject({
      publishedAt: "2026-03-31T00:00:00.000Z",
      title: "Service update",
    });
  });

  it("uses sitemap last-modified dates to avoid hydrating known-old pages", async () => {
    const body = `<urlset>
      <url><loc>https://agency.gov/news/old</loc><lastmod>2024-01-01</lastmod></url>
      <url><loc>https://agency.gov/news/new</loc><lastmod>2026-01-01</lastmod></url>
    </urlset>`;
    const batches = await collect(
      enumerateBatches({
        cursor: {},
        fetchDocument: async (url) => ({
          body,
          contentType: "application/xml",
          finalUrl: url,
          status: 200,
        }),
        profile: profile({ includeUrlPattern: "/news/" }),
        windowEnd: "2026-07-18T00:00:00Z",
        windowStart: "2025-07-18T00:00:00Z",
      }),
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]?.candidates.map((candidate) => candidate.url)).toEqual([
      "https://agency.gov/news/new",
    ]);
  });

  it("reconstructs an older sitemap checkpoint without replaying completed children", async () => {
    const requested: string[] = [];
    const root = `<sitemapindex>
      <sitemap><loc>https://agency.gov/child-1.xml</loc></sitemap>
      <sitemap><loc>https://agency.gov/child-2.xml</loc></sitemap>
    </sitemapindex>`;
    const child = `<urlset><url>
      <loc>https://agency.gov/news/resumed</loc><lastmod>2026-01-01</lastmod>
    </url></urlset>`;
    const batches = await collect(
      enumerateBatches({
        cursor: { processedSitemaps: 2, queuedSitemaps: 1 },
        fetchDocument: async (url) => {
          requested.push(url);
          return {
            body: url.endsWith("sitemap.xml") ? root : child,
            contentType: "application/xml",
            finalUrl: url,
            status: 200,
          };
        },
        profile: profile({ includeUrlPattern: "/news/" }),
        windowEnd: "2026-07-18T00:00:00Z",
        windowStart: "2025-07-18T00:00:00Z",
      }),
    );

    expect(requested).toEqual([
      "https://agency.gov/sitemap.xml",
      "https://agency.gov/child-2.xml",
    ]);
    expect(batches[0]?.candidates[0]?.url).toBe(
      "https://agency.gov/news/resumed",
    );
  });

  it("extracts individual releases from an archived SSA yearly page", async () => {
    const cdx = JSON.stringify([
      ["timestamp", "original", "statuscode", "digest"],
      [
        "20260102030405",
        "https://www.ssa.gov/news/press/releases/2025/",
        "200",
        "digest",
      ],
    ]);
    const page = `<article class="page-shell">
      <article class="post" id="2025-08-01">
        <h3>Benefit update</h3><p>Social Security announced an update.</p>
      </article>
    </article>`;
    const blogCdx = JSON.stringify([
      ["timestamp", "original", "statuscode", "digest"],
      ["20260103040506", "https://blog.ssa.gov/feed/", "200", "blog-digest"],
    ]);
    const blogFeed = `<rss><channel><item>
      <guid>blog-1</guid>
      <link>https://blog.ssa.gov/service-update/</link>
      <title>Service update</title>
      <pubDate>Mon, 01 Jun 2026 12:00:00 GMT</pubDate>
      <description>Social Security published a service update.</description>
    </item></channel></rss>`;
    const batches = await collect(
      enumerateBatches({
        cursor: {},
        fetchDocument: async (url) => {
          const isCdx = url.includes("/cdx/");
          const isBlog = url.includes("blog.ssa.gov");
          return {
            body: isCdx ? (isBlog ? blogCdx : cdx) : isBlog ? blogFeed : page,
            contentType: isCdx
              ? "application/json"
              : isBlog
                ? "application/rss+xml"
                : "text/html",
            finalUrl: url,
            status: 200,
          };
        },
        profile: profile({
          adapter: "publisher_api",
          adapterVariant: "ssa_archive",
          allowedHosts: ["web.archive.org", "ssa.gov"],
          sourceType: "publisher_api",
          sourceUrl:
            "https://web.archive.org/cdx/search/cdx?url=www.ssa.gov/news/press/releases/*",
        }),
        windowEnd: "2026-07-18T00:00:00Z",
        windowStart: "2025-07-18T00:00:00Z",
      }),
    );

    expect(batches[0]?.candidates).toMatchObject([
      {
        publishedAt: "2025-08-01T00:00:00.000Z",
        title: "Benefit update",
        url: "https://www.ssa.gov/news/press/releases/2025/#2025-08-01",
      },
      {
        newsSubtype: "agency_news",
        title: "Service update",
        url: "https://blog.ssa.gov/service-update/",
      },
    ]);
  });

  it("prefers SSA's individually addressable press-release archive", async () => {
    const emptyCdx = JSON.stringify([
      ["timestamp", "original", "statuscode", "digest"],
    ]);
    const individualCdx = JSON.stringify([
      ["timestamp", "original", "statuscode", "digest"],
      [
        "20260302030405",
        "https://www.ssa.gov/news/en/press/releases/2026-03-01.html",
        "200",
        "release-digest",
      ],
    ]);
    const batches = await collect(
      enumerateBatches({
        cursor: {},
        fetchDocument: async (url) => ({
          body: url.includes("news/en/press") ? individualCdx : emptyCdx,
          contentType: "application/json",
          finalUrl: url,
          status: 200,
        }),
        profile: profile({
          adapter: "publisher_api",
          adapterVariant: "ssa_archive",
          allowedHosts: ["web.archive.org", "ssa.gov"],
          sourceType: "publisher_api",
          sourceUrl:
            "https://web.archive.org/cdx/search/cdx?url=www.ssa.gov/news/press/releases/*",
        }),
        windowEnd: "2026-07-18T00:00:00Z",
        windowStart: "2025-07-18T00:00:00Z",
      }),
    );

    expect(batches[0]?.candidates).toMatchObject([
      {
        fetchUrl:
          "https://web.archive.org/web/20260302030405id_/https://www.ssa.gov/news/en/press/releases/2026-03-01.html",
        publishedAt: "2026-03-01T00:00:00.000Z",
        url: "https://www.ssa.gov/news/en/press/releases/2026-03-01.html",
      },
    ]);
  });

  it("paginates the live USGS feed until it crosses the window boundary", async () => {
    const requested: string[] = [];
    const batches = await collect(
      enumerateBatches({
        cursor: {},
        fetchDocument: async (url) => {
          requested.push(url);
          const old = url.endsWith("page=1");
          return {
            body: `<rss><channel><item>
              <guid>${old ? "old" : "current"}</guid>
              <link>https://www.usgs.gov/news/${old ? "old" : "current"}</link>
              <title>${old ? "Old" : "Current"} science update</title>
              <pubDate>${old ? "Tue, 01 Jul 2025" : "Mon, 01 Jun 2026"} 12:00:00 GMT</pubDate>
              <description>USGS update.</description>
            </item></channel></rss>`,
            contentType: "application/rss+xml",
            finalUrl: url,
            status: 200,
          };
        },
        profile: profile({
          adapter: "syndication",
          allowedHosts: ["usgs.gov"],
          maxPages: 1,
          sourceType: "rss",
          sourceUrl: "https://www.usgs.gov/news/all/feed",
        }),
        windowEnd: "2026-07-18T00:00:00Z",
        windowStart: "2025-07-18T00:00:00Z",
      }),
    );

    expect(requested).toEqual([
      "https://www.usgs.gov/news/all/feed?page=0",
      "https://www.usgs.gov/news/all/feed?page=1",
    ]);
    expect(batches.at(-1)?.stopReason).toBe("window_boundary_reached");
  });

  it("accepts archived RSS snapshots regardless of their captured MIME type", async () => {
    const cdx = JSON.stringify([
      ["timestamp", "original", "statuscode", "digest"],
      [
        "20260102030405",
        "https://www.usgs.gov/news/all/feed",
        "200",
        "feed-digest",
      ],
    ]);
    const feed = `<rss><channel><item>
      <guid>release-1</guid>
      <link>https://www.usgs.gov/news/national-news-release/example</link>
      <title>Science update</title>
      <pubDate>Mon, 01 Jun 2026 12:00:00 GMT</pubDate>
      <description>USGS announced an update.</description>
    </item></channel></rss>`;
    const requested: string[] = [];
    const batches = await collect(
      enumerateBatches({
        cursor: {},
        fetchDocument: async (url) => {
          requested.push(url);
          return {
            body: url.includes("/cdx/") ? cdx : feed,
            contentType: url.includes("/cdx/")
              ? "application/json"
              : "application/rss+xml",
            finalUrl: url,
            status: 200,
          };
        },
        profile: profile({
          adapter: "publisher_api",
          adapterVariant: "wayback_feed",
          allowedHosts: ["web.archive.org", "usgs.gov"],
          includeUrlPattern: "https://www\\.usgs\\.gov/news/",
          sourceType: "publisher_api",
          sourceUrl:
            "https://web.archive.org/cdx/search/cdx?url=www.usgs.gov/news/all/feed",
        }),
        windowEnd: "2026-07-18T00:00:00Z",
        windowStart: "2025-07-18T00:00:00Z",
      }),
    );

    expect(requested[0]).not.toContain("mimetype:text/html");
    expect(batches[0]?.candidates).toMatchObject([
      {
        publishedAt: "Mon, 01 Jun 2026 12:00:00 GMT",
        title: "Science update",
        url: "https://www.usgs.gov/news/national-news-release/example",
      },
    ]);
  });

  it("filters visibly old dated URLs from generic archive captures", async () => {
    const cdx = JSON.stringify([
      ["timestamp", "original", "statuscode", "digest"],
      [
        "20260102030405",
        "https://agency.gov/news/2012-old-release",
        "200",
        "old-digest",
      ],
      [
        "20260102030406",
        "https://agency.gov/news/2026-current-release",
        "200",
        "current-digest",
      ],
      [
        "20260102030407",
        "https://agency.gov/news/2026-current-release?s=09&campaign=test",
        "200",
        "tracked-digest",
      ],
      [
        "20260102030408",
        "https://agency.gov/news/archives/report_07152025.htm",
        "200",
        "dated-digest",
      ],
    ]);
    const requested: string[] = [];
    const batches = await collect(
      enumerateBatches({
        cursor: {},
        fetchDocument: async (url) => {
          requested.push(url);
          return {
            body: cdx,
            contentType: "application/json",
            finalUrl: url,
            status: 200,
          };
        },
        profile: profile({
          adapter: "publisher_api",
          adapterVariant: "wayback",
          allowedHosts: ["web.archive.org", "agency.gov"],
          includeUrlPattern: "agency\\.gov/news/",
          sourceType: "publisher_api",
          sourceUrl:
            "https://web.archive.org/cdx/search/cdx?url=agency.gov/news/*",
        }),
        windowEnd: "2026-07-18T00:00:00Z",
        windowStart: "2025-07-18T00:00:00Z",
      }),
    );

    expect(batches[0]?.candidates).toMatchObject([
      { url: "https://agency.gov/news/2026-current-release" },
    ]);
    expect(decodeURIComponent(requested[0] ?? "")).toContain(
      "filter=original:.*(2025|2026).*",
    );
  });
});
