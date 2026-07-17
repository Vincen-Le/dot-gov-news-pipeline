import { describe, expect, it } from "vitest";

import {
  isWithinBaseDomain,
  validatePublisherUrl,
} from "../src/discovery/url-safety";

describe("publisher URL safety", () => {
  it("normalizes safe HTTP URLs and strips fragments", () => {
    expect(
      validatePublisherUrl("HTTPS://Agency.GOV:443/news?q=1#fragment").href,
    ).toBe("https://agency.gov/news?q=1");
  });

  it.each([
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://metadata.google.internal/",
    "http://localhost/",
    "http://agency.gov:8080/",
    "https://user:pass@agency.gov/",
    "file:///etc/passwd",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => validatePublisherUrl(url)).toThrow();
  });

  it("resolves relative links and checks base-domain containment", () => {
    const url = validatePublisherUrl(
      "../feed.xml",
      "https://news.agency.gov/releases/",
    );
    expect(url.href).toBe("https://news.agency.gov/feed.xml");
    expect(isWithinBaseDomain(url.hostname, "agency.gov")).toBe(true);
    expect(isWithinBaseDomain("notagency.gov", "agency.gov")).toBe(false);
  });
});
