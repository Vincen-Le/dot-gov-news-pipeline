import { describe, expect, it } from "vitest";

import { extractFeedLinks } from "../src/discovery/extract-feed-links";

describe("standards-first feed autodiscovery", () => {
  it("extracts HTTP Link, alternate links, relative anchors, and landing pages", async () => {
    const html = new TextEncoder().encode(`
      <html><head>
        <link rel="alternate" type="application/atom+xml" href="/atom.xml">
      </head><body>
        <a href="/updates/rss">Subscribe</a>
        <a href="/press-releases">Press releases</a>
      </body></html>
    `);
    const result = await extractFeedLinks(
      html,
      new URL("https://agency.gov/news/"),
      '<https://feeds.example.net/agency.json>; rel="alternate"; type="application/feed+json"',
    );
    expect(result.feeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          discoveryMethod: "http_link",
          url: "https://feeds.example.net/agency.json",
        }),
        expect.objectContaining({
          discoveryMethod: "html_alternate",
          url: "https://agency.gov/atom.xml",
        }),
        expect.objectContaining({
          discoveryMethod: "anchor",
          url: "https://agency.gov/updates/rss",
        }),
      ]),
    );
    expect(result.landingPages).toContain("https://agency.gov/press-releases");
  });

  it("bounds and deduplicates candidates while parsing dense HTML", async () => {
    const links = Array.from(
      { length: 100 },
      (_, index) =>
        `<link rel="alternate" type="application/rss+xml" href="/feed-${index}.xml"><a href="/news-${index}">News</a>`,
    ).join("");
    const result = await extractFeedLinks(
      new TextEncoder().encode(`<html>${links}</html>`),
      new URL("https://agency.gov/"),
      null,
    );
    expect(result.feeds).toHaveLength(10);
    expect(result.landingPages).toHaveLength(3);
  });
});
