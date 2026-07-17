import { describe, expect, it, vi } from "vitest";

import type { PublisherFetcher } from "../src/discovery/bounded-fetch";
import {
  discoverSiteFeeds,
  type SiteDiscoveryFailure,
} from "../src/discovery/discover-site-feeds";

const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Agency News</title><link>https://agency.gov/news</link><description>News</description></channel></rss>`;

function urlOf(input: RequestInfo | URL): string {
  return input instanceof URL ? input.href : String(input);
}

describe("discoverSiteFeeds", () => {
  it("discovers an explicitly linked external feed and preserves provenance", async () => {
    const fetcher = vi.fn<PublisherFetcher>(async (input) => {
      const url = urlOf(input);
      if (url === "https://agency.gov/") {
        return new Response(
          '<html><head><link rel="alternate" type="application/rss+xml" href="https://feeds.example.net/agency.xml"></head></html>',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url === "https://feeds.example.net/agency.xml") {
        return new Response(rss, {
          headers: { "content-type": "application/rss+xml" },
        });
      }
      return new Response("missing", { status: 404 });
    });

    const result = await discoverSiteFeeds({
      baseDomain: "agency.gov",
      fetcher,
      initialUrl: "agency.gov",
      maxPublisherRequests: 36,
      siteDeadlineMs: 60_000,
      userAgent: "dot-gov-news-pipeline/1 (+ops@example.gov)",
    });

    expect(result.result).toBe("succeeded");
    expect(result.feeds).toEqual([
      expect.objectContaining({
        canonicalUrl: "https://feeds.example.net/agency.xml",
        discoveryMethod: "html_alternate",
        discoveryUrl: "https://feeds.example.net/agency.xml",
        feedType: "rss",
      }),
    ]);
    expect(result.requestCount).toBeLessThanOrEqual(36);
  });

  it("uses bounded conventional paths only on the official site", async () => {
    const fetcher = vi.fn<PublisherFetcher>(async (input) => {
      const url = urlOf(input);
      if (url === "https://agency.gov/") {
        return new Response("<html><body>No feed link</body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://agency.gov/rss.xml") return new Response(rss);
      return new Response("missing", { status: 404 });
    });
    const result = await discoverSiteFeeds({
      baseDomain: "agency.gov",
      fetcher,
      initialUrl: "agency.gov",
      maxPublisherRequests: 36,
      siteDeadlineMs: 60_000,
      userAgent: "dot-gov-news-pipeline/1 (+ops@example.gov)",
    });
    expect(result.feeds).toEqual([
      expect.objectContaining({
        canonicalUrl: "https://agency.gov/rss.xml",
        discoveryMethod: "conventional_path",
      }),
    ]);
    expect(
      fetcher.mock.calls.every(([input]) =>
        ["agency.gov", "feeds.example.net"].includes(
          new URL(urlOf(input)).hostname,
        ),
      ),
    ).toBe(true);
  });

  it("tries official conventional paths after a non-HTML root response", async () => {
    const fetcher = vi.fn<PublisherFetcher>(async (input) => {
      const url = urlOf(input);
      if (url === "https://agency.gov/") {
        return new Response("This site requires a browser", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://agency.gov/rss.xml") return new Response(rss);
      return new Response("missing", { status: 404 });
    });
    const result = await discoverSiteFeeds({
      baseDomain: "agency.gov",
      fetcher,
      initialUrl: "agency.gov",
      maxPublisherRequests: 36,
      siteDeadlineMs: 60_000,
      userAgent: "dot-gov-news-pipeline/1 (+ops@example.gov)",
    });
    expect(result.result).toBe("succeeded");
    expect(result.feeds[0]?.canonicalUrl).toBe("https://agency.gov/rss.xml");
  });

  it("discovers an HTTP Link feed on a non-HTML root response", async () => {
    const fetcher = vi.fn<PublisherFetcher>(async (input) => {
      const url = urlOf(input);
      if (url === "https://agency.gov/") {
        return new Response("This site requires a browser", {
          headers: {
            "content-type": "text/plain",
            link: '<https://feeds.example.net/agency.xml>; rel="alternate"; type="application/rss+xml"',
          },
        });
      }
      if (url === "https://feeds.example.net/agency.xml") {
        return new Response(rss);
      }
      return new Response("missing", { status: 404 });
    });
    const result = await discoverSiteFeeds({
      baseDomain: "agency.gov",
      fetcher,
      initialUrl: "agency.gov",
      maxPublisherRequests: 36,
      siteDeadlineMs: 60_000,
      userAgent: "dot-gov-news-pipeline/1 (+ops@example.gov)",
    });
    expect(result.feeds).toEqual([
      expect.objectContaining({
        canonicalUrl: "https://feeds.example.net/agency.xml",
        discoveryMethod: "http_link",
      }),
    ]);
  });

  it("rejects root redirects outside the inventory base domain", async () => {
    const fetcher = vi.fn<PublisherFetcher>(async (input) => {
      if (urlOf(input) === "https://agency.gov/") {
        return new Response(null, {
          headers: { location: "https://attacker.example/" },
          status: 302,
        });
      }
      return new Response("should not be fetched");
    });
    await expect(
      discoverSiteFeeds({
        baseDomain: "agency.gov",
        fetcher,
        initialUrl: "agency.gov",
        maxPublisherRequests: 36,
        siteDeadlineMs: 60_000,
        userAgent: "dot-gov-news-pipeline/1 (+ops@example.gov)",
      }),
    ).rejects.toMatchObject({ code: "unsafe_root_url" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("resolves safe feed home pages and drops unsafe metadata", async () => {
    const fetcher = vi.fn<PublisherFetcher>(async (input) => {
      const url = urlOf(input);
      if (url === "https://agency.gov/") {
        return new Response(
          '<html><link rel="alternate" type="application/rss+xml" href="/safe.xml"><link rel="alternate" type="application/rss+xml" href="/unsafe.xml"></html>',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url === "https://agency.gov/safe.xml") {
        return new Response(
          rss.replace("https://agency.gov/news", "/relative-home"),
        );
      }
      if (url === "https://agency.gov/unsafe.xml") {
        return new Response(
          rss.replace("https://agency.gov/news", "javascript:alert(1)"),
        );
      }
      return new Response("missing", { status: 404 });
    });
    const result = await discoverSiteFeeds({
      baseDomain: "agency.gov",
      fetcher,
      initialUrl: "agency.gov",
      maxPublisherRequests: 36,
      siteDeadlineMs: 60_000,
      userAgent: "dot-gov-news-pipeline/1 (+ops@example.gov)",
    });
    expect(result.feeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalUrl: "https://agency.gov/safe.xml",
          homePageUrl: "https://agency.gov/relative-home",
        }),
        expect.objectContaining({
          canonicalUrl: "https://agency.gov/unsafe.xml",
          homePageUrl: null,
        }),
      ]),
    );
  });

  it("does not follow landing or guessed-path redirects outside the base domain", async () => {
    const fetcher = vi.fn<PublisherFetcher>(async (input) => {
      const url = urlOf(input);
      if (url === "https://agency.gov/") {
        return new Response('<html><a href="/news">News</a></html>', {
          headers: { "content-type": "text/html" },
        });
      }
      if (
        url === "https://agency.gov/news" ||
        url === "https://agency.gov/feed"
      ) {
        return new Response(null, {
          headers: { location: "https://external.example/feed" },
          status: 302,
        });
      }
      return new Response("missing", { status: 404 });
    });
    const result = await discoverSiteFeeds({
      baseDomain: "agency.gov",
      fetcher,
      initialUrl: "agency.gov",
      maxPublisherRequests: 36,
      siteDeadlineMs: 60_000,
      userAgent: "dot-gov-news-pipeline/1 (+ops@example.gov)",
    });
    expect(result.result).toBe("no_feed");
    expect(
      fetcher.mock.calls.some(
        ([input]) => new URL(urlOf(input)).hostname === "external.example",
      ),
    ).toBe(false);
  });

  it("marks a transient selected candidate failure as a partial scan", async () => {
    const fetcher = vi.fn<PublisherFetcher>(async (input) => {
      const url = urlOf(input);
      if (url === "https://agency.gov/") {
        return new Response(
          '<html><link rel="alternate" type="application/rss+xml" href="/feed.xml"></html>',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url === "https://agency.gov/feed.xml") {
        return new Response("unavailable", { status: 503 });
      }
      return new Response("missing", { status: 404 });
    });
    await expect(
      discoverSiteFeeds({
        baseDomain: "agency.gov",
        fetcher,
        initialUrl: "agency.gov",
        maxPublisherRequests: 36,
        siteDeadlineMs: 60_000,
        userAgent: "dot-gov-news-pipeline/1 (+ops@example.gov)",
      }),
    ).rejects.toMatchObject({
      code: "publisher_http_5xx",
    } satisfies Partial<SiteDiscoveryFailure>);
  });

  it("falls back to HTTP only after an HTTPS network failure", async () => {
    const fetcher = vi.fn<PublisherFetcher>(async (input) => {
      const url = urlOf(input);
      if (url.startsWith("https://")) throw new TypeError("TLS failure");
      return new Response(rss);
    });
    const result = await discoverSiteFeeds({
      baseDomain: "agency.gov",
      fetcher,
      initialUrl: "agency.gov",
      maxPublisherRequests: 36,
      siteDeadlineMs: 60_000,
      userAgent: "dot-gov-news-pipeline/1 (+ops@example.gov)",
    });
    expect(result.result).toBe("succeeded");
    expect(fetcher.mock.calls.map(([input]) => urlOf(input))).toEqual([
      "https://agency.gov/",
      "http://agency.gov/",
    ]);
  });
});
