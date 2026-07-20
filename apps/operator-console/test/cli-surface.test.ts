import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = ["tsx", "src/cli.ts"];
// vitest/vite patches the global URL constructor so relative resolution
// against import.meta.url ("..", import.meta.url) yields a virtual "/@fs/"
// module-graph path rather than a real filesystem path — that path doesn't
// exist, so spawning "npx" against it as cwd fails with ENOENT. vitest runs
// this suite with process.cwd() already at the package root, so use that
// instead.
const cwd = process.cwd();

// ensureEnvironment()'s dotenv load never overrides an already-set
// process.env value, so explicitly setting OPS_API_URL here — even to ""
// — always wins over whatever the repo-root .env file contains. Boolean("")
// is false, which is what the remoteConfigured() gate checks.
async function ops(args: string[], overrides: Record<string, string>) {
  try {
    const { stdout, stderr } = await run("npx", [...CLI, ...args], {
      cwd,
      env: { ...process.env, ...overrides },
    });
    return { code: 0, stderr, stdout };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stderr: e.stderr ?? "",
      stdout: e.stdout ?? "",
    };
  }
}

describe("cli surface", () => {
  it("hides remote and prints the footer when unconfigured", async () => {
    const { stdout } = await ops(["--help"], { OPS_API_URL: "" });
    expect(stdout).toContain("start here: pnpm ops onboard");
    expect(stdout).toContain("remote: not configured");
    expect(stdout).not.toMatch(/^\s+remote\s/m);
  });

  it("shows remote when configured", async () => {
    const { stdout } = await ops(["--help"], {
      OPS_API_URL: "https://ops.example.workers.dev",
    });
    expect(stdout).toMatch(/Remote:/);
  });

  it("old top-level names point to remote and exit 2", async () => {
    const { code, stderr } = await ops(["health"], {
      OPS_API_URL: "https://ops.example.workers.dev",
    });
    expect(stderr).toContain("moved: pnpm ops remote health");
    expect(code).toBe(2);
  });

  it("remote subcommand exits 3 when unconfigured", async () => {
    const { code, stderr } = await ops(["remote", "queues"], {
      OPS_API_URL: "",
    });
    expect(stderr).toContain("not configured");
    expect(code).toBe(3);
  });
});
