import { describe, expect, it } from "vitest";

import { classifyProbe, probePlan } from "./probe";

describe("probePlan", () => {
  it("derives one URL per structured-source check", () => {
    const plan = probePlan("https://www.noaa.gov");
    expect(plan).toEqual([
      {
        kind: "wordpress",
        url: "https://www.noaa.gov/wp-json/wp/v2/posts?per_page=1",
      },
      { kind: "drupal", url: "https://www.noaa.gov/jsonapi" },
      {
        kind: "news_sitemap",
        url: "https://www.noaa.gov/sitemap-news.xml",
      },
      {
        kind: "news_sitemap",
        url: "https://www.noaa.gov/news-sitemap.xml",
      },
      { kind: "robots", url: "https://www.noaa.gov/robots.txt" },
    ]);
  });
});

describe("classifyProbe", () => {
  it("confirms WordPress only for a JSON array of post-shaped items", () => {
    const check = {
      kind: "wordpress" as const,
      url: "https://a.gov/wp-json/wp/v2/posts?per_page=1",
    };
    const post =
      '[{"id":1,"link":"https://a.gov/news/a","date_gmt":"2026-06-01T00:00:00"}]';
    expect(classifyProbe(check, 200, "application/json", post).verdict).toBe(
      "available",
    );
    expect(classifyProbe(check, 200, "application/json", "[]").verdict).toBe(
      "unavailable",
    );
    expect(
      classifyProbe(check, 200, "text/html", "<html></html>").verdict,
    ).toBe("unavailable");
    expect(classifyProbe(check, 404, "application/json", "{}").verdict).toBe(
      "unavailable",
    );
  });

  it("confirms Drupal JSON:API and lists node collections", () => {
    const check = { kind: "drupal" as const, url: "https://a.gov/jsonapi" };
    const body =
      '{"jsonapi":{"version":"1.0"},"links":{"node--news":{"href":"https://a.gov/jsonapi/node/news"},"self":{"href":"https://a.gov/jsonapi"}}}';
    const result = classifyProbe(check, 200, "application/vnd.api+json", body);
    expect(result.verdict).toBe("available");
    expect(result.detail).toBe("node--news");
  });

  it("rejects a Drupal entry point with no usable node collections", () => {
    const check = { kind: "drupal" as const, url: "https://a.gov/jsonapi" };
    const body =
      '{"jsonapi":{"version":"1.0"},"data":[],"links":{"self":{"href":"https://a.gov/jsonapi"}}}';
    const result = classifyProbe(check, 200, "application/vnd.api+json", body);
    expect(result).toEqual({
      detail: "no node links",
      verdict: "unavailable",
    });
  });

  it("confirms a news sitemap from the Google News namespace", () => {
    const check = {
      kind: "news_sitemap" as const,
      url: "https://a.gov/sitemap-news.xml",
    };
    const body =
      '<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url/></urlset>';
    expect(classifyProbe(check, 200, "application/xml", body).verdict).toBe(
      "available",
    );
    expect(
      classifyProbe(check, 200, "application/xml", "<urlset/>").verdict,
    ).toBe("unavailable");
  });

  it("extracts sitemap declarations from robots.txt", () => {
    const check = {
      kind: "robots" as const,
      url: "https://a.gov/robots.txt",
    };
    const body =
      "User-agent: *\nSitemap: https://a.gov/sitemap.xml\nSitemap: https://a.gov/sitemap-news.xml\n";
    const result = classifyProbe(check, 200, "text/plain", body);
    expect(result.verdict).toBe("available");
    expect(result.detail).toBe(
      "https://a.gov/sitemap.xml, https://a.gov/sitemap-news.xml",
    );
  });
});
