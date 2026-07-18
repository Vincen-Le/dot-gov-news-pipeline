#!/usr/bin/env node
import { Command } from "commander";

import { OperatorApiClient, OperatorApiError } from "./api-client";
import { loadOperatorConfig, requireOperatorConfig } from "./config";
import { generateCheatsheet } from "./generate-cheatsheet";
import { formatAge, printJson, printRows, sinceTimestamp } from "./output";
import { operatorRecipes } from "./recipes";
import { startDashboard } from "./server";
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
      const dashboard = await startDashboard(requireOperatorConfig(), {
        noOpen: !options.open,
        port: Number(options.port),
      });
      process.stdout.write(`Operator dashboard: ${dashboard.url}\n`);
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

await program.parseAsync(process.argv);
