import { describe, expect, it } from "vitest";

import { envInit, upsertEnvLines, type EnvInitDeps } from "./env-init";

describe("upsertEnvLines", () => {
  it("replaces existing keys and appends missing ones, preserving comments", () => {
    const before = "# comment\nCLOUDFLARE_ACCOUNT_ID=old\nOPS_API_TOKEN=keep\n";
    const after = upsertEnvLines(before, {
      CLOUDFLARE_ACCOUNT_ID: "new",
      CLOUDFLARE_API_TOKEN: "tok",
    });
    expect(after).toContain("# comment");
    expect(after).toContain("CLOUDFLARE_ACCOUNT_ID=new");
    expect(after).toContain("OPS_API_TOKEN=keep");
    expect(after).toContain("CLOUDFLARE_API_TOKEN=tok");
    expect(after).not.toContain("old");
  });

  it("starts from empty content", () => {
    expect(upsertEnvLines("", { A_KEY: "v" })).toBe("A_KEY=v\n");
  });
});

function fakeDeps(answers: string[], overrides: Partial<EnvInitDeps> = {}) {
  const writes: string[] = [];
  const queue = [...answers];
  const deps: EnvInitDeps = {
    ask: async () => queue.shift() ?? "",
    validateCf: async () => null,
    probeSql: async () => null,
    readEnv: async () => "",
    writeEnv: async (content) => {
      writes.push(content);
    },
    log: () => undefined,
    ...overrides,
  };
  return { deps, writes };
}

describe("envInit", () => {
  it("validates and writes cloudflare credentials", async () => {
    const { deps, writes } = fakeDeps(["acct-id", "api-token", ""]);
    await envInit(deps);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("CLOUDFLARE_ACCOUNT_ID=acct-id");
    expect(writes[0]).toContain("CLOUDFLARE_API_TOKEN=api-token");
    expect(writes[0]).not.toContain("HOSTED_READONLY_DATABASE_URL");
  });

  it("writes the optional DSN when provided and probe passes", async () => {
    const { deps, writes } = fakeDeps([
      "acct-id",
      "api-token",
      "postgresql://corpus_reader:pw@pooler.example:5432/postgres",
    ]);
    await envInit(deps);
    expect(writes[0]).toContain("HOSTED_READONLY_DATABASE_URL=postgresql://");
  });

  it("throws with the validation detail when the cloudflare probe fails", async () => {
    const { deps, writes } = fakeDeps(["acct-id", "bad-token", ""], {
      validateCf: async () => "Workers AI probe returned HTTP 403",
    });
    await expect(envInit(deps)).rejects.toThrow("HTTP 403");
    expect(writes).toHaveLength(0);
  });

  it("throws when the optional DSN probe fails", async () => {
    const { deps, writes } = fakeDeps(
      ["acct-id", "api-token", "postgresql://bad"],
      { probeSql: async () => "connection refused" },
    );
    await expect(envInit(deps)).rejects.toThrow("connection refused");
    expect(writes).toHaveLength(0);
  });
});
