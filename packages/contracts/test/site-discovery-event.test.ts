import { describe, expect, it } from "vitest";

import {
  parsePipelineEvent,
  SITE_DISCOVERY_EVENT_SCHEMA_VERSION,
} from "../src";

describe("site discovery event contract", () => {
  const event = {
    id: "8ae940f1-c65c-424c-97bd-c177d88320c3",
    schemaVersion: SITE_DISCOVERY_EVENT_SCHEMA_VERSION,
    type: "site.discovery.requested",
    idempotencyKey:
      "site.discovery:10000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000001",
    occurredAt: "2026-07-17T16:00:00.000Z",
    payload: {
      siteId: "10000000-0000-4000-8000-000000000001",
      initialUrl: "agency.gov",
      baseDomain: "agency.gov",
      leaseToken: "20000000-0000-4000-8000-000000000001",
      leaseUntil: "2026-07-17T16:15:00.000Z",
      policyVersion: 1,
    },
  } as const;

  it("accepts a strict lease-bound event", () => {
    expect(parsePipelineEvent(event)).toEqual(event);
  });

  it("rejects unknown event types", () => {
    expect(() =>
      parsePipelineEvent({ ...event, type: "site.unknown" }),
    ).toThrow();
  });

  it("rejects payload fields and oversized hostnames", () => {
    expect(() =>
      parsePipelineEvent({
        ...event,
        payload: { ...event.payload, secret: "unexpected" },
      }),
    ).toThrow();
    expect(() =>
      parsePipelineEvent({
        ...event,
        payload: { ...event.payload, initialUrl: `${"a".repeat(254)}.gov` },
      }),
    ).toThrow();
  });

  it("rejects an idempotency key for a different lease", () => {
    expect(() =>
      parsePipelineEvent({ ...event, idempotencyKey: "site.discovery:wrong" }),
    ).toThrow();
  });

  it("rejects an initial URL outside the claimed base domain", () => {
    expect(() =>
      parsePipelineEvent({
        ...event,
        payload: { ...event.payload, initialUrl: "attacker.example" },
      }),
    ).toThrow();
  });

  it("rejects stale lease chronology without using wall-clock time", () => {
    expect(() =>
      parsePipelineEvent({
        ...event,
        payload: { ...event.payload, leaseUntil: event.occurredAt },
      }),
    ).toThrow();
  });
});
