import { describe, expect, it } from "vitest";

import { onboard, type OnboardDeps } from "./onboard";

function fakeDeps(overrides: Partial<OnboardDeps> = {}) {
  const commands: string[] = [];
  const setupCalls: object[] = [];
  const deps: OnboardDeps = {
    doctorTooling: async () => [{ name: "mise", ok: true, detail: "2026.7.1" }],
    envReady: async () => true,
    envInit: async () => {
      commands.push("envInit");
    },
    setupLocal: async (opts) => {
      setupCalls.push(opts);
      commands.push("setupLocal");
      return { ok: true, pipelines: [], steps: [] };
    },
    embeddedCount: async () => 50,
    run: async (command, args) => {
      commands.push([command, ...args].join(" "));
    },
    log: () => undefined,
    ...overrides,
  };
  return { commands, deps, setupCalls };
}

describe("onboard", () => {
  it("delegates local preparation to setupLocal exactly once", async () => {
    const { commands, deps, setupCalls } = fakeDeps();
    await onboard(deps, {});
    expect(setupCalls).toHaveLength(1);
    const joined = commands.join("\n");
    expect(joined).not.toContain("supabase");
    expect(joined).not.toContain("db reset");
    expect(joined).toContain("experiment onboarding-smoke");
  });

  it("forwards fresh and dryRun to setupLocal", async () => {
    const { deps, setupCalls } = fakeDeps();
    await onboard(deps, { dryRun: true, fresh: true });
    expect(setupCalls[0]).toMatchObject({ dryRun: true, fresh: true });
  });

  it("skips env init when credentials exist and runs it when missing", async () => {
    const ready = fakeDeps();
    await onboard(ready.deps, {});
    expect(ready.commands).not.toContain("envInit");

    const missing = fakeDeps({ envReady: async () => false });
    await onboard(missing.deps, {});
    expect(missing.commands[0]).toBe("envInit");
  });

  it("stops with fix guidance when tooling checks fail", async () => {
    const { commands, deps } = fakeDeps({
      doctorTooling: async () => [
        {
          name: "docker",
          ok: false,
          detail: "not found",
          fix: "Install Docker",
        },
      ],
    });
    await expect(onboard(deps, {})).rejects.toThrow("Install Docker");
    expect(commands).toHaveLength(0);
  });

  it("stops when setupLocal reports a broken pipeline", async () => {
    const { deps } = fakeDeps({
      setupLocal: async () => ({
        ok: false,
        pipelines: [
          {
            database: "simple_v1_db",
            engine: "spine",
            entries: null,
            name: "simple_v1",
            status: "broken: provisioning failed",
          },
        ],
        steps: [],
      }),
    });
    await expect(onboard(deps, {})).rejects.toThrow(/simple_v1/);
  });

  it("embeds the sample only when nothing is embedded yet", async () => {
    const embedded = fakeDeps();
    await onboard(embedded.deps, {});
    expect(embedded.commands.join("\n")).not.toContain("prepare --limit 25");

    const empty = fakeDeps({ embeddedCount: async () => 0 });
    await onboard(empty.deps, {});
    expect(empty.commands.join("\n")).toContain("prepare --limit 25");
  });

  it("dry run executes no commands", async () => {
    const logs: string[] = [];
    const { commands, deps } = fakeDeps({
      embeddedCount: async () => 0,
      log: (message) => logs.push(message),
    });
    await onboard(deps, { dryRun: true });
    // setupLocal is still invoked (it handles dryRun itself); nothing else runs.
    expect(commands).toEqual(["setupLocal"]);
    // dry-run should show the conditional step honestly
    expect(logs.join("\n")).toContain("[dry-run] would embed a 25-entry sample");
  });
});
