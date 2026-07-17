import { describe, expect, it } from "vitest";

import { parseDiscoveryConfig } from "../src/discovery/discovery-config";

const validEnv = {
  DISCOVERY_CLAIM_LIMIT: "10",
  DISCOVERY_CONTACT: "https://example.gov/contact",
  DISCOVERY_ENABLED: "true",
  DISCOVERY_LEASE_SECONDS: "900",
  DISCOVERY_MAX_DELAY_SECONDS: "30",
  DISCOVERY_MAX_PUBLISHER_REQUESTS: "36",
  DISCOVERY_POLICY_VERSION: "1",
  DISCOVERY_QUEUE_HIGH_WATER: "20",
  DISCOVERY_SITE_DEADLINE_SECONDS: "600",
};

describe("parseDiscoveryConfig", () => {
  it("parses bounded production defaults once per invocation", () => {
    expect(parseDiscoveryConfig(validEnv)).toEqual({
      claimLimit: 10,
      contact: "https://example.gov/contact",
      enabled: true,
      leaseSeconds: 900,
      maxDelaySeconds: 30,
      maxPublisherRequests: 36,
      policyVersion: 1,
      queueHighWater: 20,
      siteDeadlineMs: 600_000,
      userAgent: "dot-gov-news-pipeline/1 (+https://example.gov/contact)",
    });
  });

  it("allows a blank contact only while dispatch is disabled", () => {
    const disabled = parseDiscoveryConfig({
      ...validEnv,
      DISCOVERY_CONTACT: "",
      DISCOVERY_ENABLED: "false",
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.userAgent).toBeNull();
    expect(() =>
      parseDiscoveryConfig({ ...validEnv, DISCOVERY_CONTACT: "" }),
    ).toThrow(/CONTACT/);
  });

  it("rejects loose booleans, non-integers, and out-of-range values", () => {
    expect(() =>
      parseDiscoveryConfig({ ...validEnv, DISCOVERY_ENABLED: "TRUE" }),
    ).toThrow();
    expect(() =>
      parseDiscoveryConfig({ ...validEnv, DISCOVERY_CLAIM_LIMIT: "1.5" }),
    ).toThrow();
    expect(() =>
      parseDiscoveryConfig({
        ...validEnv,
        DISCOVERY_MAX_PUBLISHER_REQUESTS: "37",
      }),
    ).toThrow();
  });

  it("requires lease cleanup headroom beyond the overall deadline", () => {
    expect(() =>
      parseDiscoveryConfig({
        ...validEnv,
        DISCOVERY_LEASE_SECONDS: "659",
      }),
    ).toThrow(/headroom/);
  });
});
