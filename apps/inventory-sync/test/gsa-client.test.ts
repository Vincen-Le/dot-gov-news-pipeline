import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { downloadGsaSnapshot } from "../src/gsa-client";

describe("GSA snapshot download", () => {
  it("downloads with conditional headers and calculates a checksum", async () => {
    const body = "initial_url\nagency.gov\n";
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        headers: {
          "content-length": String(Buffer.byteLength(body)),
          etag: '"snapshot-etag"',
        },
      }),
    );

    const snapshot = await downloadGsaSnapshot({
      etag: '"previous-etag"',
      fetchImpl,
      sourceUrl: "https://example.gov/inventory.csv",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://example.gov/inventory.csv"),
      expect.objectContaining({
        headers: expect.any(Headers),
        redirect: "follow",
      }),
    );
    const requestHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
    expect(requestHeaders.get("if-none-match")).toBe('"previous-etag"');
    expect(snapshot.kind).toBe("downloaded");
    if (snapshot.kind === "downloaded") {
      expect(await readFile(snapshot.filePath, "utf8")).toBe(body);
      expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
      await snapshot.cleanup();
    }
  });

  it("handles an HTTP 304 without creating a file", async () => {
    const snapshot = await downloadGsaSnapshot({
      etag: '"previous-etag"',
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 304 })),
      sourceUrl: "https://example.gov/inventory.csv",
    });

    expect(snapshot).toEqual({
      etag: '"previous-etag"',
      kind: "not_modified",
    });
  });

  it("rejects oversized responses before reading the body", async () => {
    await expect(
      downloadGsaSnapshot({
        fetchImpl: vi.fn().mockResolvedValue(
          new Response("small", {
            headers: { "content-length": "100" },
          }),
        ),
        maxResponseBytes: 10,
        sourceUrl: "https://example.gov/inventory.csv",
      }),
    ).rejects.toThrow("size limit");
  });

  it("rejects non-HTTPS sources", async () => {
    await expect(
      downloadGsaSnapshot({
        sourceUrl: "http://example.gov/inventory.csv",
      }),
    ).rejects.toThrow("HTTPS");
  });
});
