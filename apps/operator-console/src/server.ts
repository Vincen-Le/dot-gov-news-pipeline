import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import {
  loadPipelineRegistry,
  repositoryRoot,
  type PipelineEntry,
  type RequiredOperatorConsoleConfig,
} from "./config";
import { createLabDb, isLocalDsn, labCapability, type LabCapability } from "./lab/db";
import { ExperimentHarness, defaultSpawner } from "./lab/harness";
import { LabelStore, RankLabelStore } from "./lab/labels";
import { namespaceForEngine, namespaceTables } from "./lab/namespace";
import { LabQueries } from "./lab/queries";
import { RankQueries } from "./lab/rank-queries";
import { createLabRouter } from "./lab/routes";
import { WorkerTail, type TailEvent, type TailState } from "./tail-process";

export interface DashboardOptions {
  noOpen?: boolean;
  /** Test-only override for the config/pipelines.json registry; omit to load
   * the real file (or fall back to none, unchanged, when it is absent). */
  pipelines?: PipelineEntry[];
  port?: number;
}

/** Loads config/pipelines.json, falling back to no registered pipelines (the
 * env-only DATABASE_URL default) on any error — a malformed registry must
 * never take down the whole dashboard. */
export function safeLoadRegistryPipelines(path?: string): PipelineEntry[] {
  try {
    return loadPipelineRegistry(path)?.pipelines ?? [];
  } catch (error) {
    console.error(
      `pipeline registry ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

const sessionCookieName = "dot_gov_news_ops_session";

function equalSecret(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function securityHeaders(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  next();
}

function allowedOperatorPath(path: string): boolean {
  return /^\/ops\/v1\/(capabilities|overview|queues|events|inventory\/(summary|runs|sites)|sites\/[^/]+|system\/health)$/u.test(
    path,
  );
}

async function proxyOperatorRequest(
  request: Request,
  response: Response,
  config: RequiredOperatorConsoleConfig,
): Promise<void> {
  const remotePath = request.originalUrl.replace(/^\/api/u, "");
  const remoteUrl = new URL(
    remotePath,
    `${config.apiUrl.replace(/\/$/u, "")}/`,
  );
  if (!allowedOperatorPath(remoteUrl.pathname)) {
    response.status(404).json({ error: { code: "not_found" } });
    return;
  }

  const upstream = await fetch(remoteUrl, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.apiToken}`,
    },
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  response.status(upstream.status);
  response.setHeader(
    "content-type",
    upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
  );
  response.send(await upstream.text());
}

function attachTailEndpoint(
  app: express.Express,
  config: RequiredOperatorConsoleConfig,
): () => Promise<void> {
  const clients = new Set<Response>();
  const tail = new WorkerTail({
    samplingRate: 0.1,
    search: "worker_lifecycle",
    workerName: config.workerName,
  });
  let state: TailState = "idle";

  const broadcast = (type: string, value: unknown): void => {
    const data = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const client of clients) {
      client.write(data);
    }
  };
  tail.on("state", (next: TailState) => {
    state = next;
    broadcast("state", { state });
  });
  tail.on("event", (event: TailEvent) => broadcast("activity", event));
  tail.on("diagnostic", (message: string) =>
    broadcast("diagnostic", { message }),
  );
  tail.on("error", () => broadcast("state", { state: "reconnecting" }));

  app.get("/api/live", (request, response) => {
    response.status(200);
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    clients.add(response);
    response.write(`event: state\ndata: ${JSON.stringify({ state })}\n\n`);
    if (!tail.running) {
      tail.start();
    }
    request.on("close", () => {
      clients.delete(response);
      if (clients.size === 0) void tail.stop();
    });
  });

  return async () => {
    for (const client of clients) client.end();
    clients.clear();
    await tail.stop();
  };
}

/** host:port/dbname only — never credentials. Same rule as pipeline/experiment.py::_dsn_label. */
export function sanitizedDsn(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "not configured";
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port}${url.pathname}`;
  } catch {
    return "invalid";
  }
}

interface LabConnection {
  capability: () => Promise<LabCapability>;
  close: () => Promise<void>;
  harness: ExperimentHarness | null;
  queries: LabQueries | null;
  rankQueries: RankQueries | null;
}

/**
 * One database connection's worth of lab surface: reads (queries,
 * rankQueries), capability, and — only for a local DSN — the experiment
 * harness. `engine` seeds LAB_ENGINE for every stage the harness spawns so a
 * registered pipeline's runs default to its own engine without the caller
 * having to pass it every time (the run form's env still wins if set).
 */
function buildLabConnection(
  databaseUrl: string | undefined,
  engine?: string,
): LabConnection {
  const { experimentRuns, rankSnapshots } = namespaceTables(namespaceForEngine(engine));
  const labDb = databaseUrl === undefined ? null : createLabDb(databaseUrl);
  const queries = labDb === null ? null : new LabQueries(labDb.read, experimentRuns);
  const rankQueries = labDb === null ? null : new RankQueries(labDb.read, rankSnapshots);
  const harness =
    queries !== null && databaseUrl !== undefined && isLocalDsn(databaseUrl)
      ? new ExperimentHarness({
          needsPrepare: () =>
            queries.corpusSummary().then((summary) => summary.needsPrepare),
          spawnStage: defaultSpawner(repositoryRoot, {
            DATABASE_URL: databaseUrl,
            ...(engine === undefined ? {} : { LAB_ENGINE: engine }),
          }),
        })
      : null;
  return {
    capability: () => labCapability(labDb, databaseUrl, engine),
    close: async () => {
      await labDb?.close();
    },
    harness,
    queries,
    rankQueries,
  };
}

function openBrowser(url: string): void {
  const command: { args: string[]; executable: string } =
    process.platform === "darwin"
      ? { args: [url], executable: "open" }
      : process.platform === "win32"
        ? { args: ["/c", "start", "", url], executable: "cmd" }
        : { args: [url], executable: "xdg-open" };
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export async function startDashboard(
  config: RequiredOperatorConsoleConfig,
  options: DashboardOptions = {},
): Promise<{ close: () => Promise<void>; url: string }> {
  const app = express();
  const bootstrapSecret = randomBytes(32).toString("hex");
  const sessionSecret = randomBytes(32).toString("hex");
  let bootstrapClaimed = false;
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use((request, response, next) => {
    const localPort = request.socket.localPort;
    const expectedHost = `127.0.0.1:${String(localPort)}`;
    const expectedOrigin = `http://${expectedHost}`;
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if (
      request.headers.host !== expectedHost ||
      (origin !== undefined && origin !== expectedOrigin) ||
      (fetchSite !== undefined &&
        fetchSite !== "same-origin" &&
        fetchSite !== "none")
    ) {
      response.status(403).send("Local dashboard request rejected");
      return;
    }

    const authenticated = equalSecret(
      cookieValue(request, sessionCookieName),
      sessionSecret,
    );
    const presentedBootstrap =
      typeof request.query.session === "string"
        ? request.query.session
        : undefined;
    if (
      request.path === "/" &&
      !bootstrapClaimed &&
      equalSecret(presentedBootstrap, bootstrapSecret)
    ) {
      bootstrapClaimed = true;
      response.setHeader(
        "set-cookie",
        `${sessionCookieName}=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`,
      );
      response.redirect(303, "/");
      return;
    }
    if (!authenticated) {
      response
        .status(401)
        .send("Restart the dashboard and open its newly generated local URL.");
      return;
    }
    next();
  });
  app.get("/api/ops/v1/*path", (request, response) => {
    void proxyOperatorRequest(request, response, config).catch(() => {
      if (!response.headersSent) {
        response.status(502).json({
          error: {
            code: "operator_api_unavailable",
            message: "Operator API request failed",
            retryable: true,
          },
        });
      }
    });
  });
  const labelsDir = resolve(repositoryRoot, "docs/eval");

  // config/pipelines.json (Task 9): each registered pipeline gets its own
  // connection, mounted under its own (more specific) path before the
  // default `/api/lab` mount below so the single dashboard can switch
  // between them. Absent file → no extra mounts, no behavior change.
  const registryPipelines =
    options.pipelines ?? safeLoadRegistryPipelines();
  const pipelineConnections = new Map<string, LabConnection>();
  for (const entry of registryPipelines) {
    const connection = buildLabConnection(entry.databaseUrl, entry.engine);
    pipelineConnections.set(entry.name, connection);
    app.use(
      `/api/lab/p/${entry.name}`,
      createLabRouter({
        capability: connection.capability,
        harness: connection.harness,
        labels: new LabelStore(labelsDir),
        queries: connection.queries,
        rankLabels: new RankLabelStore(labelsDir),
        rankQueries: connection.rankQueries,
        repoRoot: repositoryRoot,
      }),
    );
  }
  app.get("/api/pipelines", (_request, response) => {
    response.json({
      data: {
        pipelines: registryPipelines.map((entry) => ({
          engine: entry.engine,
          name: entry.name,
        })),
      },
    });
  });

  // The default connection: env-only behavior, unchanged whether or not a
  // registry is present. `pnpm ops lab run` and any dashboard mount that
  // never selects a pipeline keep hitting DATABASE_URL directly.
  const defaultConnection = buildLabConnection(config.databaseUrl);
  app.use(
    "/api/lab",
    createLabRouter({
      capability: defaultConnection.capability,
      harness: defaultConnection.harness,
      labels: new LabelStore(labelsDir),
      queries: defaultConnection.queries,
      rankLabels: new RankLabelStore(labelsDir),
      rankQueries: defaultConnection.rankQueries,
      repoRoot: repositoryRoot,
    }),
  );

  const stopTail = attachTailEndpoint(app, config);

  const consoleRoot = resolve(repositoryRoot, "apps/operator-console");
  const builtUi = resolve(consoleRoot, "dist/ui");
  let vite: ViteDevServer | null = null;
  if (process.env.NODE_ENV === "production" && existsSync(builtUi)) {
    app.use(express.static(builtUi, { etag: false, index: false, maxAge: 0 }));
    const sendIndex = (_request: Request, response: Response) => {
      response.sendFile(resolve(builtUi, "index.html"));
    };
    app.get("/", sendIndex);
    app.get("/*path", sendIndex);
  } else {
    vite = await createViteServer({
      appType: "spa",
      root: consoleRoot,
      server: { middlewareMode: true },
    });
    app.use(vite.middlewares);
  }

  const server = createServer(app);
  const requestedPort = options.port ?? 4173;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null
      ? address.port
      : requestedPort;
  const url = `http://127.0.0.1:${port}/?session=${bootstrapSecret}`;
  if (!options.noOpen) {
    openBrowser(url);
  }

  return {
    async close() {
      await defaultConnection.close();
      await Promise.all(
        [...pipelineConnections.values()].map((connection) =>
          connection.close(),
        ),
      );
      await stopTail();
      await vite?.close();
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) =>
          error === undefined ? resolveClose() : reject(error),
        );
      });
    },
    url,
  };
}
