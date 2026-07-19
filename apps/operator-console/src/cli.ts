#!/usr/bin/env node
import { Command } from "commander";

import { OperatorApiClient, OperatorApiError } from "./api-client";
import {
  loadOperatorConfig,
  repositoryRoot,
  requireOperatorConfig,
} from "./config";
import { generateCheatsheet } from "./generate-cheatsheet";
import {
  createLabDb,
  labCapability,
  type LabCapability,
  type LabDb,
} from "./lab/db";
import { ExperimentHarness, defaultSpawner } from "./lab/harness";
import { snapshotLabMetrics } from "./lab/metrics";
import { LabQueries } from "./lab/queries";
import { defaultDoctorDeps, runDoctor } from "./onboarding/checks";
import { defaultEnvInitDeps, envInit } from "./onboarding/env-init";
import { defaultOnboardDeps, onboard } from "./onboarding/onboard";
import { defaultSetupLocalDeps, setupLocal } from "./onboarding/setup-local";
import { formatAge, printJson, printRows, sinceTimestamp } from "./output";
import { operatorRecipes } from "./recipes";
import { sanitizedDsn, startDashboard } from "./server";
import { WorkerTail, type TailEvent } from "./tail-process";

interface JsonOption {
  json?: boolean;
}

function client(): OperatorApiClient {
  return new OperatorApiClient(requireOperatorConfig());
}

async function runAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof OperatorApiError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      process.exitCode =
        error.status === 401 ? 4 : error.code === "not_enabled" ? 3 : 2;
      return;
    }
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unexpected operator error"}\n`,
    );
    process.exitCode = 2;
  }
}

async function printCapability(
  name: "discovery" | "feeds" | "polling",
  asJson: boolean,
): Promise<void> {
  const response = await client().capabilities();
  const capability = response.data.capabilities[name];
  if (asJson) {
    printJson({ capability: name, ...capability });
  } else {
    process.stdout.write(
      `${name}: ${capability.status}${capability.reason === undefined ? "" : ` — ${capability.reason}`}\n`,
    );
  }
  if (capability.status !== "available") {
    process.exitCode = 3;
  }
}

const program = new Command()
  .name("ops")
  .description("Read-only operator CLI for the dot-gov news pipeline")
  .showHelpAfterError()
  .version("0.1.0");

program
  .command("health")
  .description("Run shallow or deep dependency health checks")
  .option("--deep", "verify the latest R2 artifact as well")
  .option("--json", "print validated JSON only")
  .action((options: JsonOption & { deep?: boolean }) =>
    runAction(async () => {
      const response = await client().health(options.deep ? "deep" : "shallow");
      if (options.json) {
        printJson(response);
      } else {
        process.stdout.write(
          `System ${response.data.status.toUpperCase()} · ${response.data.depth} check\n`,
        );
        printRows(
          response.data.components.map((item) => ({
            component: item.name,
            latency: item.latencyMs === null ? "—" : `${item.latencyMs} ms`,
            message: item.message ?? "",
            status: item.status,
          })),
        );
      }
      if (response.data.status !== "healthy") {
        process.exitCode = 1;
      }
    }),
  );

program
  .command("queues")
  .description("Read realtime Queue and DLQ pressure")
  .option("--json", "print validated JSON only")
  .action((options: JsonOption) =>
    runAction(async () => {
      const response = await client().queues();
      if (options.json) {
        printJson(response);
        return;
      }
      printRows(
        response.data.queues.map((queue) => ({
          backlog: queue.backlogCount ?? "unavailable",
          bytes: queue.backlogBytes ?? "unavailable",
          oldest: formatAge(queue.oldestMessageAt),
          queue: queue.name,
          state: queue.state,
        })),
      );
    }),
  );

program
  .command("doctor")
  .description("Check local toolchain, credentials, and hosted access")
  .option("--json", "machine-readable output")
  .action((options: { json?: boolean }) =>
    runAction(async () => {
      const results = await runDoctor(defaultDoctorDeps());
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const result of results) {
          console.log(
            `${result.ok ? "✓" : "✗"} ${result.name} — ${result.detail}`,
          );
          if (!result.ok && result.fix) console.log(`    fix: ${result.fix}`);
        }
      }
      if (results.some((r) => !r.ok)) process.exitCode = 1;
    }),
  );

const env = program.command("env").description("Manage the local .env file");
env
  .command("init")
  .description("Prompt for contributor credentials, validate, write .env")
  .action(() =>
    runAction(async () => {
      const { close, deps } = defaultEnvInitDeps();
      try {
        await envInit(deps);
      } finally {
        close();
      }
    }),
  );

program
  .command("onboard")
  .description(
    "Guided setup: toolchain, credentials, local db, corpus, smoke run",
  )
  .option("--dry-run", "show the plan and run checks without changing anything")
  .option("--fresh", "force supabase db reset even if a corpus exists")
  .action((options: { dryRun?: boolean; fresh?: boolean }) =>
    runAction(async () => {
      await onboard(defaultOnboardDeps(), {
        dryRun: options.dryRun,
        fresh: options.fresh,
      });
    }),
  );

program
  .command("setup")
  .description(
    "Prepare local databases for every pipeline: stack, migrations, corpus, registry",
  )
  .option(
    "--fresh",
    "wipe and rebuild the local database (asks for confirmation)",
  )
  .option("--yes", "skip the --fresh confirmation prompt")
  .option("--dry-run", "print the step plan without changing anything")
  .option("--json", "print the pipeline report as JSON")
  .action(
    (
      options: JsonOption & {
        dryRun?: boolean;
        fresh?: boolean;
        yes?: boolean;
      },
    ) =>
      runAction(async () => {
        const report = await setupLocal(defaultSetupLocalDeps(), {
          dryRun: options.dryRun,
          fresh: options.fresh,
          yes: options.yes,
        });
        if (options.json) {
          printJson(report);
        } else if (report.pipelines.length > 0) {
          printRows(
            report.pipelines.map((result) => ({
              database: result.database,
              engine: result.engine,
              entries: result.entries ?? "—",
              name: result.name,
              status: result.status,
            })),
          );
        }
        if (!report.ok) process.exitCode = 1;
      }),
  );

const inventory = program
  .command("inventory")
  .description("Inspect GSA inventory synchronization");

inventory
  .command("summary")
  .description("Show the latest inventory verification receipt")
  .option("--json", "print validated JSON only")
  .action((options: JsonOption) =>
    runAction(async () => {
      const response = await client().inventorySummary();
      if (options.json) {
        printJson(response);
        return;
      }
      const { summary, latestRun } = response.data;
      process.stdout.write(
        `Inventory ${latestRun?.status ?? "no runs"} · ${summary.usableCount.toLocaleString()} usable / ${summary.totalCount.toLocaleString()} total\n`,
      );
      printRows([
        {
          active: summary.activeCount,
          excluded: summary.ingestionExcludedCount,
          filtered: summary.gsaFilteredCount,
          inactive: summary.inactiveCount,
          latest: summary.latestSuccessAt ?? "—",
        },
      ]);
    }),
  );

inventory
  .command("runs")
  .description("List inventory synchronization attempts")
  .option("--limit <number>", "maximum rows", "20")
  .option("--status <status>", "filter by run status")
  .option("--json", "print validated JSON only")
  .action((options: JsonOption & { limit: string; status?: string }) =>
    runAction(async () => {
      const response = await client().inventoryRuns({
        limit: Number(options.limit),
        status: options.status,
      });
      if (options.json) {
        printJson(response);
        return;
      }
      printRows(
        response.data.items.map((run) => ({
          completed: run.completedAt ?? "—",
          eligible: run.counts.eligible,
          id: run.id,
          inserted: run.counts.inserted,
          started: run.startedAt,
          status: run.status,
          updated: run.counts.updated,
        })),
      );
    }),
  );

inventory
  .command("sites")
  .description("Search the durable government-site inventory")
  .option("--agency <agency>", "exact agency name")
  .option("--hostname <hostname>", "exact normalized base domain")
  .option("--all", "include unusable and inactive sites")
  .option("--limit <number>", "maximum rows", "50")
  .option("--json", "print validated JSON only")
  .action(
    (
      options: JsonOption & {
        agency?: string;
        all?: boolean;
        hostname?: string;
        limit: string;
      },
    ) =>
      runAction(async () => {
        const response = await client().inventorySites({
          agency: options.agency,
          all: options.all,
          hostname: options.hostname,
          limit: Number(options.limit),
        });
        if (options.json) {
          printJson(response);
          return;
        }
        printRows(
          response.data.items.map((site) => ({
            active: site.inventoryActive,
            agency: site.agency ?? "—",
            discovery: site.discoveryStatus ?? "—",
            hostname: site.baseDomain ?? "—",
            id: site.id,
            usable: site.inventoryUsable,
          })),
        );
      }),
  );

inventory
  .command("diff")
  .description("Compare two inventory run receipts")
  .option("--latest", "compare the two latest runs", true)
  .option("--from <runId>", "older run ID")
  .option("--to <runId>", "newer run ID")
  .option("--json", "print validated JSON only")
  .action((options: JsonOption & { from?: string; to?: string }) =>
    runAction(async () => {
      const response = await client().inventoryRuns({ limit: 250 });
      const to =
        options.to === undefined
          ? response.data.items[0]
          : response.data.items.find((run) => run.id === options.to);
      const from =
        options.from === undefined
          ? response.data.items[1]
          : response.data.items.find((run) => run.id === options.from);
      if (from === undefined || to === undefined) {
        throw new Error(
          "Both comparison runs must be present in the latest 250 runs",
        );
      }
      const diff = {
        eligible: to.counts.eligible - from.counts.eligible,
        from: from.id,
        inserted: to.counts.inserted - from.counts.inserted,
        to: to.id,
        updated: to.counts.updated - from.counts.updated,
      };
      if (options.json) printJson(diff);
      else printRows([diff]);
    }),
  );

const discovery = program
  .command("discovery")
  .description("Inspect discovery state when migration 00400 is enabled");
for (const commandName of ["summary", "active", "failures"] as const) {
  discovery
    .command(commandName)
    .option("--json", "print validated JSON only")
    .option("--since <duration>")
    .option("--code <code>")
    .action((options: JsonOption) =>
      runAction(() => printCapability("discovery", options.json ?? false)),
    );
}

const events = program.command("events").description("Inspect pipeline events");
events
  .command("list")
  .option("--since <duration>", "for example 30m or 2h")
  .option("--type <type>", "exact event type")
  .option("--entity <id>", "entity ID stored in the event payload")
  .option("--limit <number>", "maximum rows", "50")
  .option("--json", "print validated JSON only")
  .action(
    (
      options: JsonOption & {
        entity?: string;
        limit: string;
        since?: string;
        type?: string;
      },
    ) =>
      runAction(async () => {
        const response = await client().events({
          entity: options.entity,
          limit: Number(options.limit),
          since: sinceTimestamp(options.since),
          type: options.type,
        });
        if (options.json) {
          printJson(response);
          return;
        }
        printRows(
          response.data.items.map((event) => ({
            artifact: event.artifactKey ?? "—",
            id: event.id,
            occurred: event.occurredAt,
            type: event.eventType,
          })),
        );
      }),
  );

events
  .command("follow")
  .option("--type <type>")
  .option("--entity <id>")
  .action((options: { entity?: string; type?: string }) =>
    runAction(async () => {
      const seen = new Set<string>();
      let stopped = false;
      process.once("SIGINT", () => {
        stopped = true;
      });
      while (!stopped) {
        const response = await client().events({
          entity: options.entity,
          limit: 50,
          since: new Date(Date.now() - 300_000).toISOString(),
          type: options.type,
        });
        for (const event of [...response.data.items].reverse()) {
          if (!seen.has(event.id)) {
            seen.add(event.id);
            process.stdout.write(
              `${event.occurredAt}  ${event.eventType}  ${event.id}\n`,
            );
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }),
  );

program
  .command("site")
  .description("Site inspection commands")
  .command("inspect <hostname>")
  .option("--include-events", "include recent correlated events", true)
  .option("--json", "print validated JSON only")
  .action((hostname: string, options: JsonOption) =>
    runAction(async () => {
      const response = await client().site(hostname);
      if (options.json) {
        printJson(response);
        return;
      }
      printRows([
        {
          active: response.data.site.inventoryActive,
          agency: response.data.site.agency ?? "—",
          discovery: response.data.site.discoveryStatus ?? "—",
          hostname: response.data.site.baseDomain ?? hostname,
          usable: response.data.site.inventoryUsable,
        },
      ]);
      if (response.data.events.length > 0) {
        printRows(
          response.data.events.map((event) => ({
            occurred: event.occurredAt,
            type: event.eventType,
          })),
        );
      }
    }),
  );

program
  .command("worker")
  .description("Worker observability commands")
  .command("tail")
  .option("--status <status...>", "ok, error, or canceled")
  .option("--search <text>", "structured log text filter", "worker_lifecycle")
  .action(
    (options: {
      search?: string;
      status?: Array<"ok" | "error" | "canceled">;
    }) =>
      runAction(async () => {
        const config = loadOperatorConfig();
        const tail = new WorkerTail({
          samplingRate: 0.1,
          search: options.search,
          status: options.status,
          workerName: config.workerName,
        });
        tail.on("state", (state) =>
          process.stderr.write(`tail: ${String(state)}\n`),
        );
        tail.on("event", (event: TailEvent) => printJson(event));
        tail.on("diagnostic", (line) =>
          process.stderr.write(`${String(line)}\n`),
        );
        tail.on("error", (error) =>
          process.stderr.write(
            `tail error: ${error instanceof Error ? error.message : "unknown failure"}\n`,
          ),
        );
        tail.start();
        await new Promise<void>((resolve) => {
          process.once("SIGINT", async () => {
            await tail.stop();
            resolve();
          });
        });
      }),
  );

program
  .command("dashboard")
  .description("Start the private local dashboard")
  .option("--port <number>", "loopback port", "4173")
  .option("--no-open", "do not open the browser")
  .action((options: { open: boolean; port: string }) =>
    runAction(async () => {
      const config = requireOperatorConfig();
      const dashboard = await startDashboard(config, {
        noOpen: !options.open,
        port: Number(options.port),
      });
      process.stdout.write(`Operator dashboard: ${dashboard.url}\n`);
      process.stdout.write(
        `Lab database: ${sanitizedDsn(config.databaseUrl)}\n`,
      );
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      await dashboard.close();
    }),
  );

program
  .command("examples")
  .option("--json", "print recipe catalog as JSON")
  .action((options: JsonOption) => {
    if (options.json) printJson(operatorRecipes);
    else
      printRows(
        operatorRecipes.map((recipe) => ({
          command: recipe.cli,
          purpose: recipe.description,
        })),
      );
  });

program.command("docs:generate").action(() =>
  runAction(async () => {
    await generateCheatsheet();
    process.stdout.write("Generated docs/operations/cli-cheatsheet.md\n");
  }),
);

interface LabContext {
  capability: LabCapability;
  close(): Promise<void>;
  databaseUrl: string;
  db: LabDb;
  queries: LabQueries;
}

async function withLab(
  action: (context: LabContext) => Promise<void>,
): Promise<void> {
  const config = loadOperatorConfig();
  const db =
    config.databaseUrl === undefined ? null : createLabDb(config.databaseUrl);
  const capability = await labCapability(db, config.databaseUrl);
  if (db === null || capability.status !== "available") {
    await db?.close();
    process.stderr.write(
      `not_enabled: ${capability.reason ?? "clustering lab unavailable"}\n`,
    );
    process.exitCode = 3;
    return;
  }
  const context: LabContext = {
    capability,
    close: () => db.close(),
    databaseUrl: config.databaseUrl ?? "",
    db,
    queries: new LabQueries(db.read),
  };
  try {
    await action(context);
  } finally {
    await context.close();
  }
}

const lab = program
  .command("lab")
  .description("Clustering lab: browse chains, run and compare experiments");

lab
  .command("setup")
  .description("(moved) use: pnpm ops setup")
  .action(() => {
    process.stderr.write("moved: pnpm ops setup\n");
    process.exitCode = 2;
  });

lab
  .command("corpus")
  .description("Corpus receipt, feature coverage, prepare backlog")
  .option("--json", "print JSON only")
  .action((options: JsonOption) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const summary = await queries.corpusSummary();
        if (options.json) {
          printJson(summary);
          return;
        }
        process.stdout.write(
          `Corpus ${summary.entries.toLocaleString()} entries · ${summary.sources} sources · ${summary.firstPublishedAt ?? "—"} → ${summary.lastPublishedAt ?? "—"}\n`,
        );
        printRows([
          {
            clustered: summary.clustered,
            embedded: summary.embedded,
            enriched: summary.enriched,
            extracted: summary.extracted,
            needsPrepare: summary.needsPrepare,
          },
        ]);
        printRows(summary.agencies.slice(0, 15));
      }),
    ),
  );

lab
  .command("storylines")
  .description("List storylines (newest first)")
  .option("--entity <entity>", "filter by extracted entity")
  .option("--agency <publisher-key>", "filter by publisher key, e.g. fda")
  .option("--category <id>", "filter by topic category id")
  .option("--theme <id>", "filter by topic theme id")
  .option("--min-episodes <n>", "only chains with at least n episodes")
  .option("--sort <field>", "episodes: most episodes first")
  .option("--limit <n>", "maximum rows", "50")
  .option("--offset <n>", "skip the first n rows", "0")
  .option("--json", "print JSON only")
  .action(
    (
      options: JsonOption & {
        agency?: string;
        category?: string;
        entity?: string;
        limit: string;
        minEpisodes?: string;
        offset: string;
        sort?: string;
        theme?: string;
      },
    ) =>
      runAction(() =>
        withLab(async ({ queries }) => {
          const items = await queries.storylines({
            agency: options.agency,
            category: options.category,
            entity: options.entity,
            limit: Number(options.limit),
            minEpisodes:
              options.minEpisodes === undefined
                ? undefined
                : Number(options.minEpisodes),
            offset: Number(options.offset),
            sort: options.sort === "episodes" ? "episodes" : undefined,
            theme: options.theme,
          });
          if (options.json) {
            printJson(items);
            return;
          }
          printRows(
            items.map((item) => ({
              entries: item.entryCount,
              episodes: item.episodeCount,
              feeds: item.distinctFeeds,
              headline: item.headline ?? "(no card)",
              id: item.id,
              newest: item.newestEntryAt,
              theme: item.themeName ?? "—",
            })),
          );
        }),
      ),
  );

lab
  .command("themes")
  .description("List topic themes (largest first)")
  .option("--category <id>", "filter by topic category id")
  .option("--json", "print JSON only")
  .action((options: JsonOption & { category?: string }) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const themes = await queries.topicThemes({
          category: options.category,
        });
        if (options.json) {
          printJson(themes);
          return;
        }
        printRows(
          themes.map((theme) => ({
            category: theme.categoryName ?? "(uncategorized)",
            id: theme.id,
            name: theme.displayName,
            origin: theme.categoryOrigin ?? "—",
            storylines: theme.storylineCount,
          })),
        );
      }),
    ),
  );

lab
  .command("storyline <id>")
  .description("Walk one chain: episodes, attach evidence, cards")
  .option("--json", "print JSON only")
  .action((id: string, options: JsonOption) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const detail = await queries.storylineDetail(id);
        if (detail === null) {
          process.stderr.write("not_found: unknown storyline\n");
          process.exitCode = 2;
          return;
        }
        if (options.json) {
          printJson(detail);
          return;
        }
        process.stdout.write(
          `${detail.headline ?? "(no overview card)"} · ${detail.episodeCount} episodes · ${detail.entryCount} entries\n`,
        );
        for (const episode of detail.episodes) {
          process.stdout.write(
            `\n[${episode.status}] ${episode.card?.headline ?? episode.id} — ${episode.attachMethod}${episode.attachSimilarity === null ? "" : ` (sim ${episode.attachSimilarity})`}${episode.attachReason === null ? "" : ` — ${episode.attachReason}`}\n`,
          );
          printRows(
            episode.entries.map((entry) => ({
              agency: entry.agency,
              method: entry.attachMethod,
              published: entry.publishedAt ?? "—",
              similarity:
                entry.similarity === null
                  ? "—"
                  : `${entry.similarity} / ${entry.thresholdUsed ?? "—"}`,
              syndicated: entry.isSyndicated,
              title: entry.title ?? entry.url,
            })),
          );
        }
        const overview = detail.overviewCards[0];
        if (overview?.timeline) {
          process.stdout.write(`\nOverview v${overview.version} timeline:\n`);
          for (const item of overview.timeline) {
            process.stdout.write(
              `  ${item.cited ? "·" : "✗ UNCITED"} ${item.date}  ${item.text}\n`,
            );
          }
        }
      }),
    ),
  );

lab
  .command("metrics")
  .description("Live clustering quality snapshot")
  .option("--json", "print JSON only")
  .action((options: JsonOption) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const metrics = await snapshotLabMetrics(queries);
        if (options.json) {
          printJson(metrics);
          return;
        }
        printRows([metrics.volume]);
        printRows(metrics.attachMix);
        process.stdout.write(
          `singleton rate ${metrics.singletonEpisodeRate ?? "—"} · syndication ${metrics.syndicationRate ?? "—"} · suggested NEAR_DUP_THRESHOLD ${metrics.calibration.suggestedNearDupThreshold ?? "—"}\n`,
        );
      }),
    ),
  );

lab
  .command("borderline")
  .description("Borderline attach decisions awaiting labels")
  .option("--window <w>", "similarity window around the threshold", "0.03")
  .option("--limit <n>", "maximum rows", "50")
  .option("--json", "print JSON only")
  .action((options: JsonOption & { limit: string; window: string }) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const items = await queries.borderlinePairs(
          Number(options.window),
          Number(options.limit),
        );
        if (options.json) printJson(items);
        else
          printRows(
            items.map((pair) => ({
              a: pair.entryTitle ?? pair.entryId,
              b: pair.matchedTitle ?? pair.matchedEntryId ?? "—",
              method: pair.attachMethod,
              similarity: `${pair.similarity} / ${pair.thresholdUsed}`,
            })),
          );
      }),
    ),
  );

lab
  .command("experiments")
  .description("List complex_v1 experiment runs")
  .option("--json", "print JSON only")
  .action((options: JsonOption) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const items = await queries.experimentRuns();
        if (options.json) printJson(items);
        else
          printRows(
            items.map((run) => ({
              cache: `${run.cacheHits}/${run.cacheMisses}`,
              chains: run.summary?.multi_episode_storylines ?? "—",
              created: run.createdAt,
              duration: `${run.durationSeconds}s`,
              episodes: run.summary?.episodes ?? "—",
              id: run.id,
              name: run.name,
              note: run.snapshot?.note ?? "—",
              reward:
                typeof run.snapshot?.reward?.score === "number"
                  ? run.snapshot.reward.score
                  : "—",
              snapshot:
                run.snapshot === null
                  ? "legacy"
                  : run.snapshot.isBest
                    ? "best"
                    : "captured",
              storylines: run.summary?.storylines ?? "—",
            })),
          );
      }),
    ),
  );

lab
  .command("run")
  .description("Run a clustering experiment via the pipeline CLI")
  .requiredOption("--name <name>", "experiment name (report directory)")
  .option("--stub", "use deterministic stub models")
  .option("--limit <n>", "cluster at most n prepared entries")
  .option("--until <iso>", "cluster entries published up to this timestamp")
  .option("--no-cache", "bypass the adjudicator decision cache")
  .option("--prepare", "force the prepare phase before the experiment")
  .option("--clear-features", "reset features first (model/enrichment A/Bs)")
  .option(
    "--set <KEY=VALUE...>",
    "pipeline env override (repeatable)",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .action(
    (options: {
      cache: boolean;
      clearFeatures?: boolean;
      limit?: string;
      name: string;
      prepare?: boolean;
      set?: string[];
      stub?: boolean;
      until?: string;
    }) =>
      runAction(() =>
        withLab(async ({ capability, databaseUrl, queries }) => {
          if (!capability.experimentsEnabled) {
            process.stderr.write(
              `not_enabled: ${capability.experimentsReason ?? capability.reason ?? "experiments are not enabled"}\n`,
            );
            process.exitCode = 3;
            return;
          }
          const env: Record<string, string> = {};
          for (const pair of options.set ?? []) {
            const separator = pair.indexOf("=");
            if (separator < 1) {
              throw new Error(`--set expects KEY=VALUE, got "${pair}"`);
            }
            env[pair.slice(0, separator)] = pair.slice(separator + 1);
          }
          const harness = new ExperimentHarness({
            needsPrepare: () =>
              queries.corpusSummary().then((summary) => summary.needsPrepare),
            spawnStage: defaultSpawner(repositoryRoot, {
              DATABASE_URL: databaseUrl,
            }),
          });
          const finished = new Promise<{
            reportPath: string | null;
            runId: string | null;
            status: "failed" | "succeeded";
          }>((resolveDone) => {
            harness.onEvent((event) => {
              if (event.type === "log") process.stdout.write(`${event.line}\n`);
              if (event.type === "stage")
                process.stderr.write(
                  `stage ${event.stage.name}: ${event.stage.status}\n`,
                );
              if (event.type === "done") resolveDone(event);
            });
          });
          await harness.start({
            clearFeatures: options.clearFeatures,
            env,
            limit: options.limit === undefined ? null : Number(options.limit),
            name: options.name,
            noCache: options.cache === false,
            prepare: options.prepare,
            stub: options.stub,
            until: options.until ?? null,
          });
          const done = await finished;
          process.stdout.write(
            `${done.status}: run ${done.runId ?? "—"} · ${done.reportPath ?? "no report"}\n`,
          );
          if (done.status === "failed") process.exitCode = 1;
        }),
      ),
  );

await program.parseAsync(process.argv);
