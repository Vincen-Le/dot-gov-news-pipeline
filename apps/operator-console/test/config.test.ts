import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_DATABASE_URL,
  loadOperatorConfig,
  loadPipelineRegistry,
  remoteConfigured,
} from "../src/config";

describe("loadOperatorConfig databaseUrl", () => {
  const original = process.env.DATABASE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  it("defaults to the local bench database when DATABASE_URL is unset", () => {
    delete process.env.DATABASE_URL;
    expect(loadOperatorConfig().databaseUrl).toBe(LOCAL_DATABASE_URL);
  });

  it("prefers an explicit DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgresql://u:p@db.example.com:5432/postgres";
    expect(loadOperatorConfig().databaseUrl).toBe(
      "postgresql://u:p@db.example.com:5432/postgres",
    );
  });
});

describe("remoteConfigured", () => {
  it("reflects OPS_API_URL presence", () => {
    const original = process.env.OPS_API_URL;
    try {
      delete process.env.OPS_API_URL;
      expect(remoteConfigured()).toBe(false);
      process.env.OPS_API_URL = "https://ops.example.workers.dev";
      expect(remoteConfigured()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.OPS_API_URL;
      else process.env.OPS_API_URL = original;
    }
  });
});

describe("loadPipelineRegistry", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { force: true, recursive: true });
    root = undefined;
  });

  async function registryPath(contents: string): Promise<string> {
    root = await mkdtemp(join(tmpdir(), "pipelines-"));
    const path = join(root, "pipelines.json");
    await writeFile(path, contents, "utf8");
    return path;
  }

  it("returns null when the registry file is absent (backward compatible)", () => {
    expect(
      loadPipelineRegistry("/nonexistent/config/pipelines.json"),
    ).toBeNull();
  });

  it("parses the documented registry shape", async () => {
    const path = await registryPath(
      JSON.stringify({
        pipelines: [
          {
            databaseUrl:
              "postgresql://postgres:postgres@127.0.0.1:57422/complex_db",
            engine: "classic",
            name: "complex",
          },
          {
            databaseUrl:
              "postgresql://postgres:postgres@127.0.0.1:57422/spine_db",
            engine: "spine",
            name: "spine",
          },
        ],
      }),
    );
    const registry = loadPipelineRegistry(path);
    expect(registry?.pipelines.map((entry) => entry.name)).toEqual([
      "complex",
      "spine",
    ]);
    expect(registry?.pipelines[0]?.engine).toBe("classic");
  });

  it("rejects malformed JSON", async () => {
    const path = await registryPath("not json");
    expect(() => loadPipelineRegistry(path)).toThrow(/not valid JSON/);
  });

  it("rejects an entry missing a required field", async () => {
    const path = await registryPath(
      JSON.stringify({ pipelines: [{ engine: "classic", name: "complex" }] }),
    );
    expect(() => loadPipelineRegistry(path)).toThrow(/failed validation/);
  });

  it("rejects duplicate pipeline names", async () => {
    const path = await registryPath(
      JSON.stringify({
        pipelines: [
          {
            databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/a_db",
            engine: "classic",
            name: "dup",
          },
          {
            databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/b_db",
            engine: "spine",
            name: "dup",
          },
        ],
      }),
    );
    expect(() => loadPipelineRegistry(path)).toThrow(/duplicate pipeline name/);
  });
});
