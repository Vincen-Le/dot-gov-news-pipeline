import { createReadStream } from "node:fs";

import { parseGsaCsv } from "./gsa-csv";
import type { DownloadedGsaSnapshot } from "./gsa-client";
import {
  analyzeGsaInventoryFile,
  applyGsaInventoryPolicy,
} from "./gsa-inventory-policy";
import type { InventoryInspection } from "./inventory-types";

export interface InspectedGsaInventory {
  eligibleHostnames: string[];
  summary: InventoryInspection;
}

export async function inspectGsaInventory(
  snapshot: DownloadedGsaSnapshot,
): Promise<InspectedGsaInventory> {
  const eligibleHostnames: string[] = [];
  const exclusionReasons: Record<string, number> = {};
  let excludedCount = 0;
  let filteredCount = 0;
  let rows = 0;
  const analysis = await analyzeGsaInventoryFile(snapshot.filePath);

  for await (const parsedRow of parseGsaCsv(
    createReadStream(snapshot.filePath),
  )) {
    const row = applyGsaInventoryPolicy(parsedRow, analysis);
    rows += 1;
    if (row.gsa_filtered) {
      filteredCount += 1;
    }
    if (!row.inventory_usable) {
      excludedCount += 1;
      const reason = row.exclusion_reason ?? "unknown";
      exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
    } else if (!row.gsa_filtered && row.initial_url !== null) {
      eligibleHostnames.push(row.initial_url);
    }
  }

  if (rows !== analysis.sourceRowCount) {
    throw new Error("GSA snapshot changed between validation and inspection");
  }

  return {
    eligibleHostnames,
    summary: {
      eligibleCount: eligibleHostnames.length,
      excludedCount,
      exclusionReasons,
      filteredCount,
      rows,
      sha256: snapshot.sha256,
      sourceBytes: snapshot.bytes,
    },
  };
}
