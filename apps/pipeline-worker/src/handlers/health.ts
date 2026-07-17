import type { WorkerEnv } from "../env";

export interface HealthResponse {
  bindings: {
    artifacts: boolean;
    eventQueue: boolean;
    supabase: boolean;
  };
  buildVersion: string;
  status: "ok";
}

export function handleHealth(request: Request, env: WorkerEnv): Response {
  const url = new URL(request.url);

  if (request.method !== "GET" || url.pathname !== "/health") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const response: HealthResponse = {
    bindings: {
      artifacts: env.ARTIFACTS !== undefined,
      eventQueue: env.PIPELINE_EVENTS_QUEUE !== undefined,
      supabase:
        typeof env.SUPABASE_URL === "string" &&
        env.SUPABASE_URL.startsWith("https://") &&
        typeof env.SUPABASE_SECRET_KEY === "string" &&
        env.SUPABASE_SECRET_KEY.length > 0,
    },
    buildVersion: env.BUILD_VERSION ?? "development",
    status: "ok",
  };

  return Response.json(response);
}
