import { describe, expect, it } from "vitest";

import type { PipelineEntry } from "../../src/config";
import {
  setupLocal,
  type SetupLocalDeps,
} from "../../src/onboarding/setup-local";

const ENTRIES: PipelineEntry[] = [
  {
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/postgres",
    engine: "classic",
    name: "complex_v1",
  },
  {
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/simple_v1_db",
    engine: "spine",
    name: "simple_v1",
  },
];

function fakeDeps(overrides: Partial<SetupLocalDeps> = {}) {
  const commands: string[] = [];
  const provisioned: string[] = [];
  const deps: SetupLocalDeps = {
    confirm: async () => true,
    dbUp: async () => true,
    log: () => undefined,
    registry: () => ({ pipelines: ENTRIES }),
    run: async (command, args) => {
      commands.push([command, ...args].join(" "));
    },
    setupPipeline: async (entry) => {
      provisioned.push(entry.name);
      return {
        database: entry.name === "complex_v1" ? "postgres" : "simple_v1_db",
        engine: entry.engine,
        entries: 10,
        name: entry.name,
        status: "ready",
      };
    },
    ...overrides,
  };
  return { commands, deps, provisioned };
}

describe("setupLocal", () => {
  it("runs migrations, syncs, and fans out to every registry pipeline", async () => {
    const { commands, deps, provisioned } = fakeDeps();
    const report = await setupLocal(deps, {});
    const joined = commands.join("\n");
    expect(joined).toContain("pnpm supabase migration up --local");
    expect(joined).not.toContain("db reset");
    expect(joined).toContain("uv sync");
    expect(joined).toContain("pipeline.cli sync");
    expect(provisioned).toEqual(["complex_v1", "simple_v1"]);
    expect(report.ok).toBe(true);
    expect(report.pipelines).toHaveLength(2);
  });

  it("starts supabase only when the database is down", async () => {
    const up = fakeDeps();
    await setupLocal(up.deps, {});
    expect(up.commands.join("\n")).not.toContain("supabase start");

    const down = fakeDeps({ dbUp: async () => false });
    await setupLocal(down.deps, {});
    expect(down.commands.join("\n")).toContain("pnpm supabase start");
  });

  it("fresh requires confirmation and then resets instead of migrating", async () => {
    const refused = fakeDeps({ confirm: async () => false });
    await expect(setupLocal(refused.deps, { fresh: true })).rejects.toThrow(
      /confirm/i,
    );
    expect(refused.commands.join("\n")).not.toContain("db reset");

    const confirmed = fakeDeps();
    await setupLocal(confirmed.deps, { fresh: true });
    const joined = confirmed.commands.join("\n");
    expect(joined).toContain("pnpm supabase db reset");
    expect(joined).not.toContain("migration up");
  });

  it("--yes skips the confirmation prompt", async () => {
    let asked = false;
    const { deps, commands } = fakeDeps({
      confirm: async () => {
        asked = true;
        return true;
      },
    });
    await setupLocal(deps, { fresh: true, yes: true });
    expect(asked).toBe(false);
    expect(commands.join("\n")).toContain("db reset");
  });

  it("dry run executes nothing but reports the step plan", async () => {
    const { commands, deps, provisioned } = fakeDeps({
      dbUp: async () => false,
    });
    const report = await setupLocal(deps, { dryRun: true });
    expect(commands).toHaveLength(0);
    expect(provisioned).toHaveLength(0);
    expect(report.steps.length).toBeGreaterThan(0);
  });

  it("works without a registry and reports no pipelines", async () => {
    const { deps } = fakeDeps({ registry: () => null });
    const report = await setupLocal(deps, {});
    expect(report.pipelines).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("a broken pipeline does not block the others and flips ok to false", async () => {
    const { deps, provisioned } = fakeDeps({
      setupPipeline: async (entry) => {
        provisioned.push(entry.name);
        return {
          database: "x",
          engine: entry.engine,
          entries: null,
          name: entry.name,
          status:
            entry.name === "complex_v1" ? "broken: missing tables" : "ready",
        };
      },
    });
    const report = await setupLocal(deps, {});
    expect(provisioned).toEqual(["complex_v1", "simple_v1"]);
    expect(report.ok).toBe(false);
  });
});
