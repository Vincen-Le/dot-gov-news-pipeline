import { createReadStream } from "node:fs";

import { excludeGsaRow, parseGsaCsv } from "./gsa-csv";
import type { StagedGsaInventoryRow } from "./inventory-types";

export interface GsaInventoryAnalysis {
  canonicalSourceByHostname: ReadonlyMap<string, string>;
  sourceRowCount: number;
}

function sourcePreference(row: StagedGsaInventoryRow): string {
  if (row.initial_url === row.source_initial_url) {
    return `0:${row.source_initial_url}`;
  }
  return `1:${row.source_initial_url}`;
}

export async function analyzeGsaInventoryFile(
  filePath: string,
): Promise<GsaInventoryAnalysis> {
  const seenSourceInitialUrls = new Set<string>();
  const canonicalRows = new Map<
    string,
    { preference: string; sourceInitialUrl: string }
  >();
  let sourceRowCount = 0;

  for await (const row of parseGsaCsv(createReadStream(filePath))) {
    if (seenSourceInitialUrls.has(row.source_initial_url)) {
      throw new Error(
        `Duplicate source initial_url at source row ${row.source_row_number}`,
      );
    }
    seenSourceInitialUrls.add(row.source_initial_url);
    sourceRowCount += 1;

    if (!row.inventory_usable || row.initial_url === null) {
      continue;
    }

    const preference = sourcePreference(row);
    const existing = canonicalRows.get(row.initial_url);
    if (existing === undefined || preference < existing.preference) {
      canonicalRows.set(row.initial_url, {
        preference,
        sourceInitialUrl: row.source_initial_url,
      });
    }
  }

  return {
    canonicalSourceByHostname: new Map(
      Array.from(canonicalRows, ([hostname, value]) => [
        hostname,
        value.sourceInitialUrl,
      ]),
    ),
    sourceRowCount,
  };
}

export function applyGsaInventoryPolicy(
  row: StagedGsaInventoryRow,
  analysis: GsaInventoryAnalysis,
): StagedGsaInventoryRow {
  if (!row.inventory_usable || row.initial_url === null) {
    return row;
  }

  const canonicalSource = analysis.canonicalSourceByHostname.get(
    row.initial_url,
  );
  if (canonicalSource === row.source_initial_url) {
    return row;
  }

  return excludeGsaRow(row, "duplicate_normalized_hostname");
}
