import { config as loadDotEnv } from "dotenv";
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
    databaseUrl: process.env.DATABASE_URL,
    environment: process.env.OPS_ENVIRONMENT,
    workerName: process.env.OPS_WORKER_NAME,
  });
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
