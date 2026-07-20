import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFetcher, decodeResponseBody } from "../src/fetcher";

afterEach(() => vi.unstubAllGlobals());

describe("publisher fetcher", () => {
  it("decodes compressed archive responses", () => {
    expect(decodeResponseBody(gzipSync("archived article"), "gzip")).toBe(
      "archived article",
    );
  });

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

  it("spaces concurrent requests to the same publisher host", async () => {
    const startedAt: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        startedAt.push(Date.now());
        const response = new Response("ok", { status: 200 });
        Object.defineProperty(response, "url", { value: String(input) });
        return response;
      }),
    );
    const fetchDocument = createFetcher({
      minimumHostIntervalMs: 25,
      timeoutMs: 1_000,
      userAgent: "test",
    });

    await Promise.all([
      fetchDocument("https://agency.gov/news/1", ["agency.gov"]),
      fetchDocument("https://agency.gov/news/2", ["agency.gov"]),
      fetchDocument("https://agency.gov/news/3", ["agency.gov"]),
    ]);

    expect(startedAt).toHaveLength(3);
    expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(
      20,
    );
    expect((startedAt[2] ?? 0) - (startedAt[1] ?? 0)).toBeGreaterThanOrEqual(
      20,
    );
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
