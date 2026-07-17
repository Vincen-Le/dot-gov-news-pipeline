import type { WorkerEnv } from "../env";

export interface DiscoveryConfig {
  claimLimit: number;
  contact: string | null;
  enabled: boolean;
  leaseSeconds: number;
  maxDelaySeconds: number;
  maxPublisherRequests: number;
  policyVersion: number;
  queueHighWater: number;
  siteDeadlineMs: number;
  userAgent: string | null;
}

type DiscoveryConfigEnv = Pick<
  WorkerEnv,
  | "DISCOVERY_CLAIM_LIMIT"
  | "DISCOVERY_CONTACT"
  | "DISCOVERY_ENABLED"
  | "DISCOVERY_LEASE_SECONDS"
  | "DISCOVERY_MAX_DELAY_SECONDS"
  | "DISCOVERY_MAX_PUBLISHER_REQUESTS"
  | "DISCOVERY_POLICY_VERSION"
  | "DISCOVERY_QUEUE_HIGH_WATER"
  | "DISCOVERY_SITE_DEADLINE_SECONDS"
>;

function parseBoolean(name: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly true or false`);
}

function parseInteger(
  name: string,
  value: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseContact(value: string): string | null {
  const contact = value.trim();
  if (contact.length === 0) return null;
  const hasControlCharacter = Array.from(contact).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (contact.length > 180 || hasControlCharacter) {
    throw new Error("DISCOVERY_CONTACT is invalid");
  }

  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
  let isHttpsUrl: boolean;
  try {
    const url = new URL(contact);
    isHttpsUrl =
      url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    isHttpsUrl = false;
  }
  if (!isEmail && !isHttpsUrl) {
    throw new Error("DISCOVERY_CONTACT must be an email address or HTTPS URL");
  }
  return contact;
}

export function parseDiscoveryConfig(env: DiscoveryConfigEnv): DiscoveryConfig {
  const enabled = parseBoolean("DISCOVERY_ENABLED", env.DISCOVERY_ENABLED);
  const contact = parseContact(env.DISCOVERY_CONTACT);
  const claimLimit = parseInteger(
    "DISCOVERY_CLAIM_LIMIT",
    env.DISCOVERY_CLAIM_LIMIT,
    1,
    25,
  );
  const leaseSeconds = parseInteger(
    "DISCOVERY_LEASE_SECONDS",
    env.DISCOVERY_LEASE_SECONDS,
    30,
    3_600,
  );
  const siteDeadlineSeconds = parseInteger(
    "DISCOVERY_SITE_DEADLINE_SECONDS",
    env.DISCOVERY_SITE_DEADLINE_SECONDS,
    15,
    3_300,
  );

  if (leaseSeconds < siteDeadlineSeconds + 60) {
    throw new Error(
      "DISCOVERY_LEASE_SECONDS must include at least 60 seconds of cleanup headroom",
    );
  }
  if (enabled && contact === null) {
    throw new Error("DISCOVERY_CONTACT is required when discovery is enabled");
  }

  const userAgent =
    contact === null ? null : `dot-gov-news-pipeline/1 (+${contact})`;
  if (userAgent !== null && userAgent.length > 256) {
    throw new Error("discovery User-Agent is too long");
  }

  return {
    claimLimit,
    contact,
    enabled,
    leaseSeconds,
    maxDelaySeconds: parseInteger(
      "DISCOVERY_MAX_DELAY_SECONDS",
      env.DISCOVERY_MAX_DELAY_SECONDS,
      0,
      900,
    ),
    maxPublisherRequests: parseInteger(
      "DISCOVERY_MAX_PUBLISHER_REQUESTS",
      env.DISCOVERY_MAX_PUBLISHER_REQUESTS,
      1,
      36,
    ),
    policyVersion: parseInteger(
      "DISCOVERY_POLICY_VERSION",
      env.DISCOVERY_POLICY_VERSION,
      1,
      1_000_000,
    ),
    queueHighWater: parseInteger(
      "DISCOVERY_QUEUE_HIGH_WATER",
      env.DISCOVERY_QUEUE_HIGH_WATER,
      1,
      10_000,
    ),
    siteDeadlineMs: siteDeadlineSeconds * 1_000,
    userAgent,
  };
}
