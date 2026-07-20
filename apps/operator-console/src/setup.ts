#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parse as parseDotEnv } from "dotenv";
import { Command } from "commander";

import { repositoryRoot } from "./config";
import {
  findWorkersDevUrl,
  cleanupStaleOperatorSecretDirectories,
  selectOperatorToken,
  upsertOperatorEnvironment,
  validateOperatorApiUrl,
  waitForOperatorApi,
  withTemporaryOperatorSecrets,
  writePrivateFileAtomically,
} from "./setup-helpers";

interface CommandOptions {
  capture?: boolean;
  input?: string;
  quiet?: boolean;
}

interface SetupOptions {
  apiUrl?: string;
  dryRun?: boolean;
  rotateToken?: boolean;
  yes?: boolean;
}

const operatorApiRoot = resolve(repositoryRoot, "apps/operator-api");
const environmentPath = resolve(repositoryRoot, ".env");
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

async function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: operatorApiRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (!options.quiet) stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.once("error", rejectCommand);
    child.once("close", (code) => {
      if (code === 0) {
        resolveCommand(options.capture ? output : "");
      } else {
        rejectCommand(
          new Error(
            `${executable} ${args.join(" ")} exited with code ${String(code)}`,
          ),
        );
      }
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function runWrangler(
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  return runCommand(pnpmExecutable, ["exec", "wrangler", ...args], options);
}

async function readEnvironment(): Promise<{
  parsed: Record<string, string>;
  source: string;
}> {
  try {
    const source = await readFile(environmentPath, "utf8");
    return { parsed: parseDotEnv(source), source };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { parsed: {}, source: "" };
    }
    throw error;
  }
}

async function confirmDeployment(): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      "Interactive confirmation is unavailable; rerun with --yes",
    );
  }
  const prompts = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompts.question(
      "Deploy and enable the read-only Operator API in Cloudflare? [y/N] ",
    );
    return (
      answer.trim().toLowerCase() === "y" ||
      answer.trim().toLowerCase() === "yes"
    );
  } finally {
    prompts.close();
  }
}

async function ensureCloudflareAuthentication(): Promise<void> {
  try {
    await runWrangler(["whoami", "--json"], { quiet: true });
    return;
  } catch {
    if (!stdin.isTTY) {
      throw new Error(
        "Cloudflare authentication is required; run pnpm --filter @dot-gov-news/operator-api exec wrangler login",
      );
    }
  }
  stdout.write("Cloudflare login is required; opening the browser flow.\n");
  await runWrangler(["login"]);
  await runWrangler(["whoami", "--json"], { quiet: true });
}

async function validateRemoteApi(apiUrl: string, token: string): Promise<void> {
  const status = await waitForOperatorApi({ apiUrl, token });
  stdout.write(
    `Operator API authenticated successfully (health: ${status}).\n`,
  );
}

async function runSetup(options: SetupOptions): Promise<void> {
  const nodeMajor = Number.parseInt(
    process.versions.node.split(".")[0] ?? "0",
    10,
  );
  if (nodeMajor !== 24) {
    process.stderr.write(
      `Warning: this repository is tested with Node 24; current version is ${process.versions.node}.\n`,
    );
  }
  if (options.apiUrl !== undefined) validateOperatorApiUrl(options.apiUrl);

  stdout.write(
    "Validating the Operator API bundle and Cloudflare bindings...\n",
  );
  await runWrangler([
    "deploy",
    "--dry-run",
    "--outdir",
    resolve(repositoryRoot, "dist/operator-api-bootstrap"),
  ]);
  if (options.dryRun) {
    stdout.write(
      "Dry run complete. No Cloudflare or local configuration was changed.\n",
    );
    return;
  }

  await cleanupStaleOperatorSecretDirectories();
  try {
    await chmod(environmentPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { parsed, source } = await readEnvironment();
  const supabaseSecret =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    parsed.SUPABASE_SECRET_KEY?.trim();
  if (supabaseSecret === undefined || supabaseSecret.length === 0) {
    throw new Error(
      "SUPABASE_SECRET_KEY is required in the root .env file or current shell",
    );
  }
  const selectedToken = selectOperatorToken(
    options.rotateToken
      ? undefined
      : (process.env.OPS_API_TOKEN ?? parsed.OPS_API_TOKEN),
  );

  if (!options.yes && !(await confirmDeployment())) {
    stdout.write("Setup canceled.\n");
    return;
  }
  await ensureCloudflareAuthentication();

  let apiUrl = "";
  await withTemporaryOperatorSecrets(
    {
      OPS_API_TOKEN: selectedToken.token,
      SUPABASE_SECRET_KEY: supabaseSecret,
    },
    async (secretsPath) => {
      stdout.write(
        "Deploying the Operator API with its kill switch disabled and required secrets present...\n",
      );
      const disabledOutput = await runWrangler(
        ["deploy", "--secrets-file", secretsPath],
        { capture: true },
      );
      const configuredApiUrl = process.env.OPS_API_URL ?? parsed.OPS_API_URL;
      const detectedApiUrl =
        options.apiUrl ??
        findWorkersDevUrl(disabledOutput) ??
        (configuredApiUrl?.includes(".example.workers.dev")
          ? undefined
          : configuredApiUrl);
      if (detectedApiUrl === undefined) {
        throw new Error(
          "The disabled deployment succeeded, but its workers.dev URL could not be detected; rerun with --api-url <url>",
        );
      }
      apiUrl = validateOperatorApiUrl(detectedApiUrl);
      const nextEnvironment = upsertOperatorEnvironment(source, {
        OPS_API_TOKEN: selectedToken.token,
        OPS_API_URL: apiUrl,
        OPS_ENVIRONMENT:
          process.env.OPS_ENVIRONMENT ??
          parsed.OPS_ENVIRONMENT ??
          "development",
        OPS_WORKER_NAME:
          process.env.OPS_WORKER_NAME ??
          parsed.OPS_WORKER_NAME ??
          "dot-gov-news-pipeline-dev",
      });
      await writePrivateFileAtomically(environmentPath, nextEnvironment);

      try {
        stdout.write("Enabling the deployed read-only Operator API...\n");
        await runWrangler([
          "deploy",
          "--secrets-file",
          secretsPath,
          "--var",
          "OPS_API_ENABLED:true",
        ]);
        await validateRemoteApi(apiUrl, selectedToken.token);
      } catch (error) {
        process.stderr.write(
          "Enabled deployment or verification failed; restoring the disabled kill-switch deployment.\n",
        );
        await runWrangler(["deploy", "--secrets-file", secretsPath], {
          quiet: true,
        }).catch(() => undefined);
        throw error;
      }
    },
  );
  stdout.write(
    `${selectedToken.generated ? "Generated" : "Reused"} the Operator API token and configured the ignored root .env file.\n`,
  );
  stdout.write("Setup complete. Start the dashboard with: pnpm ops:start\n");
}

const program = new Command()
  .name("ops:deploy")
  .description(
    "Deploy the Operator API and configure the local operator console",
  )
  .option("--api-url <url>", "override URL detection after deployment")
  .option(
    "--dry-run",
    "validate the bundle without changing Cloudflare or .env",
  )
  .option("--rotate-token", "generate and deploy a new Operator API token")
  .option("--yes", "skip the deployment confirmation prompt")
  .action(async (options: SetupOptions) => runSetup(options));

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Operator setup failed"}\n`,
  );
  process.exitCode = 1;
}
