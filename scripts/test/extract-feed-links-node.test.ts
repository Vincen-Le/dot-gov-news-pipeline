import { describe, expect, it } from "vitest";

import { extractFeedLinksNode } from "../lib/extract-feed-links-node";

describe("extractFeedLinksNode", () => {
  it("extracts HTTP, alternate, anchor, and landing-page links", async () => {
    const body = new TextEncoder().encode(`
      <html><head>
        <link rel="ALTERNATE stylesheet" type="application/rss+xml; charset=utf-8" href="/rss.xml">
      </head><body>
        <a href="/atom.xml">Subscribe to our Atom feed</a>
        <a href="/news">Agency news</a>
        <a href="javascript:alert(1)">RSS</a>
      </body></html>
    `);

    const result = await extractFeedLinksNode(
      body,
      new URL("https://agency.gov/"),
      '<https://agency.gov/http-feed>; rel="alternate"; type="application/feed+json"',
    );

    expect(result.feeds).toEqual([
      {
        discoveryMethod: "http_link",
        discoveryUrl: "https://agency.gov/http-feed",
        url: "https://agency.gov/http-feed",
      },
      {
        discoveryMethod: "html_alternate",
        discoveryUrl: "https://agency.gov/rss.xml",
        url: "https://agency.gov/rss.xml",
      },
      {
        discoveryMethod: "anchor",
        discoveryUrl: "https://agency.gov/atom.xml",
        url: "https://agency.gov/atom.xml",
      },
    ]);
    expect(result.landingPages).toEqual(["https://agency.gov/news"]);
  });

  it("deduplicates links and enforces collection bounds", async () => {
    const anchors = Array.from(
      { length: 20 },
      (_value, index) => `<a href="/feed-${index}">RSS feed ${index}</a>`,
    ).join("");
    const body = new TextEncoder().encode(
      `<a href="/feed-0">RSS duplicate</a>${anchors}`,
    );

    const result = await extractFeedLinksNode(
      body,
      new URL("https://agency.gov/"),
      null,
    );

    expect(result.feeds).toHaveLength(10);
    expect(new Set(result.feeds.map((feed) => feed.url))).toHaveLength(10);
  });
});
