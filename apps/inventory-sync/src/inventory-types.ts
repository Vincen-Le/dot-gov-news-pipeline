export const GSA_INVENTORY_SOURCE = "gsa_federal_website_index" as const;

export const DEFAULT_GSA_INVENTORY_URL =
  "https://raw.githubusercontent.com/GSA/federal-website-index/main/data/site-scanning-target-url-list.csv";

export const REQUIRED_GSA_HEADERS = [
  "initial_url",
  "base_domain",
  "top_level_domain",
  "branch",
  "agency",
  "bureau",
  "filtered",
] as const;

export interface StagedGsaInventoryRow {
  agency: string | null;
  base_domain: string | null;
  branch: string | null;
  bureau: string | null;
  discovery_input_hash: string;
  exclusion_reason: string | null;
  gsa_filtered: boolean;
  initial_url: string | null;
  inventory_usable: boolean;
  source_record: Record<string, string>;
  source_initial_url: string;
  source_row_hash: string;
  source_row_number: number;
  top_level_domain: string;
}

export interface InventoryInspection {
  eligibleCount: number;
  excludedCount: number;
  exclusionReasons: Record<string, number>;
  filteredCount: number;
  rows: number;
  sha256: string;
  sourceBytes: number;
}

export interface InventoryFinalizeResult {
  deactivated_count: number;
  eligible_count: number;
  inserted_count: number;
  reactivated_count: number;
  updated_count: number;
}

export interface InventorySyncResult extends InventoryFinalizeResult {
  runId: string;
  sha256: string;
  sourceRowCount: number;
  status: "succeeded" | "unchanged";
}
