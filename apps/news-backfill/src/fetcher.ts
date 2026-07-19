import { get } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export interface FetchedDocument {
  body: string;
  contentType: string;
  finalUrl: string;
  status: number;
  totalPages?: number;
}

export interface FetcherOptions {
  minimumHostIntervalMs?: number;
  nativeWayback?: boolean;
  timeoutMs?: number;
  userAgent: string;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export function decodeResponseBody(
  body: Buffer,
  contentEncoding: string | undefined,
): string {
  const encoding = contentEncoding?.split(",")[0]?.trim().toLowerCase();
  const decoded =
    encoding === "gzip"
      ? gunzipSync(body)
      : encoding === "deflate"
        ? inflateSync(body)
        : encoding === "br"
          ? brotliDecompressSync(body)
          : body;
  if (decoded.byteLength > MAX_BODY_BYTES)
    throw new Error(`publisher body exceeds ${MAX_BODY_BYTES} bytes`);
  return decoded.toString("utf8");
}

interface RawDocument extends FetchedDocument {
  retryAfter: number;
}

function isPublisherChallenge(body: string, contentType: string): boolean {
  if (!contentType.toLowerCase().includes("html") && !/^\s*</.test(body))
    return false;
  const normalized = body.toLowerCase();
  return [
    "<title>access denied</title>",
    "<title>technical difficulties</title>",
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

function fetchViaHttps(
  url: URL,
  allowedHosts: string[],
  headers: Record<string, string>,
  timeoutMs: number,
  redirects = 0,
): Promise<RawDocument> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers, timeout: timeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location !== undefined) {
        response.resume();
        if (redirects >= 5) {
          reject(new Error("publisher redirect limit exceeded"));
          return;
        }
        const redirected = new URL(location, url);
        if (
          redirected.protocol !== "https:" ||
          !hostAllowed(redirected, allowedHosts)
        ) {
          reject(
            new Error(`redirect escaped approved hosts: ${redirected.href}`),
          );
          return;
        }
        resolve(
          fetchViaHttps(
            redirected,
            allowedHosts,
            headers,
            timeoutMs,
            redirects + 1,
          ),
        );
        return;
      }

      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        response.destroy();
        reject(new Error(`publisher body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > MAX_BODY_BYTES) {
          response.destroy(
            new Error(`publisher body exceeds ${MAX_BODY_BYTES} bytes`),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const contentTypeHeader = response.headers["content-type"];
          const retryAfterHeader = response.headers["retry-after"];
          const contentEncodingHeader = response.headers["content-encoding"];
          resolve({
            body: decodeResponseBody(
              Buffer.concat(chunks),
              typeof contentEncodingHeader === "string"
                ? contentEncodingHeader
                : undefined,
            ),
            contentType:
              typeof contentTypeHeader === "string"
                ? contentTypeHeader
                : "application/octet-stream",
            finalUrl: url.href,
            retryAfter:
              typeof retryAfterHeader === "string"
                ? Number(retryAfterHeader)
                : Number.NaN,
            status,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(
        new Error(`publisher request timed out after ${timeoutMs}ms`),
      );
    });
    request.on("error", reject);
  });
}

export function createFetcher(options: FetcherOptions) {
  const nextRequestAt = new Map<string, number>();
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
    const requestHeaders = {
      accept:
        "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.5",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": options.userAgent,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const now = Date.now();
      const requestAt = Math.max(
        now,
        nextRequestAt.get(requestedUrl.hostname) ?? now,
      );
      nextRequestAt.set(requestedUrl.hostname, requestAt + minimumInterval);
      const waitMs = Math.max(0, requestAt - now);
      if (waitMs > 0) await delay(waitMs);

      try {
        let document: RawDocument;
        if (
          requestedUrl.hostname === "web.archive.org" &&
          options.nativeWayback !== false
        ) {
          document = await fetchViaHttps(
            requestedUrl,
            allowedHosts,
            requestHeaders,
            timeoutMs,
          );
        } else {
          const response = await fetch(requestedUrl, {
            headers: requestHeaders,
            redirect: "follow",
            signal: AbortSignal.timeout(timeoutMs),
          });
          const bytes = new Uint8Array(await response.arrayBuffer());
          document = {
            body: new TextDecoder().decode(bytes),
            contentType:
              response.headers.get("content-type") ??
              "application/octet-stream",
            finalUrl: response.url,
            retryAfter: Number(response.headers.get("retry-after")),
            status: response.status,
            totalPages: (() => {
              const value = Number(response.headers.get("x-wp-totalpages"));
              return Number.isInteger(value) && value >= 0 ? value : undefined;
            })(),
          };
        }
        const finalUrl = new URL(document.finalUrl);
        if (!hostAllowed(finalUrl, allowedHosts)) {
          throw new Error(`redirect escaped approved hosts: ${finalUrl.href}`);
        }
        const retryable =
          document.status === 429 ||
          document.status >= 500 ||
          (document.status === 403 &&
            requestedUrl.hostname === "web.archive.org");
        const ok = document.status >= 200 && document.status < 300;
        if (!ok && !retryable) {
          throw new Error(`publisher returned HTTP ${document.status}`);
        }
        if (retryable) {
          await delay(
            Number.isFinite(document.retryAfter) && document.retryAfter > 0
              ? Math.min(document.retryAfter * 1000, 60_000)
              : Math.min(2 ** attempt * 1000, 30_000),
          );
          lastError = new Error(`publisher returned HTTP ${document.status}`);
          continue;
        }

        if (Buffer.byteLength(document.body) > MAX_BODY_BYTES) {
          throw new Error(`publisher body exceeds ${MAX_BODY_BYTES} bytes`);
        }
        if (isPublisherChallenge(document.body, document.contentType)) {
          throw new Error(`publisher anti-bot challenge at ${finalUrl.href}`);
        }
        return {
          body: document.body,
          contentType: document.contentType,
          finalUrl: finalUrl.href,
          status: document.status,
          totalPages: document.totalPages,
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
