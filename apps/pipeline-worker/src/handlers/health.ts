import type { WorkerEnv } from "../env";
import { parseDiscoveryConfig } from "../discovery/discovery-config";

export interface HealthResponse {
  bindings: {
    artifacts: boolean;
    discoveryQueue: boolean;
    eventQueue: boolean;
    supabase: boolean;
  };
  buildVersion: string;
  discovery: {
    configValid: boolean;
    contactConfigured: boolean;
    enabled: boolean | null;
  };
  status: "ok";
}

export function handleHealth(request: Request, env: WorkerEnv): Response {
  const url = new URL(request.url);

  if (request.method !== "GET" || url.pathname !== "/health") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  let discovery: HealthResponse["discovery"];
  try {
    const config = parseDiscoveryConfig(env);
    discovery = {
      configValid: true,
      contactConfigured: config.contact !== null,
      enabled: config.enabled,
    };
  } catch {
    discovery = {
      configValid: false,
      contactConfigured: env.DISCOVERY_CONTACT.trim().length > 0,
      enabled: null,
    };
  }

  const response: HealthResponse = {
    bindings: {
      artifacts: env.ARTIFACTS !== undefined,
      discoveryQueue: env.SITE_DISCOVERY_QUEUE !== undefined,
      eventQueue: env.PIPELINE_EVENTS_QUEUE !== undefined,
      supabase:
        typeof env.SUPABASE_URL === "string" &&
        env.SUPABASE_URL.startsWith("https://") &&
        typeof env.SUPABASE_SECRET_KEY === "string" &&
        env.SUPABASE_SECRET_KEY.length > 0,
    },
    buildVersion: env.BUILD_VERSION ?? "development",
    discovery,
    status: "ok",
  };

  return Response.json(response);
}
