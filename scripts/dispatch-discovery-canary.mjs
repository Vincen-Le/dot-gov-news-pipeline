import { randomUUID } from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function supabaseRpc(name, body, configuration) {
  const response = await fetch(
    `${configuration.supabaseUrl}/rest/v1/rpc/${name}`,
    {
      body: JSON.stringify(body),
      headers: {
        apikey: configuration.supabaseSecretKey,
        Authorization: `Bearer ${configuration.supabaseSecretKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(`Supabase RPC ${name} failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function releaseClaim(claim, configuration) {
  const released = await supabaseRpc(
    "release_site_discovery_lease",
    {
      p_lease_token: claim.lease_token,
      p_reason_code: "operator_enqueue_failed",
      p_site_id: claim.site_id,
    },
    configuration,
  );
  if (released !== true) {
    throw new Error("The canary lease could not be released");
  }
}

async function main() {
  const siteId = process.argv[2]?.trim();
  if (!siteId || !UUID_PATTERN.test(siteId)) {
    throw new Error(
      "Usage: pnpm discovery:dispatch-canary <reviewed-site-uuid>",
    );
  }

  const configuration = {
    accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: requiredEnvironment("CLOUDFLARE_API_TOKEN"),
    leaseSeconds: Number(process.env.DISCOVERY_LEASE_SECONDS ?? "900"),
    policyVersion: Number(process.env.DISCOVERY_POLICY_VERSION ?? "1"),
    queueId: requiredEnvironment("CLOUDFLARE_DISCOVERY_QUEUE_ID"),
    supabaseSecretKey: requiredEnvironment("SUPABASE_SECRET_KEY"),
    supabaseUrl: requiredEnvironment("SUPABASE_URL").replace(/\/$/, ""),
  };
  if (
    !Number.isInteger(configuration.leaseSeconds) ||
    configuration.leaseSeconds < 30 ||
    configuration.leaseSeconds > 3_600 ||
    !Number.isInteger(configuration.policyVersion) ||
    configuration.policyVersion < 1
  ) {
    throw new Error("Discovery lease or policy configuration is invalid");
  }

  const claims = await supabaseRpc(
    "claim_due_site_discoveries",
    {
      p_claim_limit: 1,
      p_lease_seconds: configuration.leaseSeconds,
      p_worker_id: randomUUID(),
    },
    configuration,
  );
  if (!Array.isArray(claims) || claims.length !== 1) {
    throw new Error("Expected exactly one due discovery canary site");
  }
  const claim = claims[0];
  if (
    claim?.site_id !== siteId ||
    typeof claim.initial_url !== "string" ||
    typeof claim.base_domain !== "string" ||
    typeof claim.lease_token !== "string" ||
    typeof claim.lease_until !== "string"
  ) {
    if (claim?.site_id && claim?.lease_token) {
      await releaseClaim(claim, configuration);
    }
    throw new Error("The claimed site did not match the reviewed canary site");
  }

  const occurredAt = new Date().toISOString();
  const event = {
    id: randomUUID(),
    idempotencyKey: `site.discovery:${claim.site_id}:${claim.lease_token}`,
    occurredAt,
    payload: {
      baseDomain: claim.base_domain,
      initialUrl: claim.initial_url,
      leaseToken: claim.lease_token,
      leaseUntil: claim.lease_until,
      policyVersion: configuration.policyVersion,
      siteId: claim.site_id,
    },
    schemaVersion: 1,
    type: "site.discovery.requested",
  };

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${configuration.accountId}/queues/${configuration.queueId}/messages`,
      {
        body: JSON.stringify({ body: event }),
        headers: {
          Authorization: `Bearer ${configuration.apiToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.success === false) {
      throw new Error(
        `Cloudflare Queue push failed with HTTP ${response.status}`,
      );
    }
  } catch (error) {
    try {
      await releaseClaim(claim, configuration);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Queue push and lease compensation both failed",
        { cause: releaseError },
      );
    }
    throw error;
  }

  console.log(
    JSON.stringify({
      eventId: event.id,
      outcome: "enqueued",
      siteId: claim.site_id,
    }),
  );
}

await main();
