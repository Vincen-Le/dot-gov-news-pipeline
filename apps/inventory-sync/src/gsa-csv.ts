import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import type { Readable } from "node:stream";

import { parse } from "csv-parse";

import {
  REQUIRED_GSA_HEADERS,
  type StagedGsaInventoryRow,
} from "./inventory-types";

const HOST_LABEL_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const TOP_LEVEL_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class GsaCsvValidationError extends Error {
  readonly code: string;
  readonly rowNumber?: number;

  constructor(code: string, message: string, rowNumber?: number) {
    super(message);
    this.name = "GsaCsvValidationError";
    this.code = code;
    this.rowNumber = rowNumber;
  }
}

function stableJson(value: Record<string, unknown>): string {
  const sortedEntries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return JSON.stringify(Object.fromEntries(sortedEntries));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryInputHash(input: {
  base_domain: string | null;
  exclusion_reason: string | null;
  gsa_filtered: boolean;
  initial_url: string | null;
  inventory_usable: boolean;
}): string {
  return sha256(stableJson(input));
}

function optionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function requiredValue(
  record: Record<string, string>,
  field: string,
  rowNumber: number,
): string {
  const value = record[field];
  if (value === undefined || value.trim().length === 0) {
    throw new GsaCsvValidationError(
      "missing_required_value",
      `Required field ${field} is empty at source row ${rowNumber}`,
      rowNumber,
    );
  }

  return value;
}

export function parseStrictBoolean(
  value: string,
  field: string,
  rowNumber: number,
): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new GsaCsvValidationError(
    "invalid_boolean",
    `Field ${field} must be true or false at source row ${rowNumber}`,
    rowNumber,
  );
}

export function normalizeGsaHostname(
  value: string,
  field: string,
  rowNumber: number,
): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");

  if (
    trimmed.length === 0 ||
    trimmed.includes("://") ||
    /[\s/@:#?]/.test(trimmed)
  ) {
    throw new GsaCsvValidationError(
      "invalid_hostname",
      `Field ${field} is not a bare hostname at source row ${rowNumber}`,
      rowNumber,
    );
  }

  const ascii = domainToASCII(trimmed).toLowerCase();
  const labels = ascii.split(".");

  if (
    ascii.length === 0 ||
    ascii.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !HOST_LABEL_PATTERN.test(label))
  ) {
    throw new GsaCsvValidationError(
      "invalid_hostname",
      `Field ${field} contains an invalid hostname at source row ${rowNumber}`,
      rowNumber,
    );
  }

  return ascii;
}

function normalizeTopLevelDomain(value: string, rowNumber: number): string {
  const normalized = value.trim().toLowerCase().replace(/^\./, "");
  if (!TOP_LEVEL_DOMAIN_PATTERN.test(normalized)) {
    throw new GsaCsvValidationError(
      "invalid_top_level_domain",
      `top_level_domain is invalid at source row ${rowNumber}`,
      rowNumber,
    );
  }

  return normalized;
}

export function validateGsaHeaders(headers: string[]): string[] {
  const normalizedHeaders = headers.map((header) => header.trim());
  const duplicateHeaders = normalizedHeaders.filter(
    (header, index) => normalizedHeaders.indexOf(header) !== index,
  );

  if (duplicateHeaders.length > 0) {
    throw new GsaCsvValidationError(
      "duplicate_headers",
      "GSA CSV contains duplicate column names",
    );
  }

  const missingHeaders = REQUIRED_GSA_HEADERS.filter(
    (header) => !normalizedHeaders.includes(header),
  );
  if (missingHeaders.length > 0) {
    throw new GsaCsvValidationError(
      "missing_headers",
      `GSA CSV is missing required columns: ${missingHeaders.join(", ")}`,
    );
  }

  return normalizedHeaders;
}

export function normalizeGsaRecord(
  rawRecord: Record<string, string>,
  rowNumber: number,
): StagedGsaInventoryRow {
  const sourceRecord = Object.fromEntries(
    Object.entries(rawRecord).map(([key, value]) => [key, value ?? ""]),
  );
  const sourceInitialUrl = requiredValue(sourceRecord, "initial_url", rowNumber)
    .trim()
    .toLowerCase();
  const sourceBaseDomain = requiredValue(
    sourceRecord,
    "base_domain",
    rowNumber,
  );
  const sourceTopLevelDomain = requiredValue(
    sourceRecord,
    "top_level_domain",
    rowNumber,
  );
  let initialUrl: string | null;
  let baseDomain: string | null;
  let topLevelDomain = sourceTopLevelDomain.trim().toLowerCase();
  let exclusionReason: string | null = null;

  try {
    initialUrl = normalizeGsaHostname(
      sourceInitialUrl,
      "initial_url",
      rowNumber,
    );
    baseDomain = normalizeGsaHostname(
      sourceBaseDomain,
      "base_domain",
      rowNumber,
    );
    topLevelDomain = normalizeTopLevelDomain(sourceTopLevelDomain, rowNumber);

    if (initialUrl !== baseDomain && !initialUrl.endsWith(`.${baseDomain}`)) {
      throw new GsaCsvValidationError(
        "base_domain_mismatch",
        `initial_url is not within base_domain at source row ${rowNumber}`,
        rowNumber,
      );
    }

    if (baseDomain.split(".").at(-1) !== topLevelDomain) {
      throw new GsaCsvValidationError(
        "top_level_domain_mismatch",
        `base_domain does not match top_level_domain at source row ${rowNumber}`,
        rowNumber,
      );
    }
  } catch (error) {
    if (!(error instanceof GsaCsvValidationError)) {
      throw error;
    }
    initialUrl = null;
    baseDomain = null;
    exclusionReason = error.code;
  }

  const filtered = parseStrictBoolean(
    requiredValue(sourceRecord, "filtered", rowNumber),
    "filtered",
    rowNumber,
  );
  const discoveryInput = {
    base_domain: baseDomain,
    exclusion_reason: exclusionReason,
    gsa_filtered: filtered,
    initial_url: initialUrl,
    inventory_usable: exclusionReason === null,
  };

  return {
    agency: optionalText(sourceRecord.agency ?? ""),
    base_domain: baseDomain,
    branch: optionalText(sourceRecord.branch ?? ""),
    bureau: optionalText(sourceRecord.bureau ?? ""),
    discovery_input_hash: discoveryInputHash(discoveryInput),
    exclusion_reason: exclusionReason,
    gsa_filtered: filtered,
    initial_url: initialUrl,
    inventory_usable: exclusionReason === null,
    source_record: sourceRecord,
    source_initial_url: sourceInitialUrl,
    source_row_hash: sha256(stableJson(sourceRecord)),
    source_row_number: rowNumber,
    top_level_domain: topLevelDomain,
  };
}

export function excludeGsaRow(
  row: StagedGsaInventoryRow,
  exclusionReason: string,
): StagedGsaInventoryRow {
  const discoveryInput = {
    base_domain: null,
    exclusion_reason: exclusionReason,
    gsa_filtered: row.gsa_filtered,
    initial_url: null,
    inventory_usable: false,
  };

  return {
    ...row,
    base_domain: null,
    discovery_input_hash: discoveryInputHash(discoveryInput),
    exclusion_reason: exclusionReason,
    initial_url: null,
    inventory_usable: false,
  };
}

export async function* parseGsaCsv(
  input: Readable,
): AsyncGenerator<StagedGsaInventoryRow> {
  const parser = input.pipe(
    parse({
      bom: true,
      columns: validateGsaHeaders,
      max_record_size: 262_144,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: false,
    }),
  );
  let sourceRowNumber = 0;

  try {
    for await (const rawRecord of parser) {
      sourceRowNumber += 1;
      yield normalizeGsaRecord(
        rawRecord as Record<string, string>,
        sourceRowNumber,
      );
    }
  } catch (error) {
    if (error instanceof GsaCsvValidationError) {
      throw error;
    }

    throw new GsaCsvValidationError(
      "malformed_csv",
      `GSA CSV parsing failed near source row ${sourceRowNumber + 1}`,
      sourceRowNumber + 1,
    );
  }

  if (sourceRowNumber === 0) {
    throw new GsaCsvValidationError(
      "empty_snapshot",
      "GSA CSV contains no data rows",
    );
  }
}
