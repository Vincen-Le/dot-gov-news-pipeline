import { describe, expect, it } from "vitest";

import { onboard, type OnboardDeps } from "./onboard";

function fakeDeps(overrides: Partial<OnboardDeps> = {}) {
  const commands: string[] = [];
  const deps: OnboardDeps = {
    doctorTooling: async () => [{ name: "mise", ok: true, detail: "2026.7.1" }],
    envReady: async () => true,
    envInit: async () => {
      commands.push("envInit");
    },
    dbUp: async () => true,
    corpusCount: async () => 1000,
    embeddedCount: async () => 50,
    run: async (command, args) => {
      commands.push([command, ...args].join(" "));
    },
    log: () => undefined,
    ...overrides,
  };
  return { deps, commands };
}

describe("onboard", () => {
  it("skips env init, db start, reset, and prepare when state is already good", async () => {
    const { deps, commands } = fakeDeps();
    await onboard(deps, {});
    expect(commands).not.toContain("envInit");
    expect(commands.join("\n")).not.toContain("supabase start");
    expect(commands.join("\n")).not.toContain("db reset");
    expect(commands.join("\n")).not.toContain("prepare");
    // Always refreshes corpus and runs the smoke experiment.
    expect(commands.join("\n")).toContain("pipeline.cli sync");
    expect(commands.join("\n")).toContain("experiment onboarding-smoke");
  });

  it("runs every step on a fresh machine", async () => {
    const { deps, commands } = fakeDeps({
      envReady: async () => false,
      dbUp: async () => false,
      corpusCount: async () => 0,
      embeddedCount: async () => 0,
    });
    await onboard(deps, {});
    const joined = commands.join("\n");
    expect(commands[0]).toBe("envInit");
    expect(joined).toContain("supabase start");
    expect(joined).toContain("supabase db reset");
    expect(joined).toContain("uv sync");
    expect(joined).toContain("pipeline.cli sync");
    expect(joined).toContain("pipeline.cli prepare --limit 25");
    expect(joined).toContain("pipeline.cli experiment onboarding-smoke");
  });

  it("stops with fix guidance when tooling checks fail", async () => {
    const { deps, commands } = fakeDeps({
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

  it("dry run performs checks but executes nothing", async () => {
    const { deps, commands } = fakeDeps({ corpusCount: async () => 0 });
    await onboard(deps, { dryRun: true });
    expect(commands).toHaveLength(0);
  });

  it("dry run reports real counts when the db is up, and would-reset when empty", async () => {
    const logs: string[] = [];
    const { deps, commands } = fakeDeps({
      dbUp: async () => true,
      corpusCount: async () => 0,
      embeddedCount: async () => 0,
      log: (message) => logs.push(message),
    });
    await onboard(deps, { dryRun: true });
    expect(commands).toHaveLength(0);
    expect(logs).toContain("[dry-run] would apply migrations (supabase db reset)");
    expect(logs).toContain(
      "[dry-run] would embed a 25-entry sample with your Cloudflare models",
    );
  });

  it("dry run treats counts as 0 when the db is down, without probing it", async () => {
    const logs: string[] = [];
    const { deps, commands } = fakeDeps({
      dbUp: async () => false,
      corpusCount: async () => {
        throw new Error("corpusCount should not be called when db is down");
      },
      embeddedCount: async () => {
        throw new Error("embeddedCount should not be called when db is down");
      },
      log: (message) => logs.push(message),
    });
    await onboard(deps, { dryRun: true });
    expect(commands).toHaveLength(0);
    expect(logs).toContain("[dry-run] would start local supabase");
    expect(logs).toContain("[dry-run] would apply migrations (supabase db reset)");
    expect(logs).toContain(
      "[dry-run] would embed a 25-entry sample with your Cloudflare models",
    );
  });

  it("fresh forces a db reset even with an existing corpus", async () => {
    const { deps, commands } = fakeDeps();
    await onboard(deps, { fresh: true });
    expect(commands.join("\n")).toContain("supabase db reset");
  });
});
