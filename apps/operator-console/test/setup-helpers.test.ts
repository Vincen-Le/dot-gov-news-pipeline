import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  findWorkersDevUrl,
  selectOperatorToken,
  serializeOperatorSecrets,
  upsertOperatorEnvironment,
  waitForOperatorApi,
  withTemporaryOperatorSecrets,
  validateOperatorApiUrl,
  writePrivateFileAtomically,
} from "../src/setup-helpers";

describe("operator setup helpers", () => {
  it("reuses an existing valid token", () => {
    const result = selectOperatorToken("x".repeat(32), () => "new-token");
    expect(result).toEqual({ generated: false, token: "x".repeat(32) });
  });

  it("generates a token when the existing value is missing or too short", () => {
    const result = selectOperatorToken("too-short", () => "y".repeat(64));
    expect(result).toEqual({ generated: true, token: "y".repeat(64) });
  });

  it("does not deploy the placeholder token from the env template", () => {
    const result = selectOperatorToken(
      "replace-with-a-random-token-of-at-least-32-characters",
      () => "z".repeat(64),
    );
    expect(result).toEqual({ generated: true, token: "z".repeat(64) });
  });

  it("serializes first-deploy secrets as JSON without interpolation", () => {
    const serialized = serializeOperatorSecrets({
      OPS_API_TOKEN: "token=with=symbols",
      SUPABASE_SECRET_KEY: 'secret"with"quotes',
    });
    expect(JSON.parse(serialized)).toEqual({
      OPS_API_TOKEN: "token=with=symbols",
      SUPABASE_SECRET_KEY: 'secret"with"quotes',
    });
  });

  it("keeps the secrets file available until an asynchronous deployment finishes", async () => {
    let secretsPath = "";
    const result = await withTemporaryOperatorSecrets(
      {
        OPS_API_TOKEN: "x".repeat(64),
        SUPABASE_SECRET_KEY: "supabase-secret",
      },
      async (path) => {
        secretsPath = path;
        await Promise.resolve();
        expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
          OPS_API_TOKEN: "x".repeat(64),
          SUPABASE_SECRET_KEY: "supabase-secret",
        });
        return "deployed";
      },
    );

    expect(result).toBe("deployed");
    await expect(access(secretsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes the secrets file when deployment fails", async () => {
    let secretsPath = "";
    await expect(
      withTemporaryOperatorSecrets(
        {
          OPS_API_TOKEN: "x".repeat(64),
          SUPABASE_SECRET_KEY: "supabase-secret",
        },
        async (path) => {
          secretsPath = path;
          throw new Error("deployment failed");
        },
      ),
    ).rejects.toThrow("deployment failed");
    await expect(access(secretsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits through more than four transient 503s for deployment propagation", async () => {
    const statuses = [503, 503, 503, 503, 200];
    const fetcher = vi.fn(async () => {
      const status = statuses.shift() ?? 200;
      return Response.json(
        status === 200
          ? { data: { status: "degraded" } }
          : { error: { code: "operator_api_disabled" } },
        { status },
      );
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForOperatorApi({
        apiUrl: "https://operator.example.workers.dev",
        fetcher,
        sleep,
        token: "x".repeat(64),
      }),
    ).resolves.toBe("degraded");
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("fails immediately when the deployed API rejects its token", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: { code: "unauthorized" } }, { status: 401 }),
    );
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForOperatorApi({
        apiUrl: "https://operator.example.workers.dev",
        fetcher,
        sleep,
        token: "x".repeat(64),
      }),
    ).rejects.toThrow("HTTP 401");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("extracts the workers.dev URL from colored deployment output", () => {
    const output =
      "\u001b[32mDeployed\u001b[0m https://dot-gov-news-operator-api-dev.example.workers.dev (2.1 sec)";
    expect(findWorkersDevUrl(output)).toBe(
      "https://dot-gov-news-operator-api-dev.example.workers.dev",
    );
  });

  it("preserves unrelated env settings while replacing operator settings", () => {
    const result = upsertOperatorEnvironment(
      "# Existing values\nSUPABASE_URL=https://example.supabase.co\nOPS_API_URL=https://old.example\nOPS_API_TOKEN=old-token\n",
      {
        OPS_API_TOKEN: "z".repeat(64),
        OPS_API_URL: "https://operator.example.workers.dev",
        OPS_ENVIRONMENT: "development",
        OPS_WORKER_NAME: "dot-gov-news-pipeline-dev",
      },
    );

    expect(result).toContain("SUPABASE_URL=https://example.supabase.co");
    expect(result).toContain(
      "OPS_API_URL=https://operator.example.workers.dev",
    );
    expect(result).toContain(`OPS_API_TOKEN=${"z".repeat(64)}`);
    expect(result).not.toContain("OPS_API_TOKEN=old-token");
    expect(result).toContain("OPS_ENVIRONMENT=development");
    expect(result).toContain("OPS_WORKER_NAME=dot-gov-news-pipeline-dev");
  });

  it("removes duplicate operator settings so stale values cannot win", () => {
    const result = upsertOperatorEnvironment(
      "OPS_API_URL=https://first.example\nOPS_API_URL=https://stale.example\n",
      {
        OPS_API_TOKEN: "z".repeat(64),
        OPS_API_URL: "https://operator.example.workers.dev",
        OPS_ENVIRONMENT: "development",
        OPS_WORKER_NAME: "dot-gov-news-pipeline-dev",
      },
    );

    expect(result.match(/^OPS_API_URL=/gmu)).toHaveLength(1);
    expect(result).not.toContain("stale.example");
  });

  it("requires HTTPS for remote Operator API URLs", () => {
    expect(() => validateOperatorApiUrl("http://operator.example")).toThrow(
      /HTTPS/u,
    );
    expect(() =>
      validateOperatorApiUrl("https://user:pass@operator.example"),
    ).toThrow(/credentials/u);
    expect(validateOperatorApiUrl("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("atomically replaces private environment files with mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "operator-env-test-"));
    const path = join(directory, ".env");
    try {
      await writeFile(path, "OLD=value\n", { mode: 0o644 });
      await writePrivateFileAtomically(path, "NEW=value\n");
      expect(await readFile(path, "utf8")).toBe("NEW=value\n");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
