import { opendir, readFile } from "node:fs/promises";
import path from "node:path";

import { OverviewTaskSchema, type OverviewTask } from "./types.js";

async function* filesBelow(directory: string): AsyncGenerator<string> {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* filesBelow(filePath);
    else if (entry.isFile()) yield filePath;
  }
}

export async function loadTrustedTasks(
  manifestDirectory: string,
): Promise<Map<string, OverviewTask>> {
  const tasks = new Map<string, OverviewTask>();
  const cardsDirectory = path.join(manifestDirectory, "cards");
  for await (const filePath of filesBelow(cardsDirectory)) {
    if (!filePath.endsWith(".jsonl")) continue;
    const contents = await readFile(filePath, "utf8");
    for (const [index, line] of contents.split(/\r?\n/u).entries()) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`invalid JSON in ${filePath}:${index + 1}`);
      }
      const task = OverviewTaskSchema.parse(parsed);
      if (tasks.has(task.eventCardId)) {
        throw new Error(`duplicate trusted task for card ${task.eventCardId}`);
      }
      tasks.set(task.eventCardId, task);
    }
  }
  return tasks;
}

export async function findJsonArtifacts(
  inputs: readonly string[],
): Promise<string[]> {
  return findArtifactsBySchema(inputs, "overview-enrichment.v1");
}

export async function findArticleOverviewV2Artifacts(
  inputs: readonly string[],
): Promise<string[]> {
  return findArtifactsBySchema(inputs, "article-overview.v2");
}

async function findArtifactsBySchema(
  inputs: readonly string[],
  schemaVersion: string,
): Promise<string[]> {
  const artifacts: string[] = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (resolved.endsWith(".json")) {
      artifacts.push(resolved);
      continue;
    }
    for await (const filePath of filesBelow(resolved)) {
      if (!filePath.endsWith(".json")) continue;
      const contents = await readFile(filePath, "utf8");
      let value: unknown;
      try {
        value = JSON.parse(contents);
      } catch {
        continue;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        Reflect.get(value, "schemaVersion") === schemaVersion
      ) {
        artifacts.push(filePath);
      }
    }
  }
  return [...new Set(artifacts)].sort((left, right) =>
    left.localeCompare(right),
  );
}
