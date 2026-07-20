import { config as loadDotEnv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";

import { validateOperatorApiUrl } from "./setup-helpers";

const moduleUrl = new URL(import.meta.url);
export const repositoryRoot =
  moduleUrl.protocol === "file:"
    ? fileURLToPath(new URL("../../../", moduleUrl))
    : resolve(process.cwd(), "../..");

let environmentLoaded = false;

function ensureEnvironment(): void {
  if (environmentLoaded) {
    return;
  }
  loadDotEnv({ path: resolve(repositoryRoot, ".env"), quiet: true });
  environmentLoaded = true;
}

// Local bench database on the port supabase/config.toml pins for this repo.
// DATABASE_URL still overrides (remote read-only DSNs, alternate ports).
export const LOCAL_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:57422/postgres";

const OptionalConfigSchema = z.object({
  apiToken: z.string().min(32).optional(),
  apiUrl: z.string().transform(validateOperatorApiUrl).optional(),
  databaseUrl: z.string().trim().min(1).optional(),
  environment: z.string().trim().min(1).max(40).default("development"),
  workerName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .default("dot-gov-news-pipeline-dev"),
});

export interface OperatorConsoleConfig {
  apiToken?: string;
  apiUrl?: string;
  databaseUrl?: string;
  environment: string;
  workerName: string;
}

export interface RequiredOperatorConsoleConfig extends OperatorConsoleConfig {
  apiToken: string;
  apiUrl: string;
}

export function loadOperatorConfig(): OperatorConsoleConfig {
  ensureEnvironment();
  return OptionalConfigSchema.parse({
    apiToken: process.env.OPS_API_TOKEN,
    apiUrl: process.env.OPS_API_URL,
    databaseUrl: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
    environment: process.env.OPS_ENVIRONMENT,
    workerName: process.env.OPS_WORKER_NAME,
  });
}

/** True when the deployed operator API is configured — gates the remote
 * command group. ensureEnvironment() has already merged .env by the time
 * any caller runs. */
export function remoteConfigured(): boolean {
  ensureEnvironment();
  return Boolean(process.env.OPS_API_URL);
}

export function requireOperatorConfig(): RequiredOperatorConsoleConfig {
  const parsed = loadOperatorConfig();
  if (parsed.apiToken === undefined || parsed.apiUrl === undefined) {
    throw new Error(
      "OPS_API_URL and a token of at least 32 characters are required in the root .env file",
    );
  }
  return { ...parsed, apiToken: parsed.apiToken, apiUrl: parsed.apiUrl };
}

// config/pipelines.json — the registry mapping each pipeline (engine) to its
// own database. See docs/operations/clustering-lab.md#engines. Absent file
// means single-pipeline operation: DATABASE_URL alone governs, unchanged.
const PipelineEntrySchema = z.object({
  databaseUrl: z.string().trim().min(1),
  engine: z.string().trim().min(1).max(64),
  // Becomes a URL path segment (/api/lab/p/<name>) — keep it path-safe.
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, "must be alphanumeric with _ or -"),
});

const PipelineRegistrySchema = z.object({
  pipelines: z.array(PipelineEntrySchema).min(1),
});

export type PipelineEntry = z.infer<typeof PipelineEntrySchema>;
export type PipelineRegistry = z.infer<typeof PipelineRegistrySchema>;

export function loadPipelineRegistry(
  path: string = resolve(repositoryRoot, "config/pipelines.json"),
): PipelineRegistry | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const result = PipelineRegistrySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${path} failed validation: ${z.prettifyError(result.error)}`,
    );
  }
  const seen = new Set<string>();
  for (const entry of result.data.pipelines) {
    if (seen.has(entry.name)) {
      throw new Error(`${path} has a duplicate pipeline name: ${entry.name}`);
    }
    seen.add(entry.name);
  }
  return result.data;
}
