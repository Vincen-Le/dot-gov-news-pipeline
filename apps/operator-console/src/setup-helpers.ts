import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const ansiEscapePattern = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "gu",
);
const safeUnquotedValuePattern = /^[A-Za-z0-9_./:@+-]+$/u;
const temporaryDirectoryPrefix = "dot-gov-news-operator-";
const activeTemporaryDirectories = new Set<string>();
let cleanupHandlersInstalled = false;

function cleanActiveTemporaryDirectories(): void {
  for (const directory of activeTemporaryDirectories) {
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      // Best-effort emergency cleanup; the normal async finally reports errors.
    }
  }
}

function handleTermination(exitCode: number): void {
  cleanActiveTemporaryDirectories();
  process.exit(exitCode);
}

function installCleanupHandlers(): void {
  if (cleanupHandlersInstalled) return;
  cleanupHandlersInstalled = true;
  process.on("exit", cleanActiveTemporaryDirectories);
  process.on("SIGINT", () => handleTermination(130));
  process.on("SIGTERM", () => handleTermination(143));
}

export interface OperatorEnvironmentValues {
  OPS_API_TOKEN: string;
  OPS_API_URL: string;
  OPS_ENVIRONMENT: string;
  OPS_WORKER_NAME: string;
}

export interface OperatorSecrets {
  OPS_API_TOKEN: string;
  SUPABASE_SECRET_KEY: string;
}

type OperatorHealthStatus = "healthy" | "degraded" | "failed";

interface WaitForOperatorApiOptions {
  apiUrl: string;
  attempts?: number;
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (milliseconds: number) => Promise<void>;
  token: string;
}

function escapeEnvironmentValue(value: string): string {
  if (safeUnquotedValuePattern.test(value)) {
    return value;
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function createOperatorToken(): string {
  return randomBytes(32).toString("hex");
}

export function serializeOperatorSecrets(secrets: OperatorSecrets): string {
  return `${JSON.stringify(secrets)}\n`;
}

export async function withTemporaryOperatorSecrets<T>(
  secrets: OperatorSecrets,
  action: (secretsPath: string) => Promise<T>,
): Promise<T> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), temporaryDirectoryPrefix),
  );
  installCleanupHandlers();
  activeTemporaryDirectories.add(temporaryDirectory);
  const secretsPath = join(temporaryDirectory, "secrets.json");
  try {
    await chmod(temporaryDirectory, 0o700);
    await writeFile(secretsPath, serializeOperatorSecrets(secrets), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(secretsPath, 0o600);
    return await action(secretsPath);
  } finally {
    try {
      await rm(temporaryDirectory, { force: true, recursive: true });
    } finally {
      activeTemporaryDirectories.delete(temporaryDirectory);
    }
  }
}

export async function cleanupStaleOperatorSecretDirectories(
  maximumAgeMs = 60 * 60 * 1_000,
  now = Date.now(),
): Promise<void> {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  const currentUser =
    typeof process.getuid === "function" ? process.getuid() : null;
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith(temporaryDirectoryPrefix),
      )
      .map(async (entry) => {
        const directory = join(tmpdir(), entry.name);
        let stats;
        try {
          stats = await lstat(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (
          now - stats.mtimeMs >= maximumAgeMs &&
          (currentUser === null || stats.uid === currentUser)
        ) {
          await rm(directory, { force: true, recursive: true });
        }
      }),
  );
}

export async function writePrivateFileAtomically(
  targetPath: string,
  contents: string,
): Promise<void> {
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export function validateOperatorApiUrl(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("OPS_API_URL must use HTTPS unless it targets loopback");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("OPS_API_URL must not contain credentials");
  }
  return url.toString().replace(/\/$/u, "");
}

export async function waitForOperatorApi({
  apiUrl,
  attempts = 10,
  fetcher = (input, init) => fetch(input, init),
  sleep = (milliseconds) =>
    new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  token,
}: WaitForOperatorApiOptions): Promise<OperatorHealthStatus> {
  const retryableStatuses = new Set([429, 502, 503, 504]);
  const healthUrl = new URL("/ops/v1/system/health?depth=deep", apiUrl);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetcher(healthUrl, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      lastError = error;
    }

    if (response !== undefined) {
      if (!response.ok) {
        const error = new Error(
          `Operator API returned HTTP ${String(response.status)}`,
        );
        if (!retryableStatuses.has(response.status)) {
          throw error;
        }
        lastError = error;
      } else {
        const payload = (await response.json()) as {
          data?: { status?: string };
        };
        const status = payload.data?.status;
        if (
          status !== "healthy" &&
          status !== "degraded" &&
          status !== "failed"
        ) {
          throw new Error(
            "Operator API returned an unexpected health response",
          );
        }
        return status;
      }
    }

    if (attempt < attempts) {
      await sleep(2_000);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Operator API verification failed");
}

export function selectOperatorToken(
  existingToken: string | undefined,
  generateToken: () => string = createOperatorToken,
): { generated: boolean; token: string } {
  const normalized = existingToken?.trim();
  if (
    normalized !== undefined &&
    normalized.length >= 32 &&
    !normalized.startsWith("replace-with-")
  ) {
    return { generated: false, token: normalized };
  }
  return { generated: true, token: generateToken() };
}

export function findWorkersDevUrl(output: string): string | undefined {
  const normalized = output.replace(ansiEscapePattern, "");
  const candidates = normalized.match(/https:\/\/[^\s<>"']+/gu) ?? [];
  return candidates
    .map((candidate) => candidate.replace(/[),.;\]}]+$/u, ""))
    .find((candidate) => {
      try {
        return new URL(candidate).hostname.endsWith(".workers.dev");
      } catch {
        return false;
      }
    });
}

export function upsertOperatorEnvironment(
  source: string,
  values: OperatorEnvironmentValues,
): string {
  const lines =
    source.length === 0 ? [] : source.replace(/\n$/u, "").split("\n");
  const replacements = new Map(
    Object.entries(values).map(([key, value]) => [
      key,
      `${key}=${escapeEnvironmentValue(value)}`,
    ]),
  );
  const seen = new Set<string>();
  const updated: string[] = [];
  for (const line of lines) {
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
    const key = match?.[1];
    if (key === undefined || !replacements.has(key)) {
      updated.push(line);
      continue;
    }
    if (!seen.has(key)) {
      updated.push(replacements.get(key) ?? line);
      seen.add(key);
    }
  }
  const pending = [...replacements.entries()]
    .filter(([key]) => !seen.has(key))
    .map(([, value]) => value);

  if (pending.length > 0) {
    if (updated.length > 0 && updated.at(-1) !== "") {
      updated.push("");
    }
    updated.push(
      "# Local operator console (managed by pnpm ops:setup).",
      ...pending,
    );
  }

  return `${updated.join("\n")}\n`;
}
