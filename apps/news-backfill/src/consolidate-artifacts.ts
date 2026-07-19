#!/usr/bin/env node

import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import path from "node:path";

interface Arguments {
  concurrency: number;
  dryRun: boolean;
}

interface LegacyArtifact {
  size: number;
  sourceKey: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function r2Endpoint(): string {
  const configured = process.env.R2_S3_API_ENDPOINT?.trim();
  return configured === undefined || configured === ""
    ? `https://${requiredEnvironment("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`
    : configured;
}

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = { concurrency: 16, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--concurrency") {
      parsed.concurrency = Number(argv[++index]);
    } else if (argument === "--dry-run") {
      parsed.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${argument ?? ""}`);
    }
  }
  if (
    !Number.isInteger(parsed.concurrency) ||
    parsed.concurrency < 1 ||
    parsed.concurrency > 32
  ) {
    throw new Error("concurrency must be an integer between 1 and 32");
  }
  return parsed;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const metadata = Reflect.get(error, "$metadata");
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    Reflect.get(metadata, "httpStatusCode") === 404
  );
}

function contentTypeForKey(key: string): string {
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".xml")) return "application/xml; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
  } catch {
    // Deployed environments can provide credentials directly.
  }
  const args = parseArguments(process.argv.slice(2));
  const bucket = requiredEnvironment("R2_BUCKET_NAME");
  const client = new S3Client({
    credentials: {
      accessKeyId: requiredEnvironment("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment("R2_SECRET_ACCESS_KEY"),
    },
    endpoint: r2Endpoint(),
    forcePathStyle: true,
    region: "auto",
  });
  const legacyByHash = new Map<string, LegacyArtifact>();
  let continuationToken: string | undefined;
  let legacyObjects = 0;
  let legacyBytes = 0;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
        Prefix: "news-backfill/",
      }),
    );
    for (const object of page.Contents ?? []) {
      const sourceKey = object.Key;
      if (
        sourceKey === undefined ||
        sourceKey.startsWith("news-backfill/objects/")
      ) {
        continue;
      }
      const match = sourceKey.match(/\/([0-9a-f]{64})\.[a-z0-9]+$/i);
      if (match?.[1] === undefined) continue;
      const sha256 = match[1].toLowerCase();
      const size = object.Size ?? 0;
      const existing = legacyByHash.get(sha256);
      if (existing !== undefined && existing.size !== size) {
        throw new Error(
          `legacy artifacts claiming hash ${sha256} have different sizes`,
        );
      }
      legacyByHash.set(sha256, { size, sourceKey });
      legacyObjects += 1;
      legacyBytes += size;
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken !== undefined);

  const uniqueArtifacts = [...legacyByHash.entries()];
  const uniqueBytes = uniqueArtifacts.reduce(
    (total, [, artifact]) => total + artifact.size,
    0,
  );
  if (args.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ duplicateBytes: legacyBytes - uniqueBytes, duplicateObjects: legacyObjects - uniqueArtifacts.length, event: "artifact_consolidation_planned", legacyBytes, legacyObjects, uniqueBytes, uniqueObjects: uniqueArtifacts.length })}\n`,
    );
    return;
  }

  let copied = 0;
  let copiedBytes = 0;
  let nextIndex = 0;
  let skipped = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const item = uniqueArtifacts[index];
      if (item === undefined) return;
      const [sha256, artifact] = item;
      const targetKey = `news-backfill/objects/${sha256}`;
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: targetKey }),
        );
        skipped += 1;
        continue;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          ContentType: contentTypeForKey(artifact.sourceKey),
          CopySource: `${bucket}/${artifact.sourceKey}`,
          Key: targetKey,
          Metadata: { sha256 },
          MetadataDirective: "REPLACE",
        }),
      );
      copied += 1;
      copiedBytes += artifact.size;
      if (copied % 250 === 0) {
        process.stdout.write(
          `${JSON.stringify({ copied, copiedBytes, event: "artifact_consolidation_progress", skipped })}\n`,
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: args.concurrency }, async () => worker()),
  );
  process.stdout.write(
    `${JSON.stringify({ copied, copiedBytes, duplicateBytes: legacyBytes - uniqueBytes, duplicateObjects: legacyObjects - uniqueArtifacts.length, event: "artifact_consolidation_completed", legacyBytes, legacyObjects, skipped, uniqueBytes, uniqueObjects: uniqueArtifacts.length })}\n`,
  );
}

await main();
