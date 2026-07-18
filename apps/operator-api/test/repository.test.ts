import { describe, expect, it } from "vitest";

import {
  parseGovernmentSite,
  parseInventoryRun,
  parseInventorySummary,
  parsePipelineEvent,
} from "../src/repository";

describe("operator repository mappers", () => {
  it("maps database inventory summary fields", () => {
    expect(
      parseInventorySummary({
        active_count: 10,
        discovery_backoff_count: 1,
        discovery_leased_count: 2,
        discovery_pending_count: 7,
        gsa_filtered_count: 0,
        inactive_count: 1,
        ingestion_excluded_count: 1,
        latest_source_sha256: "a".repeat(64),
        latest_success_at: "2026-07-17T16:00:00.000Z",
        total_count: 11,
        usable_count: 9,
      }).usableCount,
    ).toBe(9);
  });

  it("rejects malformed count data", () => {
    expect(() => parseInventorySummary({ total_count: -1 })).toThrow();
    expect(() =>
      parseInventorySummary({
        active_count: 10,
        discovery_backoff_count: 1,
        discovery_leased_count: 2,
        discovery_pending_count: 7,
        gsa_filtered_count: 0,
        inactive_count: 1,
        ingestion_excluded_count: 1,
        latest_source_sha256: null,
        latest_success_at: null,
        total_count: null,
        usable_count: 9,
      }),
    ).toThrow(/total_count/u);
  });

  it("rejects malformed nullable provider fields instead of hiding drift", () => {
    expect(() =>
      parseGovernmentSite({
        agency: 42,
        base_domain: "nasa.gov",
        branch: null,
        bureau: null,
        discovery_status: null,
        exclusion_reason: null,
        first_seen_at: "2026-07-17T16:00:00.000Z",
        gsa_filtered: false,
        id: "8ae940f1-c65c-424c-97bd-c177d88320c3",
        initial_url: "nasa.gov",
        inventory_active: true,
        inventory_usable: true,
        last_seen_at: "2026-07-17T16:00:00.000Z",
        next_discovery_at: null,
        source_initial_url: "nasa.gov",
        top_level_domain: "gov",
      }),
    ).toThrow(/nullable string/u);
  });

  it("maps inventory runs, sites, and events", () => {
    expect(
      parseInventoryRun({
        completed_at: null,
        deactivated_count: 0,
        eligible_count: 0,
        error_code: null,
        id: "8ae940f1-c65c-424c-97bd-c177d88320c3",
        inserted_count: 0,
        raw_artifact_key: null,
        reactivated_count: 0,
        source: "gsa_federal_website_index",
        source_etag: null,
        source_row_count: null,
        source_sha256: null,
        staged_count: 0,
        started_at: "2026-07-17T16:00:00.000Z",
        status: "running",
        updated_count: 0,
      }).status,
    ).toBe("running");

    expect(
      parseGovernmentSite({
        agency: "NASA",
        base_domain: "nasa.gov",
        branch: "Executive",
        bureau: null,
        discovery_status: "pending",
        exclusion_reason: null,
        first_seen_at: "2026-07-17T16:00:00.000Z",
        gsa_filtered: false,
        id: "8ae940f1-c65c-424c-97bd-c177d88320c3",
        initial_url: "https://nasa.gov/",
        inventory_active: true,
        inventory_usable: true,
        last_seen_at: "2026-07-17T16:00:00.000Z",
        next_discovery_at: "2026-07-17T17:00:00.000Z",
        source_initial_url: "https://nasa.gov",
        top_level_domain: "gov",
      }).baseDomain,
    ).toBe("nasa.gov");

    expect(
      parsePipelineEvent({
        artifact_key: "health/event.json",
        created_at: "2026-07-17T16:00:01.000Z",
        event_type: "infra.heartbeat",
        id: "8ae940f1-c65c-424c-97bd-c177d88320c3",
        idempotency_key: "heartbeat:1",
        occurred_at: "2026-07-17T16:00:00.000Z",
        payload: { source: "cloudflare-cron" },
        schema_version: 1,
      }).eventType,
    ).toBe("infra.heartbeat");
  });
});
