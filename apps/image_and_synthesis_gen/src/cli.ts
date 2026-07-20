#!/usr/bin/env node

import path from "node:path";

import {
  assertArticleOverviewRowsCompatible,
  publishArticleOverviewV2Artifacts,
} from "./article_synthesis/publisher.js";
import { validateArticleOverviewV2Artifacts } from "./article_synthesis/validation.js";
import {
  assertImmutableRowsCompatible,
  publishArtifacts,
} from "./legacy/publisher.js";
import { validateArtifacts } from "./legacy/validation.js";
import { hostedDatabase } from "./shared/database.js";
import { exportTrustedManifests } from "./shared/exporter.js";
import { type SynthesisCardKind } from "./shared/types.js";
import {
  prepareCompletedReusableImages,
  publishReusableImages,
} from "./reusable/publisher.js";
import {
  assertImageRowsCompatible,
  prepareImageArtifacts,
  publishImageArtifacts,
} from "./thumbnail/publisher.js";
import { validateImageArtifacts } from "./thumbnail/validation.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");

function resolveFromRepository(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error("path argument must not be empty");
  }
  return path.isAbsolute(value) ? value : path.resolve(REPOSITORY_ROOT, value);
}

interface ExportCliOptions {
  cardKinds: SynthesisCardKind[];
  dryRun: boolean;
  limit?: number;
  missingArticleOverviewsOnly: boolean;
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
    cardKinds: ["overview"],
    dryRun: false,
    missingArticleOverviewsOnly: false,
    outputDirectory: path.resolve(
      import.meta.dirname,
      "../../../.data/golden-enrichment/export",
    ),
    partitionCount: 16,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--card-kinds") {
      const raw = arguments_[++index] ?? "";
      const values = [...new Set(raw.split(","))];
      if (
        values.length === 0 ||
        values.some((value) => value !== "overview" && value !== "episode")
      ) {
        throw new Error("--card-kinds must be overview, episode, or both");
      }
      options.cardKinds = values as SynthesisCardKind[];
    } else if (argument === "--missing-overviews") {
      options.missingArticleOverviewsOnly = true;
    } else if (argument === "--limit") {
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
    await exportTrustedManifests(database, {
      dryRun: true,
      expectedTasks: validated.map(({ task }) => task),
      outputDirectory: options.manifestDirectory,
      partitionCount: 1,
    });
    await assertImmutableRowsCompatible(database, validated);
    const result = await publishArtifacts(validated, {
      database,
      dryRun: options.dryRun,
    });
    process.stdout.write(
      `${JSON.stringify({ dryRun: options.dryRun, event: "golden_enrichment_publish_complete", ...result })}\n`,
    );
    return;
  }
  if (command === "validate-images" || command === "publish-images") {
    const options = parseArtifactOptions(arguments_, "generated-images");
    const validated = await validateImageArtifacts(options);
    const prepared = await prepareImageArtifacts(validated);
    if (command === "validate-images") {
      process.stdout.write(
        `${JSON.stringify({ artifacts: prepared.length, event: "golden_image_validation_complete", imageKeys: prepared.flatMap(({ images }) => images.map((image) => image.key)) })}\n`,
      );
      return;
    }
    const database = hostedDatabase();
    await exportTrustedManifests(database, {
      dryRun: true,
      expectedTasks: validated.map(({ task }) => task),
      outputDirectory: options.manifestDirectory,
      partitionCount: 1,
    });
    await assertImageRowsCompatible(database, prepared);
    const result = await publishImageArtifacts(prepared, {
      database,
      dryRun: options.dryRun,
    });
    process.stdout.write(
      `${JSON.stringify({ dryRun: options.dryRun, event: "golden_image_publish_complete", ...result })}\n`,
    );
    return;
  }
  if (
    command === "validate-reusable-images" ||
    command === "publish-reusable-images"
  ) {
    const options = parseArtifactOptions(arguments_, "reusable-images");
    const prepared = await prepareCompletedReusableImages(
      options.artifactInputs,
    );
    if (command === "validate-reusable-images") {
      process.stdout.write(
        `${JSON.stringify({ artifacts: prepared.length, event: "reusable_image_validation_complete", imageKeys: prepared.flatMap(({ images }) => images.map((image) => image.key)) })}\n`,
      );
      return;
    }
    const result = await publishReusableImages(prepared, {
      database: hostedDatabase(),
      dryRun: options.dryRun,
    });
    process.stdout.write(
      `${JSON.stringify({ dryRun: options.dryRun, event: "reusable_image_publish_complete", ...result })}\n`,
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
    await exportTrustedManifests(database, {
      cardKinds: ["overview", "episode"],
      dryRun: true,
      expectedTasks: validated.map(({ task }) => task),
      outputDirectory: options.manifestDirectory,
      partitionCount: 1,
    });
    await assertArticleOverviewRowsCompatible(database, validated);
    const result = await publishArticleOverviewV2Artifacts(validated, {
      database,
      dryRun: options.dryRun,
    });
    process.stdout.write(
      `${JSON.stringify({ dryRun: options.dryRun, event: "golden_article_overview_v2_publish_complete", ...result })}\n`,
    );
    return;
  }
  throw new Error(
    "usage: card:generate <export|validate|publish|validate-images|publish-images|validate-reusable-images|publish-reusable-images|validate-overviews|publish-overviews> [options]",
  );
}

await main();
