#!/usr/bin/env node

import { createHash } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ArtifactStore } from "./artifact-store";
import { loadManifest } from "./config";
import { createFetcher } from "./fetcher";
import { BackfillRepository } from "./repository";
import { runBackfill } from "./runner";

setDefaultResultOrder("ipv4first");

interface Arguments {
  artifactDirectory: string;
  dryRun: boolean;
  manifestPath: string;
  publishers: Set<string> | undefined;
}

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = {
    artifactDirectory: path.resolve(import.meta.dirname, "../../../.data"),
    dryRun: false,
    manifestPath: path.resolve(
      import.meta.dirname,
      "../../../config/news-backfill/top-20-diversity-v2.json",
    ),
    publishers: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") parsed.dryRun = true;
    else if (argument === "--manifest")
      parsed.manifestPath = argv[++index] ?? "";
    else if (argument === "--artifact-directory")
      parsed.artifactDirectory = argv[++index] ?? "";
    else if (argument === "--publisher") {
      parsed.publishers ??= new Set<string>();
      parsed.publishers.add(argv[++index] ?? "");
    } else throw new Error(`unknown argument: ${argument ?? ""}`);
  }
  if (parsed.manifestPath === "" || parsed.artifactDirectory === "") {
    throw new Error("manifest and artifact directory values cannot be empty");
  }
  return parsed;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
  } catch {
    // Production can provide environment variables without a local .env file.
  }
  const args = parseArguments(process.argv.slice(2));
  const manifestBytes = await readFile(args.manifestPath);
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const manifest = await loadManifest(args.manifestPath);
  const runKey = `${manifest.cohortId}-${manifest.windowStart.slice(0, 10)}-${manifest.windowEnd.slice(0, 10)}-${manifestSha256.slice(0, 12)}`;
  const repository = new BackfillRepository({
    secretKey: requiredEnvironment("SUPABASE_SECRET_KEY"),
    supabaseUrl: requiredEnvironment("SUPABASE_URL"),
  });
  const fetchDocument = createFetcher({
    minimumHostIntervalMs: 750,
    timeoutMs: 30_000,
    userAgent:
      process.env.NEWS_BACKFILL_USER_AGENT ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 DotGovNewsBackfill/1.0",
  });
  const summary = await runBackfill({
    artifactStore: new ArtifactStore(
      path.resolve(args.artifactDirectory),
      runKey,
    ),
    dryRun: args.dryRun,
    fetchDocument,
    manifest,
    manifestSha256,
    publisherFilter: args.publishers,
    repository,
    runKey,
  });
  process.stdout.write(
    `${JSON.stringify({ event: "backfill_completed", summary })}\n`,
  );
  if (summary.failed > 0) process.exitCode = 2;
}

await main();
