import { describe, expect, it, vi } from "vitest";

import {
  boundedFetch,
  type PublisherFetchError,
  type PublisherFetcher,
} from "../src/discovery/bounded-fetch";
import { DiscoveryBudget } from "../src/discovery/discovery-budget";

function options(fetcher: PublisherFetcher, maxBytes = 1_024) {
  return {
    budget: new DiscoveryBudget(36, 10_000),
    fetcher,
    maxBytes,
    maxRedirects: 5,
    timeoutMs: 1_000,
    userAgent: "dot-gov-news-pipeline/1 (+ops@example.gov)",
  };
}

describe("boundedFetch", () => {
  it("follows and validates manual redirects while counting every hop", async () => {
    const fetcher = vi.fn<PublisherFetcher>(async (input) => {
      const url = String(input);
      return url.endsWith("/start")
        ? new Response(null, {
            headers: { location: "/final" },
            status: 302,
          })
        : new Response("ok", { status: 200 });
    });
    const boundedOptions = options(fetcher);
    const response = await boundedFetch(
      "https://agency.gov/start",
      boundedOptions,
    );
    expect(response.finalUrl.href).toBe("https://agency.gov/final");
    expect(new TextDecoder().decode(response.body)).toBe("ok");
    expect(boundedOptions.budget.requestCount).toBe(2);
  });

  it("rejects unsafe redirect targets before fetching them", async () => {
    const fetcher = vi.fn<PublisherFetcher>().mockResolvedValue(
      new Response(null, {
        headers: { location: "http://127.0.0.1/secret" },
        status: 302,
      }),
    );
    await expect(
      boundedFetch("https://agency.gov/start", options(fetcher)),
    ).rejects.toThrow(/Non-public/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("applies a caller domain policy before following a safe redirect", async () => {
    const fetcher = vi.fn<PublisherFetcher>().mockResolvedValue(
      new Response(null, {
        headers: { location: "https://external.example/feed" },
        status: 302,
      }),
    );
    await expect(
      boundedFetch("https://agency.gov/start", {
        ...options(fetcher),
        redirectAllowed: (target) => target.hostname.endsWith(".gov"),
      }),
    ).rejects.toThrow(/outside the allowed domain/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects oversized content-length before buffering", async () => {
    const fetcher = vi.fn<PublisherFetcher>().mockResolvedValue(
      new Response("too large", {
        headers: { "content-length": "10000" },
      }),
    );
    await expect(
      boundedFetch("https://agency.gov/feed", options(fetcher, 10)),
    ).rejects.toMatchObject({
      code: "response_too_large",
    } satisfies Partial<PublisherFetchError>);
  });

  it("cancels a streamed body at the byte boundary", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
      },
    });
    const fetcher = vi
      .fn<PublisherFetcher>()
      .mockResolvedValue(new Response(stream));
    await expect(
      boundedFetch("https://agency.gov/feed", options(fetcher, 10)),
    ).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancel).toHaveBeenCalled();
  });

  it("classifies a body-stream abort as a request timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("timed out", "TimeoutError"));
      },
    });
    const fetcher = vi
      .fn<PublisherFetcher>()
      .mockResolvedValue(new Response(stream));
    await expect(
      boundedFetch("https://agency.gov/feed", options(fetcher)),
    ).rejects.toMatchObject({ code: "request_timeout" });
  });
});
