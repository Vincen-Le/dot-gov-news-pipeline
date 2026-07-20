#!/usr/bin/env node

import path from "node:path";

import { hostedDatabase } from "./database.js";
import { exportTrustedManifests } from "./exporter.js";
import {
  assertArticleOverviewRowsCompatible,
  publishArticleOverviewV2Artifacts,
} from "./overview-v2-publisher.js";
import { validateArticleOverviewV2Artifacts } from "./overview-v2-validation.js";
import {
  assertImmutableRowsCompatible,
  publishArtifacts,
} from "./publisher.js";
import { validateArtifacts } from "./validation.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");

function resolveFromRepository(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error("path argument must not be empty");
  }
  return path.isAbsolute(value) ? value : path.resolve(REPOSITORY_ROOT, value);
}

interface ExportCliOptions {
  dryRun: boolean;
  limit?: number;
  outputDirectory: string;
  partitionCount: number;
}

interface ArtifactCliOptions {
  artifactInputs: string[];
  dryRun: boolean;
  limit?: number;
  manifestDirectory: string;
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseExportOptions(arguments_: string[]): ExportCliOptions {
  const options: ExportCliOptions = {
    dryRun: false,
    outputDirectory: path.resolve(
      import.meta.dirname,
      "../../../.data/golden-enrichment/export",
    ),
    partitionCount: 16,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--limit") {
      options.limit = positiveInteger(arguments_[++index], "--limit");
    } else if (argument === "--output-dir") {
      options.outputDirectory = resolveFromRepository(arguments_[++index]);
    } else if (argument === "--partitions") {
      options.partitionCount = positiveInteger(
        arguments_[++index],
        "--partitions",
      );
      if (options.partitionCount > 256) {
        throw new Error("--partitions must be at most 256");
      }
    } else {
      throw new Error(`unknown export argument: ${argument ?? ""}`);
    }
  }
  return options;
}

function parseArtifactOptions(
  arguments_: string[],
  defaultInputDirectory = "generated",
): ArtifactCliOptions {
  const options: ArtifactCliOptions = {
    artifactInputs: [],
    dryRun: false,
    manifestDirectory: path.resolve(
      import.meta.dirname,
      "../../../.data/golden-enrichment/export",
    ),
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--limit") {
      options.limit = positiveInteger(arguments_[++index], "--limit");
    } else if (argument === "--manifest-dir") {
      options.manifestDirectory = resolveFromRepository(arguments_[++index]);
    } else if (argument === "--input") {
      options.artifactInputs.push(resolveFromRepository(arguments_[++index]));
    } else {
      throw new Error(`unknown artifact argument: ${argument ?? ""}`);
    }
  }
  if (options.artifactInputs.length === 0) {
    options.artifactInputs.push(
      path.resolve(
        import.meta.dirname,
        `../../../.data/golden-enrichment/${defaultInputDirectory}`,
      ),
    );
  }
  return options;
}

function loadEnvironment(): void {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
  } catch {
    // Deployed environments can inject credentials directly.
  }
}

async function main(): Promise<void> {
  loadEnvironment();
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "export") {
    const result = await exportTrustedManifests(
      hostedDatabase(),
      parseExportOptions(arguments_),
    );
    process.stdout.write(
      `${JSON.stringify({ event: "golden_enrichment_export_complete", ...result })}\n`,
    );
    return;
  }
  if (command === "validate" || command === "publish") {
    const options = parseArtifactOptions(arguments_);
    const validated = await validateArtifacts(options);
    if (command === "validate") {
      process.stdout.write(
        `${JSON.stringify({ artifacts: validated.length, event: "golden_enrichment_validation_complete" })}\n`,
      );
      return;
    }
    const database = hostedDatabase();
    const result = {
      cardCount: 0,
      imageKeys: [] as string[],
      overviewRows: 0,
      thumbnailRows: 0,
    };
    for (const artifact of validated) {
      await exportTrustedManifests(database, {
        dryRun: true,
        expectedTasks: [artifact.task],
        outputDirectory: options.manifestDirectory,
        partitionCount: 1,
      });
      await assertImmutableRowsCompatible(database, [artifact]);
      const published = await publishArtifacts([artifact], {
        database,
        dryRun: options.dryRun,
      });
      result.cardCount += published.cardCount;
      result.imageKeys.push(...published.imageKeys);
      result.overviewRows += published.overviewRows;
      result.thumbnailRows += published.thumbnailRows;
    }
    process.stdout.write(
      `${JSON.stringify({ dryRun: options.dryRun, event: "golden_enrichment_publish_complete", ...result })}\n`,
    );
    return;
  }
  if (command === "validate-overviews" || command === "publish-overviews") {
    const options = parseArtifactOptions(arguments_, "generated-overviews-v2");
    const validated = await validateArticleOverviewV2Artifacts(options);
    if (command === "validate-overviews") {
      process.stdout.write(
        `${JSON.stringify({ artifacts: validated.length, event: "golden_article_overview_v2_validation_complete" })}\n`,
      );
      return;
    }
    const database = hostedDatabase();
    const result = { cardCount: 0, overviewRows: 0 };
    for (const artifact of validated) {
      await exportTrustedManifests(database, {
        dryRun: true,
        expectedTasks: [artifact.task],
        outputDirectory: options.manifestDirectory,
        partitionCount: 1,
      });
      await assertArticleOverviewRowsCompatible(database, [artifact]);
      const published = await publishArticleOverviewV2Artifacts([artifact], {
        database,
        dryRun: options.dryRun,
      });
      result.cardCount += published.cardCount;
      result.overviewRows += published.overviewRows;
    }
    process.stdout.write(
      `${JSON.stringify({ dryRun: options.dryRun, event: "golden_article_overview_v2_publish_complete", ...result })}\n`,
    );
    return;
  }
  throw new Error(
    "usage: golden:enrich <export|validate|publish|validate-overviews|publish-overviews> [options]",
  );
}

await main();
