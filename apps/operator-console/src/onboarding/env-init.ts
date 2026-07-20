import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { repositoryRoot } from "../config";
import { writePrivateFileAtomically } from "../setup-helpers";
import { defaultDoctorDeps, validateCloudflare } from "./checks";

export interface EnvInitDeps {
  ask: (question: string) => Promise<string>;
  validateCf: (accountId: string, token: string) => Promise<string | null>;
  probeSql: (dsn: string) => Promise<string | null>;
  readEnv: () => Promise<string>;
  writeEnv: (content: string) => Promise<void>;
  log: (message: string) => void;
}

export function upsertEnvLines(
  content: string,
  updates: Record<string, string>,
): string {
  const lines = content.length > 0 ? content.split("\n") : [];
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    const key = match?.[1];
    if (key !== undefined && updates[key] !== undefined) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  while (next.length > 0 && next[next.length - 1] === "") next.pop();
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  return `${next.join("\n")}\n`;
}

export async function envInit(deps: EnvInitDeps): Promise<void> {
  deps.log("Cloudflare credentials (dashboard → Workers & Pages for the");
  deps.log("account ID; My Profile → API Tokens → 'Workers AI' template).");
  const accountId = (await deps.ask("Cloudflare account ID: ")).trim();
  const token = (await deps.ask("Cloudflare API token: ")).trim();
  const cfError = await deps.validateCf(accountId, token);
  if (cfError !== null) {
    throw new Error(`Cloudflare validation failed: ${cfError}`);
  }
  deps.log("✓ Cloudflare Workers AI reachable");

  const updates: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: token,
  };

  const dsn = (
    await deps.ask(
      "Optional corpus_reader DSN for live hosted reads (enter to skip): ",
    )
  ).trim();
  if (dsn.length > 0) {
    const dsnError = await deps.probeSql(dsn);
    if (dsnError !== null) {
      throw new Error(`Hosted DSN validation failed: ${dsnError}`);
    }
    deps.log("✓ hosted read-only connection ok");
    updates.HOSTED_READONLY_DATABASE_URL = dsn;
  }

  await deps.writeEnv(upsertEnvLines(await deps.readEnv(), updates));
  deps.log("✓ .env written (mode 0600)");
}

export function defaultEnvInitDeps(): { close: () => void; deps: EnvInitDeps } {
  const environmentPath = resolve(repositoryRoot, ".env");
  const readline = createInterface({ input: stdin, output: stdout });
  const doctor = defaultDoctorDeps();
  const deps: EnvInitDeps = {
    ask: (question) => readline.question(question),
    validateCf: (accountId, token) =>
      validateCloudflare(doctor, accountId, token),
    probeSql: doctor.probeSql,
    readEnv: async () => {
      try {
        return await readFile(environmentPath, "utf8");
      } catch {
        return "";
      }
    },
    writeEnv: (content) => writePrivateFileAtomically(environmentPath, content),
    log: (message) => console.log(message),
  };
  return { close: () => readline.close(), deps };
}
