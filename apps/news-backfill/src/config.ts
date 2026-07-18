import { readFile } from "node:fs/promises";

import type { BackfillManifest, SourceProfile } from "./types";

function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO date`);
  }
  return new Date(value).toISOString();
}

function validateSource(value: unknown, publisherKey: string): SourceProfile {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${publisherKey} source must be an object`);
  }
  const source = value as Partial<SourceProfile>;
  if (
    typeof source.sourceKey !== "string" ||
    typeof source.sourceUrl !== "string" ||
    !source.sourceUrl.startsWith("https://") ||
    typeof source.title !== "string" ||
    !Array.isArray(source.allowedHosts) ||
    source.allowedHosts.length === 0 ||
    !Number.isInteger(source.maxPages) ||
    (source.maxPages ?? 0) < 1 ||
    (source.maxPages ?? 0) > 10_000
  ) {
    throw new Error(`${publisherKey} source configuration is invalid`);
  }
  return source as SourceProfile;
}

export async function loadManifest(path: string): Promise<BackfillManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("manifest must be an object");
  }
  const manifest = parsed as Partial<BackfillManifest>;
  const windowStart = requireIsoDate(manifest.windowStart, "windowStart");
  const windowEnd = requireIsoDate(manifest.windowEnd, "windowEnd");
  if (windowStart >= windowEnd) throw new Error("manifest window is invalid");
  if (
    typeof manifest.cohortId !== "string" ||
    typeof manifest.version !== "number" ||
    !Number.isInteger(manifest.version) ||
    !Array.isArray(manifest.publishers) ||
    manifest.publishers.length !== 20
  ) {
    throw new Error(
      "manifest must define one versioned cohort of 20 publishers",
    );
  }

  const publisherKeys = new Set<string>();
  for (const publisher of manifest.publishers) {
    if (
      typeof publisher.publisherKey !== "string" ||
      typeof publisher.displayName !== "string" ||
      !Number.isFinite(publisher.trafficVisits) ||
      !Array.isArray(publisher.sources) ||
      publisher.sources.length === 0
    ) {
      throw new Error("publisher configuration is invalid");
    }
    if (publisherKeys.has(publisher.publisherKey)) {
      throw new Error(`duplicate publisher key: ${publisher.publisherKey}`);
    }
    publisherKeys.add(publisher.publisherKey);
    publisher.sources = publisher.sources.map((source) =>
      validateSource(source, publisher.publisherKey),
    );
  }

  return {
    cohortId: manifest.cohortId,
    publishers: manifest.publishers,
    version: manifest.version,
    windowEnd,
    windowStart,
  };
}
