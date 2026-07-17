import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { downloadGsaSnapshot, snapshotFromLocalFile } from "./gsa-client";
import { inspectGsaInventory } from "./inspect-gsa-inventory";
import { DEFAULT_GSA_INVENTORY_URL } from "./inventory-types";
import { createLocalSnapshotStore } from "./local-snapshot-store";
import { createR2SnapshotStore } from "./r2-snapshot-store";
import { createSupabaseInventoryRepository } from "./supabase-inventory";
import { syncGsaInventory } from "./sync-gsa-inventory";

interface CliOptions {
  allowLargeDecrease: boolean;
  dryRun: boolean;
  localArtifactDirectory?: string;
  outputPath?: string;
  sourceFile?: string;
}

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");

function resolveCliPath(value: string): string {
  return isAbsolute(value) ? value : resolve(WORKSPACE_ROOT, value);
}

function parseArguments(arguments_: string[]): CliOptions {
  const options: CliOptions = {
    allowLargeDecrease: false,
    dryRun: false,
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--allow-large-decrease") {
      options.allowLargeDecrease = true;
    } else if (argument === "--output") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error("--output requires a path");
      }
      options.outputPath = resolveCliPath(value);
      index += 1;
    } else if (argument === "--local-artifact-directory") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error("--local-artifact-directory requires a path");
      }
      options.localArtifactDirectory = resolveCliPath(value);
      index += 1;
    } else if (argument === "--source-file") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error("--source-file requires a path");
      }
      options.sourceFile = resolveCliPath(value);
      index += 1;
    } else if (argument === "--help") {
      console.log(
        [
          "Usage: pnpm inventory:sync [options]",
          "",
          "  --dry-run               Download, validate, and count without durable writes",
          "  --source-file <path>     Read a local snapshot instead of downloading GSA",
          "  --output <path>          Write eligible hostnames as a newline-delimited file",
          "  --local-artifact-directory <path>",
          "                            Archive locally during a local Supabase sync",
          "  --allow-large-decrease   Override the 80% row-count reconciliation guard",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
  }

  if (!options.dryRun && options.outputPath !== undefined) {
    throw new Error("--output is supported only with --dry-run");
  }
  if (options.dryRun && options.localArtifactDirectory !== undefined) {
    throw new Error("--local-artifact-directory cannot be used with --dry-run");
  }

  return options;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is missing`);
  }
  return value;
}

function loadLocalEnvironment(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      Reflect.get(error, "code") !== "ENOENT"
    ) {
      throw error;
    }
  }
}

async function runDryRun(options: CliOptions): Promise<void> {
  const snapshot =
    options.sourceFile === undefined
      ? await downloadGsaSnapshot({ sourceUrl: DEFAULT_GSA_INVENTORY_URL })
      : await snapshotFromLocalFile(options.sourceFile);

  if (snapshot.kind !== "downloaded") {
    throw new Error("Dry-run download unexpectedly returned not modified");
  }

  try {
    const inspection = await inspectGsaInventory(snapshot);
    if (options.outputPath !== undefined) {
      await writeFile(
        options.outputPath,
        `${inspection.eligibleHostnames.join("\n")}\n`,
        { encoding: "utf8", flag: "w" },
      );
    }

    console.log(
      JSON.stringify({
        ...inspection.summary,
        mode: "dry-run",
        outputPath: options.outputPath,
        sourceUrl: DEFAULT_GSA_INVENTORY_URL,
      }),
    );
  } finally {
    await snapshot.cleanup();
  }
}

async function runSync(options: CliOptions): Promise<void> {
  loadLocalEnvironment();
  const supabaseUrl = requiredEnvironment("SUPABASE_URL");
  const repository = createSupabaseInventoryRepository({
    secretKey: requiredEnvironment("SUPABASE_SECRET_KEY"),
    url: supabaseUrl,
  });
  const snapshotStore =
    options.localArtifactDirectory === undefined
      ? createR2SnapshotStore({
          accessKeyId: requiredEnvironment("R2_ACCESS_KEY_ID"),
          accountId:
            process.env.CLOUDFLARE_ACCOUNT_ID ??
            requiredEnvironment("R2_ACCOUNT_ID"),
          bucket: requiredEnvironment("R2_BUCKET_NAME"),
          secretAccessKey: requiredEnvironment("R2_SECRET_ACCESS_KEY"),
        })
      : createLocalSnapshotStore(options.localArtifactDirectory);
  if (options.localArtifactDirectory !== undefined) {
    const hostname = new URL(supabaseUrl).hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      throw new Error(
        "Local artifact storage is allowed only with a local Supabase URL",
      );
    }
  }
  const result = await syncGsaInventory({
    allowLargeDecrease: options.allowLargeDecrease,
    download:
      options.sourceFile === undefined
        ? undefined
        : async () => snapshotFromLocalFile(options.sourceFile as string),
    repository,
    snapshotStore,
  });

  console.log(
    JSON.stringify({
      ...result,
      mode: "sync",
      sourceUrl: DEFAULT_GSA_INVENTORY_URL,
    }),
  );
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.dryRun) {
    await runDryRun(options);
  } else {
    await runSync(options);
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message.slice(0, 1000) : "unknown",
      errorName: error instanceof Error ? error.name : "UnknownError",
      outcome: "failed",
    }),
  );
  process.exitCode = 1;
});
