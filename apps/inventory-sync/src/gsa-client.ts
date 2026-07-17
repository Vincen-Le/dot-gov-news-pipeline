import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

const DEFAULT_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface DownloadedGsaSnapshot {
  bytes: number;
  cleanup(): Promise<void>;
  etag: string | null;
  filePath: string;
  kind: "downloaded";
  sha256: string;
}

export interface NotModifiedGsaSnapshot {
  etag: string | null;
  kind: "not_modified";
}

export type GsaSnapshotDownload =
  DownloadedGsaSnapshot | NotModifiedGsaSnapshot;

export interface DownloadGsaSnapshotOptions {
  etag?: string | null;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  sourceUrl: string;
  timeoutMs?: number;
}

class ResponseSizeLimiter extends Transform {
  readonly #hash = createHash("sha256");
  readonly #maximumBytes: number;
  #bytes = 0;

  constructor(maximumBytes: number) {
    super();
    this.#maximumBytes = maximumBytes;
  }

  get bytes(): number {
    return this.#bytes;
  }

  digest(): string {
    return this.#hash.digest("hex");
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > this.#maximumBytes) {
      callback(new Error("GSA response exceeds the configured size limit"));
      return;
    }

    this.#hash.update(chunk);
    callback(null, chunk);
  }
}

export async function downloadGsaSnapshot(
  options: DownloadGsaSnapshotOptions,
): Promise<GsaSnapshotDownload> {
  const sourceUrl = new URL(options.sourceUrl);
  if (sourceUrl.protocol !== "https:") {
    throw new Error("GSA inventory source must use HTTPS");
  }

  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const headers = new Headers({
    Accept: "text/csv,text/plain;q=0.9",
    "Accept-Encoding": "identity",
    "User-Agent":
      "dot-gov-news-pipeline-inventory/0.1 (+https://github.com/GSA/federal-website-index)",
  });
  if (options.etag !== undefined && options.etag !== null) {
    headers.set("If-None-Match", options.etag);
  }

  const response = await (options.fetchImpl ?? fetch)(sourceUrl, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (response.status === 304) {
    return {
      etag: response.headers.get("etag") ?? options.etag ?? null,
      kind: "not_modified",
    };
  }

  if (!response.ok || response.body === null) {
    throw new Error(`GSA download failed with HTTP status ${response.status}`);
  }

  if (response.url.length > 0 && new URL(response.url).protocol !== "https:") {
    throw new Error("GSA inventory download redirected away from HTTPS");
  }

  const contentLengthHeader = response.headers.get("content-length");
  const expectedBytes =
    contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (
    expectedBytes !== null &&
    (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)
  ) {
    throw new Error("GSA response has an invalid Content-Length header");
  }
  if (expectedBytes !== null && expectedBytes > maxResponseBytes) {
    throw new Error("GSA response exceeds the configured size limit");
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "dot-gov-gsa-"));
  const filePath = join(
    temporaryDirectory,
    "site-scanning-target-url-list.csv",
  );
  const limiter = new ResponseSizeLimiter(maxResponseBytes);

  try {
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      limiter,
      createWriteStream(filePath, { flags: "wx" }),
    );

    if (expectedBytes !== null && limiter.bytes !== expectedBytes) {
      throw new Error("GSA response ended before Content-Length bytes arrived");
    }

    return {
      bytes: limiter.bytes,
      cleanup: async () => {
        await rm(temporaryDirectory, { force: true, recursive: true });
      },
      etag: response.headers.get("etag"),
      filePath,
      kind: "downloaded",
      sha256: limiter.digest(),
    };
  } catch (error) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw error;
  }
}

export async function snapshotFromLocalFile(
  filePath: string,
): Promise<DownloadedGsaSnapshot> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error("GSA snapshot path must point to a regular file");
  }
  if (fileStat.size > DEFAULT_MAX_RESPONSE_BYTES) {
    throw new Error("GSA snapshot exceeds the configured size limit");
  }

  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }

  return {
    bytes: fileStat.size,
    cleanup: async () => Promise.resolve(),
    etag: null,
    filePath,
    kind: "downloaded",
    sha256: hash.digest("hex"),
  };
}

export function snapshotFilename(filePath: string): string {
  return basename(filePath);
}
