import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  GsaCsvValidationError,
  normalizeGsaHostname,
  parseGsaCsv,
} from "../src/gsa-csv";
import {
  analyzeGsaInventoryFile,
  applyGsaInventoryPolicy,
} from "../src/gsa-inventory-policy";

const fixtures = resolve(import.meta.dirname, "fixtures");

async function collect(input: Readable) {
  const rows = [];
  for await (const row of parseGsaCsv(input)) {
    rows.push(row);
  }
  return rows;
}

describe("GSA CSV parsing", () => {
  it("parses quoted fields and produces deterministic normalized rows", async () => {
    const rows = await collect(
      createReadStream(resolve(fixtures, "gsa-valid.csv")),
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      agency: "Agency, Federal",
      base_domain: "agency.gov",
      gsa_filtered: false,
      initial_url: "agency.gov",
      source_row_number: 1,
      top_level_domain: "gov",
    });
    expect(rows[2]?.bureau).toBeNull();
    expect(rows[0]?.source_row_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.discovery_input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a snapshot with missing required headers", async () => {
    const csv = "initial_url,filtered\nagency.gov,false\n";

    await expect(collect(Readable.from(csv))).rejects.toMatchObject({
      code: "missing_headers",
      name: "GsaCsvValidationError",
    });
  });

  it("rejects malformed CSV without echoing source contents", async () => {
    await expect(
      collect(createReadStream(resolve(fixtures, "gsa-malformed.csv"))),
    ).rejects.toMatchObject({
      code: "malformed_csv",
      name: "GsaCsvValidationError",
    });
  });

  it("rejects non-boolean eligibility values", async () => {
    const csv = [
      "initial_url,base_domain,top_level_domain,branch,agency,bureau,filtered",
      "agency.gov,agency.gov,gov,Executive,Agency,Bureau,yes",
      "",
    ].join("\n");

    await expect(collect(Readable.from(csv))).rejects.toMatchObject({
      code: "invalid_boolean",
      rowNumber: 1,
    });
  });

  it("retains an unusable unfiltered source row without making it eligible", async () => {
    const csv = [
      "initial_url,base_domain,top_level_domain,branch,agency,bureau,filtered",
      "bad_name.agency.gov,agency.gov,gov,Executive,Agency,Bureau,false",
      "",
    ].join("\n");

    const rows = await collect(Readable.from(csv));

    expect(rows[0]).toMatchObject({
      base_domain: null,
      exclusion_reason: "invalid_hostname",
      gsa_filtered: false,
      initial_url: null,
      inventory_usable: false,
      source_initial_url: "bad_name.agency.gov",
    });
  });

  it("normalizes case and a terminal DNS dot", () => {
    expect(normalizeGsaHostname("News.AGENCY.GOV.", "initial_url", 4)).toBe(
      "news.agency.gov",
    );
  });

  it("retains normalized duplicates but chooses one canonical discovery target", async () => {
    const fixture = resolve(fixtures, "gsa-normalized-duplicate.csv");
    const analysis = await analyzeGsaInventoryFile(fixture);
    const rows = await collect(createReadStream(fixture));
    const classified = rows.map((row) =>
      applyGsaInventoryPolicy(row, analysis),
    );

    expect(classified).toEqual([
      expect.objectContaining({
        exclusion_reason: "duplicate_normalized_hostname",
        initial_url: null,
        inventory_usable: false,
        source_initial_url: "español.smokefree.gov",
      }),
      expect.objectContaining({
        exclusion_reason: null,
        initial_url: "xn--espaol-zwa.smokefree.gov",
        inventory_usable: true,
        source_initial_url: "xn--espaol-zwa.smokefree.gov",
      }),
    ]);
  });

  it("rejects URLs and single-label names", () => {
    expect(() =>
      normalizeGsaHostname("https://agency.gov", "initial_url", 1),
    ).toThrow(GsaCsvValidationError);
    expect(() => normalizeGsaHostname("localhost", "initial_url", 1)).toThrow(
      GsaCsvValidationError,
    );
  });
});
