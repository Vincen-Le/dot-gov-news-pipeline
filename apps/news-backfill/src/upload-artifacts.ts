#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import path from "node:path";

import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

interface Arguments {
  artifactDirectory: string;
  concurrency: number;
  dryRun: boolean;
}

interface LocalArtifact {
  expectedSha256: string;
  filePath: string;
  size: number;
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
  const parsed: Arguments = {
    artifactDirectory: path.resolve(import.meta.dirname, "../../../.data"),
    concurrency: 8,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--artifact-directory") {
      parsed.artifactDirectory = path.resolve(argv[++index] ?? "");
    } else if (argument === "--concurrency") {
      parsed.concurrency = Number(argv[++index]);
    } else if (argument === "--dry-run") {
      parsed.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${argument ?? ""}`);
    }
  }
  if (
    parsed.artifactDirectory === "" ||
    !Number.isInteger(parsed.concurrency) ||
    parsed.concurrency < 1 ||
    parsed.concurrency > 32
  ) {
    throw new Error("artifact directory and concurrency are invalid");
  }
  return parsed;
}

async function* filesBelow(directory: string): AsyncGenerator<string> {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* filesBelow(filePath);
    else if (entry.isFile()) yield filePath;
  }
}

function contentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
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

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
  } catch {
    // Deployed environments can provide credentials directly.
  }
  const args = parseArguments(process.argv.slice(2));
  const root = path.resolve(args.artifactDirectory);
  const artifacts = new Map<string, LocalArtifact>();
  let localArtifacts = 0;
  let discoveredBytes = 0;
  for await (const filePath of filesBelow(root)) {
    const key = path.relative(root, filePath).split(path.sep).join("/");
    if (!key.startsWith("news-backfill/")) continue;
    const match = path
      .basename(filePath)
      .match(/^([0-9a-f]{64})(?:\.[a-z0-9]+)?$/i);
    if (match?.[1] === undefined) continue;
    const file = await stat(filePath);
    const expectedSha256 = match[1].toLowerCase();
    localArtifacts += 1;
    discoveredBytes += file.size;
    artifacts.set(expectedSha256, {
      expectedSha256,
      filePath,
      size: file.size,
    });
  }
  if (args.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ bytes: discoveredBytes, duplicateArtifacts: localArtifacts - artifacts.size, event: "artifact_upload_planned", localArtifacts, uniqueObjects: artifacts.size })}\n`,
    );
    return;
  }

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
  let nextIndex = 0;
  let skipped = 0;
  let uploaded = 0;
  let uploadedBytes = 0;
  const uniqueArtifacts = [...artifacts.values()];

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const artifact = uniqueArtifacts[index];
      if (artifact === undefined) return;
      const actualSha256 = await sha256File(artifact.filePath);
      if (actualSha256 !== artifact.expectedSha256) {
        throw new Error(
          `artifact hash mismatch for ${artifact.filePath}: expected ${artifact.expectedSha256}, received ${actualSha256}`,
        );
      }
      const key = `news-backfill/objects/${actualSha256}`;
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        skipped += 1;
        continue;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await client.send(
        new PutObjectCommand({
          Body: createReadStream(artifact.filePath),
          Bucket: bucket,
          ContentLength: artifact.size,
          ContentType: contentType(artifact.filePath),
          Key: key,
          Metadata: {
            sha256: actualSha256,
            source: "news-backfill-local-artifact-migration",
          },
        }),
      );
      uploaded += 1;
      uploadedBytes += artifact.size;
      if (uploaded % 250 === 0) {
        process.stdout.write(
          `${JSON.stringify({ event: "artifact_upload_progress", skipped, uploaded, uploadedBytes })}\n`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: args.concurrency }, async () => worker()),
  );
  process.stdout.write(
    `${JSON.stringify({ discoveredBytes, duplicateArtifacts: localArtifacts - artifacts.size, event: "artifact_upload_completed", localArtifacts, skipped, uniqueObjects: artifacts.size, uploaded, uploadedBytes })}\n`,
  );
}

await main();
