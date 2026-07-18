import { afterEach, describe, expect, it } from "vitest";

import { startDashboard } from "../src/server";

let closeDashboard: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeDashboard?.();
  closeDashboard = undefined;
});

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
