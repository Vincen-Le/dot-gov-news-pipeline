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
    const page = `<article class="post" id="2025-08-01">
      <h3>Benefit update</h3><p>Social Security announced an update.</p>
    </article>`;
    const batches = await collect(
      enumerateBatches({
        cursor: {},
        fetchDocument: async (url) => ({
          body: url.includes("/cdx/") ? cdx : page,
          contentType: url.includes("/cdx/") ? "application/json" : "text/html",
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
        publishedAt: "2025-08-01T00:00:00.000Z",
        title: "Benefit update",
        url: "https://www.ssa.gov/news/press/releases/2025/#2025-08-01",
      },
    ]);
  });
});
