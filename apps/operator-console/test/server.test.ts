import { afterEach, describe, expect, it } from "vitest";

import { startDashboard } from "../src/server";

let closeDashboard: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeDashboard?.();
  closeDashboard = undefined;
});

/** Authenticates against a freshly started dashboard and returns a cookie
 * header usable for subsequent requests. */
async function authenticate(url: string): Promise<string> {
  const bootstrap = await fetch(url, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
  if (cookie === undefined) throw new Error("no session cookie issued");
  return cookie;
}

describe("local dashboard access boundary", () => {
  it("requires the one-time bootstrap URL and then an HttpOnly session", async () => {
    const dashboard = await startDashboard(
      {
        apiToken: "x".repeat(64),
        apiUrl: "https://operator.example.workers.dev",
        environment: "test",
        workerName: "pipeline-worker",
      },
      { noOpen: true, port: 0 },
    );
    closeDashboard = dashboard.close;
    const origin = new URL(dashboard.url).origin;

    const unauthorized = await fetch(origin, { redirect: "manual" });
    expect(unauthorized.status).toBe(401);

    const bootstrap = await fetch(dashboard.url, { redirect: "manual" });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get("location")).toBe("/");
    const cookie = bootstrap.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const authenticated = await fetch(origin, {
      headers: { cookie: cookie?.split(";")[0] ?? "" },
    });
    expect(authenticated.status).toBe(200);

    const replay = await fetch(dashboard.url, { redirect: "manual" });
    expect(replay.status).toBe(401);
  });
});

describe("pipeline registry connection selection", () => {
  it("lists registered pipelines and routes each to its own connection, leaving the env default untouched", async () => {
    const dashboard = await startDashboard(
      {
        apiToken: "x".repeat(64),
        apiUrl: "https://operator.example.workers.dev",
        environment: "test",
        workerName: "pipeline-worker",
      },
      {
        noOpen: true,
        pipelines: [
          {
            databaseUrl: "postgresql://postgres:postgres@127.0.0.1:1/pipeline_a_db",
            engine: "classic",
            name: "pipeline-a",
          },
          {
            databaseUrl: "postgresql://postgres:postgres@127.0.0.1:1/pipeline_b_db",
            engine: "spine",
            name: "pipeline-b",
          },
        ],
        port: 0,
      },
    );
    closeDashboard = dashboard.close;
    const origin = new URL(dashboard.url).origin;
    const cookie = await authenticate(dashboard.url);

    const pipelines = await fetch(`${origin}/api/pipelines`, {
      headers: { cookie },
    });
    expect(pipelines.status).toBe(200);
    const pipelinesBody = (await pipelines.json()) as {
      data: { pipelines: { engine: string; name: string }[] };
    };
    expect(pipelinesBody.data.pipelines).toEqual([
      { engine: "classic", name: "pipeline-a" },
      { engine: "spine", name: "pipeline-b" },
    ]);

    // No DATABASE_URL was passed to this config, so the unscoped /api/lab
    // mount must still report the env-only "not configured" reason — the
    // registry never changes single-pipeline default behavior.
    const defaultCapability = await fetch(`${origin}/api/lab/capability`, {
      headers: { cookie },
    });
    const defaultBody = (await defaultCapability.json()) as {
      data: { reason?: string };
    };
    expect(defaultBody.data.reason).toContain("DATABASE_URL");

    // Each registered pipeline is its own connection: an unreachable (but
    // syntactically local) DSN reports a connection failure, not the
    // "DATABASE_URL is unset" reason above — proving it is a distinct,
    // real attempt rather than a fallback to the default connection.
    const a = await fetch(`${origin}/api/lab/p/pipeline-a/capability`, {
      headers: { cookie },
    });
    const aBody = (await a.json()) as { data: { reason?: string } };
    expect(aBody.data.reason).toBeDefined();
    expect(aBody.data.reason).not.toContain("DATABASE_URL");

    const b = await fetch(`${origin}/api/lab/p/pipeline-b/capability`, {
      headers: { cookie },
    });
    const bBody = (await b.json()) as { data: { reason?: string } };
    expect(bBody.data.reason).toBeDefined();
    expect(bBody.data.reason).not.toContain("DATABASE_URL");
  });
});
