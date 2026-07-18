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

import { repositoryRoot, type RequiredOperatorConsoleConfig } from "./config";
import { createLabDb, isLocalDsn, labCapability } from "./lab/db";
import { ExperimentHarness, defaultSpawner } from "./lab/harness";
import { LabelStore } from "./lab/labels";
import { LabQueries } from "./lab/queries";
import { createLabRouter } from "./lab/routes";
import { WorkerTail, type TailEvent, type TailState } from "./tail-process";

export interface DashboardOptions {
  noOpen?: boolean;
  port?: number;
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
  const labDb =
    config.databaseUrl === undefined ? null : createLabDb(config.databaseUrl);
  const labQueries = labDb === null ? null : new LabQueries(labDb.read);
  const labHarness =
    labQueries !== null &&
    config.databaseUrl !== undefined &&
    isLocalDsn(config.databaseUrl)
      ? new ExperimentHarness({
          needsPrepare: () =>
            labQueries.corpusSummary().then((summary) => summary.needsPrepare),
          spawnStage: defaultSpawner(repositoryRoot),
        })
      : null;
  app.use(
    "/api/lab",
    createLabRouter({
      capability: () => labCapability(labDb, config.databaseUrl),
      harness: labHarness,
      labels: new LabelStore(resolve(repositoryRoot, "docs/eval")),
      queries: labQueries,
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
      await labDb?.close();
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
