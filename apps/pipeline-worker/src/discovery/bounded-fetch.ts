import { DiscoveryBudgetError } from "./discovery-budget";
import type { DiscoveryBudget } from "./discovery-budget";
import { UnsafeUrlError, validatePublisherUrl } from "./url-safety";

export type PublisherFetchErrorCode =
  | "network_error"
  | "redirect_limit"
  | "redirect_loop"
  | "request_timeout"
  | "response_too_large";

export class PublisherFetchError extends Error {
  readonly code: PublisherFetchErrorCode;

  constructor(code: PublisherFetchErrorCode, message: string) {
    super(message);
    this.name = "PublisherFetchError";
    this.code = code;
  }
}

export interface BoundedFetchResult {
  body: Uint8Array;
  finalUrl: URL;
  headers: Headers;
  status: number;
}

export type PublisherFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface BoundedFetchOptions {
  budget: DiscoveryBudget;
  fetcher?: PublisherFetcher;
  maxBytes: number;
  maxRedirects: number;
  redirectAllowed?: (target: URL) => boolean;
  timeoutMs: number;
  userAgent: string;
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body !== null) {
    await response.body.cancel();
  }
}

async function readBoundedBody(
  response: Response,
  maximum: number,
  budget: DiscoveryBudget,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maximum
  ) {
    await cancelBody(response);
    throw new PublisherFetchError(
      "response_too_large",
      "Publisher response exceeded the byte limit",
    );
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      budget.remainingMs();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      budget.observeResponseBytes(total);
      if (total > maximum) {
        await reader.cancel("response_too_large");
        throw new PublisherFetchError(
          "response_too_large",
          "Publisher response exceeded the byte limit",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (
      error instanceof PublisherFetchError ||
      error instanceof DiscoveryBudgetError
    ) {
      throw error;
    }
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new PublisherFetchError(
        "request_timeout",
        "Publisher response body timed out",
      );
    }
    throw new PublisherFetchError(
      "network_error",
      "Publisher response body failed",
    );
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function boundedFetch(
  input: string | URL,
  options: BoundedFetchOptions,
): Promise<BoundedFetchResult> {
  const fetcher = options.fetcher ?? fetch;
  let current = validatePublisherUrl(input);
  const visited = new Set<string>();

  for (let redirectCount = 0; ; redirectCount += 1) {
    if (visited.has(current.href)) {
      throw new PublisherFetchError(
        "redirect_loop",
        "Publisher redirect loop detected",
      );
    }
    visited.add(current.href);
    options.budget.consumeRequest();

    const timeout = Math.min(options.timeoutMs, options.budget.remainingMs());
    let response: Response;
    try {
      response = await fetcher(current, {
        headers: {
          Accept:
            "text/html, application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, */*;q=0.1",
          "User-Agent": options.userAgent,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (error instanceof DiscoveryBudgetError) throw error;
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new PublisherFetchError(
          "request_timeout",
          "Publisher request timed out",
        );
      }
      throw new PublisherFetchError(
        "network_error",
        "Publisher request failed",
      );
    }

    if (response.status >= 300 && response.status <= 399) {
      const location = response.headers.get("location");
      if (location !== null) {
        await cancelBody(response);
        if (redirectCount >= options.maxRedirects) {
          throw new PublisherFetchError(
            "redirect_limit",
            "Publisher redirect limit exceeded",
          );
        }
        const target = validatePublisherUrl(location, current);
        if (options.redirectAllowed?.(target) === false) {
          throw new UnsafeUrlError(
            "Publisher redirect target is outside the allowed domain",
          );
        }
        current = target;
        continue;
      }
    }

    return {
      body: await readBoundedBody(response, options.maxBytes, options.budget),
      finalUrl: current,
      headers: response.headers,
      status: response.status,
    };
  }
}
