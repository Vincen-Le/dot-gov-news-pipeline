import { afterEach, describe, expect, it, vi } from "vitest";

import { createFetcher } from "./fetcher";

afterEach(() => vi.unstubAllGlobals());

describe("publisher fetcher", () => {
  it("rejects successful-looking anti-bot challenge pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = new Response(
          "<html><title>Access Denied</title>You don't have permission to access</html>",
          { headers: { "content-type": "text/html" }, status: 200 },
        );
        Object.defineProperty(response, "url", {
          value: "https://agency.gov/news",
        });
        return response;
      }),
    );
    const fetchDocument = createFetcher({
      minimumHostIntervalMs: 0,
      timeoutMs: 1_000,
      userAgent: "test",
    });

    await expect(
      fetchDocument("https://agency.gov/news", ["agency.gov"]),
    ).rejects.toThrow("anti-bot challenge");
  });

  it("rejects redirects outside the publisher allowlist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = new Response("ok", { status: 200 });
        Object.defineProperty(response, "url", {
          value: "https://attacker.example/news",
        });
        return response;
      }),
    );
    const fetchDocument = createFetcher({
      minimumHostIntervalMs: 0,
      timeoutMs: 1_000,
      userAgent: "test",
    });

    await expect(
      fetchDocument("https://agency.gov/news", ["agency.gov"]),
    ).rejects.toThrow("redirect escaped approved hosts");
  });
});
