import { afterEach, describe, expect, it, vi } from "vitest";

import { createFetcher } from "./fetcher";

afterEach(() => vi.unstubAllGlobals());

describe("publisher fetcher", () => {
  it("exposes WordPress pagination metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = new Response("[]", {
          headers: { "x-wp-totalpages": "13" },
          status: 200,
        });
        Object.defineProperty(response, "url", {
          value: "https://agency.gov/wp-json/wp/v2/posts",
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
      fetchDocument("https://agency.gov/wp-json/wp/v2/posts", ["agency.gov"]),
    ).resolves.toMatchObject({ totalPages: 13 });
  });

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
      nativeWayback: false,
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

  it("retries transient Wayback 403 responses", async () => {
    const mockedFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        const response = new Response("temporarily throttled", {
          headers: { "retry-after": "0.001" },
          status: 403,
        });
        Object.defineProperty(response, "url", {
          value: "https://web.archive.org/web/example",
        });
        return response;
      })
      .mockImplementationOnce(async () => {
        const response = new Response("archived article", { status: 200 });
        Object.defineProperty(response, "url", {
          value: "https://web.archive.org/web/example",
        });
        return response;
      });
    vi.stubGlobal("fetch", mockedFetch);
    const fetchDocument = createFetcher({
      minimumHostIntervalMs: 0,
      nativeWayback: false,
      timeoutMs: 1_000,
      userAgent: "test",
    });

    await expect(
      fetchDocument("https://web.archive.org/web/example", ["web.archive.org"]),
    ).resolves.toMatchObject({ body: "archived article", status: 200 });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});
