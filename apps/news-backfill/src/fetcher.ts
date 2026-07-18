import { setTimeout as delay } from "node:timers/promises";

export interface FetchedDocument {
  body: string;
  contentType: string;
  finalUrl: string;
  status: number;
}

export interface FetcherOptions {
  minimumHostIntervalMs?: number;
  timeoutMs?: number;
  userAgent: string;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function isPublisherChallenge(body: string, contentType: string): boolean {
  if (!contentType.toLowerCase().includes("html") && !/^\s*</.test(body))
    return false;
  const normalized = body.toLowerCase();
  return [
    "<title>access denied</title>",
    "you don't have permission to access",
    "bm-verify",
    "apology_objects/interstitial",
    "request unsuccessful. incapsula incident id",
  ].some((marker) => normalized.includes(marker));
}

function hostAllowed(url: URL, allowedHosts: string[]): boolean {
  const hostname = url.hostname.toLowerCase();
  return allowedHosts.some((allowedHost) => {
    const normalized = allowedHost.toLowerCase();
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

export function createFetcher(options: FetcherOptions) {
  const lastRequestAt = new Map<string, number>();
  const minimumInterval = options.minimumHostIntervalMs ?? 750;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return async function fetchDocument(
    input: string,
    allowedHosts: string[],
  ): Promise<FetchedDocument> {
    const requestedUrl = new URL(input);
    if (
      requestedUrl.protocol !== "https:" ||
      !hostAllowed(requestedUrl, allowedHosts)
    ) {
      throw new Error(`unsafe or unapproved URL: ${requestedUrl.href}`);
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const previous = lastRequestAt.get(requestedUrl.hostname) ?? 0;
      const waitMs = Math.max(0, minimumInterval - (Date.now() - previous));
      if (waitMs > 0) await delay(waitMs);
      lastRequestAt.set(requestedUrl.hostname, Date.now());

      try {
        const response = await fetch(requestedUrl, {
          headers: {
            accept:
              "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.5",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": options.userAgent,
          },
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const finalUrl = new URL(response.url);
        if (!hostAllowed(finalUrl, allowedHosts)) {
          throw new Error(`redirect escaped approved hosts: ${finalUrl.href}`);
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!response.ok && !retryable) {
          throw new Error(`publisher returned HTTP ${response.status}`);
        }
        if (retryable) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await delay(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 60_000)
              : Math.min(2 ** attempt * 1000, 30_000),
          );
          continue;
        }

        const declaredLength = Number(response.headers.get("content-length"));
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_BODY_BYTES
        ) {
          throw new Error(`publisher body exceeds ${MAX_BODY_BYTES} bytes`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_BODY_BYTES) {
          throw new Error(`publisher body exceeds ${MAX_BODY_BYTES} bytes`);
        }
        const body = new TextDecoder().decode(bytes);
        const contentType =
          response.headers.get("content-type") ?? "application/octet-stream";
        if (isPublisherChallenge(body, contentType)) {
          throw new Error(`publisher anti-bot challenge at ${finalUrl.href}`);
        }
        return {
          body,
          contentType,
          finalUrl: finalUrl.href,
          status: response.status,
        };
      } catch (error) {
        lastError = error;
        if (
          error instanceof Error &&
          [
            "anti-bot challenge",
            "redirect escaped approved hosts",
            "publisher returned HTTP",
            "publisher body exceeds",
          ].some((message) => error.message.includes(message))
        ) {
          break;
        }
        if (attempt < 5) await delay(Math.min(2 ** attempt * 750, 15_000));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}
