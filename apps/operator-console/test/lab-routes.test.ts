// apps/operator-console/test/lab-routes.test.ts
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { LabCapability } from "../src/lab/contracts";
import { ExperimentHarness } from "../src/lab/harness";
import { LabelStore } from "../src/lab/labels";
import { createLabRouter, type LabRouteDeps } from "../src/lab/routes";

let server: Server | undefined;
let root: string | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  if (root !== undefined) await rm(root, { force: true, recursive: true });
  root = undefined;
});

const NOT_ENABLED: LabCapability = {
  experimentsEnabled: false,
  reason: "Set DATABASE_URL",
  status: "not_enabled",
};

const RUN_ROW = {
  cacheHits: 2,
  cacheMisses: 0,
  clusterReport: { episodes_closed: 3, processed: 4 },
  config: { near_dup_threshold: 0.87 },
  createdAt: "2026-07-18T11:00:22.000Z",
  durationSeconds: 21,
  finishedAt: "2026-07-18T11:00:21.000Z",
  id: "00000000-0000-4000-8000-0000000000a2",
  name: "near-dup-0.87",
  startedAt: "2026-07-18T11:00:00.000Z",
  summary: null,
};

async function listen(deps: Partial<LabRouteDeps>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "lab-"));
  const app = express();
  app.use(
    "/api/lab",
    createLabRouter({
      capability: async () => NOT_ENABLED,
      harness: null,
      labels: new LabelStore(root),
      queries: null,
      repoRoot: root,
      ...deps,
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) =>
    server?.listen(0, "127.0.0.1", resolve),
  );
  const address = server?.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}/api/lab`;
}

describe("lab routes", () => {
  it("always answers capability and gates reads behind not_enabled", async () => {
    const base = await listen({});
    const capability = await fetch(`${base}/capability`);
    expect(capability.status).toBe(200);
    expect(await capability.json()).toEqual({ data: NOT_ENABLED });
    const corpus = await fetch(`${base}/corpus`);
    expect(corpus.status).toBe(503);
    const body = (await corpus.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("not_enabled");
  });

  it("serves reads and run history when queries are available", async () => {
    const summary = {
      agencies: [],
      clustered: 0,
      embedded: 0,
      enriched: 0,
      entries: 12,
      extracted: 12,
      firstPublishedAt: null,
      lastPublishedAt: null,
      needsPrepare: 12,
      sources: 3,
    };
    const base = await listen({
      capability: async () => ({
        experimentsEnabled: true,
        status: "available",
      }),
      queries: {
        borderlinePairs: async () => [],
        corpusSummary: async () => summary,
        experimentRun: async () => null,
        experimentRuns: async () => [RUN_ROW],
        storylineAgencies: async () => ["fda.gov"],
        storylineDetail: async () => null,
        storylines: async () => [],
      } as never,
    });
    const corpus = await fetch(`${base}/corpus`);
    expect(corpus.status).toBe(200);
    expect(((await corpus.json()) as { data: unknown }).data).toEqual(summary);

    const agencies = await fetch(`${base}/agencies`);
    expect(agencies.status).toBe(200);
    expect(((await agencies.json()) as { data: unknown }).data).toEqual({
      agencies: ["fda.gov"],
    });

    const experiments = await fetch(`${base}/experiments`);
    const payload = (await experiments.json()) as {
      data: { active: unknown; items: { name: string }[] };
    };
    expect(payload.data.active).toBeNull();
    expect(payload.data.items.at(0)?.name).toBe("near-dup-0.87");

    const missingRun = await fetch(`${base}/experiments/nope`);
    expect(missingRun.status).toBe(404);
    const missingStoryline = await fetch(
      `${base}/storylines/00000000-0000-4000-8000-00000000dead`,
    );
    expect(missingStoryline.status).toBe(404);
  });

  it("passes validated storyline filters to queries", async () => {
    let captured: unknown;
    const base = await listen({
      capability: async () => ({
        experimentsEnabled: true,
        status: "available",
      }),
      queries: {
        storylines: async (filter: unknown) => {
          captured = filter;
          return [];
        },
      } as never,
    });
    const ok = await fetch(
      `${base}/storylines?agency=fda.gov&minEpisodes=2&sort=episodes&offset=50`,
    );
    expect(ok.status).toBe(200);
    // the route asks for one extra row to detect whether more pages exist
    expect(captured).toEqual({
      agency: "fda.gov",
      entity: undefined,
      limit: 51,
      minEpisodes: 2,
      offset: 50,
      sort: "episodes",
    });
    await fetch(`${base}/storylines?sort=bogus`);
    expect((captured as { offset?: number; sort?: string }).sort).toBeUndefined();
    expect((captured as { offset?: number }).offset).toBe(0);
  });

  it("reports hasMore and trims the page to the requested limit", async () => {
    const row = (index: number): { id: string } => ({ id: `row-${index}` });
    const base = await listen({
      capability: async () => ({
        experimentsEnabled: true,
        status: "available",
      }),
      queries: {
        storylines: async (filter: { limit: number; offset: number }) =>
          Array.from({ length: filter.limit }, (_, index) =>
            row(filter.offset + index),
          ),
      } as never,
    });
    const first = await fetch(`${base}/storylines?limit=2`);
    const firstBody = (await first.json()) as {
      data: { hasMore: boolean; items: { id: string }[] };
    };
    expect(firstBody.data.items.map((item) => item.id)).toEqual([
      "row-0",
      "row-1",
    ]);
    expect(firstBody.data.hasMore).toBe(true);
  });

  it("validates and appends labels", async () => {
    const base = await listen({});
    const bad = await fetch(`${base}/labels`, {
      body: JSON.stringify({ entryA: "x" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(bad.status).toBe(400);
    const good = await fetch(`${base}/labels`, {
      body: JSON.stringify({
        entryA: "00000000-0000-4000-8000-000000000011",
        entryB: "00000000-0000-4000-8000-000000000012",
        sameEvent: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(good.status).toBe(201);
    const labels = await fetch(`${base}/labels`);
    expect(
      ((await labels.json()) as { data: { count: number } }).data.count,
    ).toBe(1);
  });

  it("starts runs only when experiments are enabled", async () => {
    const disabled = await listen({
      capability: async () => ({
        experimentsEnabled: false,
        experimentsReason: "remote DSN",
        status: "available",
      }),
      harness: null,
      queries: { experimentRuns: async () => [] } as never,
    });
    const refused = await fetch(`${disabled}/experiments`, {
      body: JSON.stringify({ name: "x" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(refused.status).toBe(503);
    expect(
      ((await refused.json()) as { error: { message: string } }).error.message,
    ).toContain("remote DSN");

    const harness = new ExperimentHarness({
      needsPrepare: async () => 0,
      spawnStage: async (_c, _a, _e, onLine) => {
        onLine('{"report": "docs/eval/ok/report.md", "run_id": "run-1"}');
        return 0;
      },
    });
    const enabled = await listen({
      capability: async () => ({
        experimentsEnabled: true,
        status: "available",
      }),
      harness,
      queries: { experimentRuns: async () => [] } as never,
    });
    const accepted = await fetch(`${enabled}/experiments`, {
      body: JSON.stringify({ name: "ok", stub: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(accepted.status).toBe(202);
    const body = (await accepted.json()) as {
      data: { name: string; stages: { name: string }[] };
    };
    expect(body.data.name).toBe("ok");
    expect(body.data.stages.at(-1)?.name).toBe("experiment");
  });

  it("answers 409 run_active while a run holds the single slot", async () => {
    let release: ((exitCode: number) => void) | undefined;
    const harness = new ExperimentHarness({
      needsPrepare: async () => 0,
      spawnStage: () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    });
    const base = await listen({
      capability: async () => ({
        experimentsEnabled: true,
        status: "available",
      }),
      harness,
      queries: { experimentRuns: async () => [] } as never,
    });
    const first = await fetch(`${base}/experiments`, {
      body: JSON.stringify({ name: "one", stub: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(first.status).toBe(202);

    const second = await fetch(`${base}/experiments`, {
      body: JSON.stringify({ name: "two", stub: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("run_active");
    expect(body.error.message).toContain("one");
    release?.(0);
  });

  it("serves experiment reports only for path-safe run names", async () => {
    const runs: Record<string, typeof RUN_ROW> = {
      "00000000-0000-4000-8000-0000000000b1": { ...RUN_ROW, name: "ok" },
      "00000000-0000-4000-8000-0000000000b2": { ...RUN_ROW, name: "missing" },
      "00000000-0000-4000-8000-0000000000b3": { ...RUN_ROW, name: "../evil" },
    };
    const base = await listen({
      capability: async () => ({
        experimentsEnabled: true,
        status: "available",
      }),
      queries: {
        experimentRun: async (id: string) => runs[id] ?? null,
      } as never,
    });
    if (root === undefined) throw new Error("temp root was not created");
    await mkdir(join(root, "docs/eval/ok"), { recursive: true });
    await writeFile(join(root, "docs/eval/ok/report.md"), "# ok report\n");
    // Target of the "../evil" traversal: join(root, "docs/eval", "../evil",
    // "report.md") resolves here. It must never be read.
    await mkdir(join(root, "docs/evil"), { recursive: true });
    await writeFile(join(root, "docs/evil/report.md"), "secret\n");

    const good = await fetch(
      `${base}/experiments/00000000-0000-4000-8000-0000000000b1/report`,
    );
    expect(good.status).toBe(200);
    expect(good.headers.get("content-type")).toContain("text/markdown");
    expect(await good.text()).toBe("# ok report\n");

    const missing = await fetch(
      `${base}/experiments/00000000-0000-4000-8000-0000000000b2/report`,
    );
    expect(missing.status).toBe(404);
    expect(
      ((await missing.json()) as { error: { code: string } }).error.code,
    ).toBe("not_found");

    const traversal = await fetch(
      `${base}/experiments/00000000-0000-4000-8000-0000000000b3/report`,
    );
    expect(traversal.status).toBe(404);
    expect(
      ((await traversal.json()) as { error: { code: string } }).error.code,
    ).toBe("not_found");
  });
});
