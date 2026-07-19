import { describe, expect, it } from "vitest";

import { runDoctor, type DoctorDeps } from "./checks";

function fakeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    execVersion: async (cmd) =>
      ({
        mise: "2026.7.1",
        node: "v24.4.0",
        pnpm: "11.9.0",
        uv: "uv 0.9.2",
        docker: "28.1.0",
      })[cmd] ?? null,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ success: true, result: [] }), {
        status: 200,
      })) as typeof fetch,
    probeSql: async () => null,
    env: {
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "token",
    },
    hosted: {
      supabaseUrl: "https://x.supabase.co",
      publishableKey: "sb_publishable_abc",
    },
    ...overrides,
  };
}

describe("runDoctor", () => {
  it("passes every check with a healthy environment", async () => {
    const results = await runDoctor(fakeDeps());
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.name)).toContain("cloudflare token");
  });

  it("fails the node check on a wrong major version", async () => {
    const deps = fakeDeps({
      execVersion: async (cmd) => (cmd === "node" ? "v22.1.0" : "1.0.0"),
    });
    const results = await runDoctor(deps, { toolingOnly: true });
    const node = results.find((r) => r.name === "node");
    expect(node?.ok).toBe(false);
    expect(node?.fix).toContain("mise install");
  });

  it("reports a missing tool with its fix command", async () => {
    const deps = fakeDeps({ execVersion: async () => null });
    const results = await runDoctor(deps, { toolingOnly: true });
    expect(results.every((r) => !r.ok)).toBe(true);
    const docker = results.find((r) => r.name === "docker");
    expect(docker?.fix).toContain("Docker");
  });

  it("toolingOnly skips credential and database checks", async () => {
    const results = await runDoctor(fakeDeps(), { toolingOnly: true });
    const names = results.map((r) => r.name);
    expect(names).not.toContain("cloudflare token");
    expect(names).not.toContain("local database");
  });

  it("flags an unconfigured publishable key", async () => {
    const deps = fakeDeps({
      hosted: {
        supabaseUrl: "https://x.supabase.co",
        publishableKey: "REPLACE_WITH_SB_PUBLISHABLE_KEY",
      },
    });
    const results = await runDoctor(deps);
    const hosted = results.find((r) => r.name === "hosted corpus read");
    expect(hosted?.ok).toBe(false);
    expect(hosted?.fix).toContain("config/hosted.json");
  });

  it("fails the cloudflare check when credentials are absent", async () => {
    const results = await runDoctor(fakeDeps({ env: {} }));
    const cf = results.find((r) => r.name === "cloudflare token");
    expect(cf?.ok).toBe(false);
    expect(cf?.fix).toContain("pnpm ops env init");
  });

  it("treats the optional hosted DSN as ok when unset and failing when broken", async () => {
    const unset = await runDoctor(fakeDeps());
    expect(unset.find((r) => r.name === "hosted direct read")?.ok).toBe(true);

    const broken = await runDoctor(
      fakeDeps({
        env: {
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_API_TOKEN: "token",
          HOSTED_READONLY_DATABASE_URL: "postgresql://bad",
        },
        probeSql: async () => "connection refused",
      }),
    );
    expect(broken.find((r) => r.name === "hosted direct read")?.ok).toBe(false);
  });
});
