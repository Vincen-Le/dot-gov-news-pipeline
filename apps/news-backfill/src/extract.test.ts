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
        bodyText: null,
        canonicalUrl: "https://agency.gov/news/example/?utm_source=test",
        publishedAt: "2026-02-03T15:00:00.000Z",
        summary: "A useful summary.",
        title: "Agency announcement",
      },
    );
    expect(
      canonicalizeUrl("https://AGENCY.gov/news/example/?utm_source=test#top"),
    ).toBe("https://agency.gov/news/example");
    expect(
      canonicalizeUrl(
        "https://agency.gov/news/example?_hsenc=tracking&_hsmi=123&_kx=token",
      ),
    ).toBe("https://agency.gov/news/example");
    expect(canonicalizeUrl("http://www.osha.gov/news/example")).toBe(
      "https://www.osha.gov/news/example",
    );
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

  it("prefers hydrated article titles over generic archive link text", () => {
    const normalized = normalizeCandidate({
      artifactKey: "artifact",
      candidate: {
        externalItemId: "release-1",
        publishedAt: null,
        rawBody: "",
        rawContentType: "text/html",
        sourceUrl: "https://agency.gov/news",
        summary: null,
        title: "Continue Reading",
        url: "https://agency.gov/news/release-1",
      },
      fetchedAt: "2026-07-18T00:00:00Z",
      metadata: {
        bodyText: "Complete article body.",
        canonicalUrl: "https://agency.gov/news/release-1",
        publishedAt: "2026-06-01T00:00:00Z",
        summary: "Article summary",
        title: "Investigation Update",
      },
      newsSubtype: "agency_news",
      windowEnd: "2026-07-18T00:00:00Z",
      windowStart: "2025-07-18T00:00:00Z",
    });

    expect(normalized?.title).toBe("Investigation Update");
  });

  it("keeps complete summaries and cleaned article text without slicing", () => {
    const summary = `Summary ${"s".repeat(20_000)}`;
    const bodyText = `Article ${"b".repeat(24_000)}`;
    const normalized = normalizeCandidate({
      artifactKey: "news-backfill/raw.html",
      candidate: {
        bodyText: `<article><p>${bodyText}</p></article>`,
        externalItemId: "long-entry",
        publishedAt: "2026-06-01T00:00:00Z",
        rawBody: "",
        rawContentType: "text/html",
        sourceUrl: "https://agency.gov/feed",
        summary: `<p>${summary}</p>`,
        title: "Long report",
        url: "https://agency.gov/news/long-report",
      },
      fetchedAt: "2026-07-18T00:00:00Z",
      newsSubtype: "agency_news",
      windowEnd: "2026-07-18T00:00:00Z",
      windowStart: "2025-07-18T00:00:00Z",
    });

    expect(normalized?.summary).toBe(summary);
    expect(normalized?.summary).toHaveLength(summary.length);
    expect(normalized?.body_text).toBe(bodyText);
    expect(normalized?.body_text).toHaveLength(bodyText.length);
    expect(normalized?.extractor_version).toBe(4);
  });

  it("extracts the article body while removing government chrome and entities", () => {
    const metadata = extractArticleMetadata(
      `<html><head>
        <meta name="description" content="A concise &amp; useful summary." />
      </head><body>
        <header class="usa-banner"><p>An official website of the United States government</p></header>
        <nav><p>Topics and navigation</p></nav>
        <main><article>
          <h1>Agency report</h1>
          <p>The agency&rsquo;s first substantive paragraph.</p>
          <p>Second paragraph with <strong>important findings</strong>.</p>
          <aside><p>Share this page</p></aside>
        </article></main>
        <footer><p>Privacy and accessibility</p></footer>
      </body></html>`,
      "https://agency.gov/news/report",
    );

    expect(metadata.summary).toBe("A concise & useful summary.");
    expect(metadata.bodyText).toBe(
      "The agency’s first substantive paragraph. Second paragraph with important findings.",
    );
    expect(metadata.bodyText).not.toContain("official website");
    expect(metadata.bodyText).not.toContain("Share this page");
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
    const sec = extractArticleMetadata(
      `<h1>Market update</h1><div class="field--name-dynamic-twig-fieldnode-press-release-lead-in field__item"><p>Washington D.C., March 25, 2026 — </p></div>`,
      "https://www.sec.gov/newsroom/press-releases/2026-57",
    );

    expect(treasury.publishedAt).toBe("2026-07-15T20:15:00.000Z");
    expect(fsa.publishedAt?.slice(0, 10)).toBe("2025-07-18");
    expect(nps.publishedAt?.slice(0, 10)).toBe("2026-06-24");
    expect(state.publishedAt?.slice(0, 10)).toBe("2026-07-17");
    expect(sec.publishedAt?.slice(0, 10)).toBe("2026-03-25");
  });

  it("reads Dublin Core creation dates from National Weather Service pages", () => {
    const metadata = extractArticleMetadata(
      `<html><head>
        <meta name="DC.date.created" scheme="ISO8601" content="March 31st 2026 11:30 AM" />
      </head><body><h1>Service update</h1></body></html>`,
      "https://www.weather.gov/news/service-update",
    );

    expect(metadata.publishedAt?.slice(0, 10)).toBe("2026-03-31");
  });

  it("prefers CDC's first-published date over later update metadata", () => {
    const metadata = extractArticleMetadata(
      `<html><head>
        <meta property="cdc:first_published" content="April 23, 2026" />
        <meta name="DC.date" content="2026-07-01T14:25:44Z" />
      </head><body><h1>Public health update</h1></body></html>`,
      "https://www.cdc.gov/media/releases/2026/public-health-update.html",
    );

    expect(metadata.publishedAt?.slice(0, 10)).toBe("2026-04-23");
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

  it("extracts dates and titles from chain-rich alert publishers", () => {
    const csb = extractArticleMetadata(
      `<html><head><title>CSB Issues Investigation Update</title>
       <script type="application/ld+json">{"@type":"NewsArticle","articleBody":"Page last reviewed."}</script>
       </head><body><form id="main">
       <div class="content" itemprop="text"><p>Washington, D.C. July 14, 2026 — Today the CSB released an update.</p></div>
       </form></body></html>`,
      "https://www.csb.gov/investigation-update/",
    );
    const ntsb = extractArticleMetadata(
      `<html><head><title>Rail Investigation Update</title></head><body>
       <form id="aspnetForm"><div class="ms-rtestate-field"><p>WASHINGTON (June 11, 2026) — The NTSB issued findings and a detailed series of safety recommendations for hazardous-material tank cars.</p></div></form>
       </body></html>`,
      "https://www.ntsb.gov/news/press-releases/Pages/NR20260611.aspx",
    );
    const cftc = extractArticleMetadata(
      `<html><head><meta name="twitter:title" content="CFTC Resolves Enforcement Action" /></head><body>
       <div class="press-release"><h1 class="press-release-title">Release Number 9256-26</h1>
       <h1>CFTC Resolves Enforcement Action</h1><p><b>June 18, 2026</b></p></div>
       </body></html>`,
      "https://www.cftc.gov/PressRoom/PressReleases/9256-26",
    );
    const osha = extractArticleMetadata(
      `<html><head><title>Department cites employers | Occupational Safety and Health Administration</title></head><body>
       <div class="field--name-body"><p>Transition notice.</p></div>
       <div class="field--name-field-press-body"><p>February 18, 2026</p>
       <h4>Department cites employers after explosion</h4><p>Substantive inspection findings.</p></div>
       </body></html>`,
      "https://www.osha.gov/news/newsreleases/philadelphia/20260218",
    );
    const texas = extractArticleMetadata(
      `<h1>Major Disaster Declaration</h1><p class="meta">July 17, 2026 | Uvalde, Texas | Press Release</p>`,
      "https://gov.texas.gov/news/post/major-disaster-declaration",
    );

    expect(csb.publishedAt?.slice(0, 10)).toBe("2026-07-14");
    expect(csb.bodyText).toContain("Today the CSB released an update");
    expect(ntsb.publishedAt?.slice(0, 10)).toBe("2026-06-11");
    expect(ntsb.bodyText).toContain("The NTSB issued findings");
    expect(cftc.title).toBe("CFTC Resolves Enforcement Action");
    expect(cftc.publishedAt?.slice(0, 10)).toBe("2026-06-18");
    expect(osha.publishedAt?.slice(0, 10)).toBe("2026-02-18");
    expect(osha.bodyText).toContain("Substantive inspection findings");
    expect(osha.bodyText).not.toContain("Transition notice");
    expect(texas.publishedAt?.slice(0, 10)).toBe("2026-07-17");
  });

  it("prefers an incident date in the headline over unrelated page times", () => {
    const metadata = extractArticleMetadata(
      `<title>News Elephant Fire Update 07-14-2026 | InciWeb</title>
       <main><p>Fire behavior and containment update.</p></main>
       <footer><time datetime="2026-07-18T00:00:00Z">Page reviewed</time></footer>`,
      "https://inciweb.wildfire.gov/node/328724",
    );

    expect(metadata.publishedAt).toBe("2026-07-14T00:00:00.000Z");
  });
});
