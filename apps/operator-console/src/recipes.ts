export interface OperatorRecipe {
  cli: string;
  description: string;
  id: string;
  title: string;
  view: string;
}

export const operatorRecipes: OperatorRecipe[] = [
  {
    cli: "pnpm ops remote health --deep",
    description: "Verify Worker, Supabase, R2, and Queue dependencies.",
    id: "deep-health",
    title: "Run deep health check",
    view: "/system?depth=deep",
  },
  {
    cli: "pnpm ops remote queues",
    description: "Read current main Queue and DLQ pressure.",
    id: "queue-pressure",
    title: "Inspect queue pressure",
    view: "/system#queues",
  },
  {
    cli: "pnpm ops remote inventory summary",
    description: "Verify the latest GSA reconciliation receipt.",
    id: "inventory-summary",
    title: "Verify inventory sync",
    view: "/inventory",
  },
  {
    cli: "pnpm ops remote inventory runs --limit 10",
    description: "List recent inventory attempts and outcomes.",
    id: "inventory-runs",
    title: "List inventory runs",
    view: "/inventory#runs",
  },
  {
    cli: "pnpm ops remote site inspect nasa.gov",
    description: "Find the durable inventory record for a hostname.",
    id: "site-lookup",
    title: "Look up a site",
    view: "/inventory?hostname=nasa.gov",
  },
  {
    cli: "pnpm ops remote events list --since 30m",
    description: "Read recent durable pipeline events.",
    id: "recent-events",
    title: "Read recent events",
    view: "/events?since=30m",
  },
  {
    cli: "pnpm ops remote worker tail --search worker_lifecycle",
    description: "Follow sampled structured Worker activity.",
    id: "worker-tail",
    title: "Follow Worker activity",
    view: "/events?live=true",
  },
  {
    cli: "pnpm ops dashboard",
    description: "Start the private dashboard on loopback.",
    id: "dashboard",
    title: "Open local dashboard",
    view: "/",
  },
  {
    cli: "pnpm ops lab corpus",
    description: "Inspect the synced news-entries corpus and feature coverage.",
    id: "lab-corpus",
    title: "Inspect the corpus",
    view: "/lab",
  },
  {
    cli: "pnpm ops lab storylines --min-episodes 2",
    description: "List multi-episode storyline chains for QA.",
    id: "lab-chains",
    title: "Browse storyline chains",
    view: "/storylines?minEpisodes=2",
  },
  {
    cli: "pnpm ops lab storyline <id>",
    description: "Walk one chain: episodes, attach evidence, event cards.",
    id: "lab-storyline-qa",
    title: "QA a storyline chain",
    view: "/storylines",
  },
  {
    cli: "pnpm ops lab run --name baseline --stub",
    description: "Run a clustering experiment via the pipeline CLI.",
    id: "lab-run-stub",
    title: "Run a stub experiment",
    view: "/lab#run",
  },
  {
    cli: "pnpm ops lab experiments",
    description: "List experiment runs and compare their summaries.",
    id: "lab-experiments",
    title: "List experiment runs",
    view: "/lab#experiments",
  },
  {
    cli: "pnpm ops lab borderline --limit 50",
    description:
      "List borderline attach decisions awaiting labels; label them in the dashboard.",
    id: "lab-label-queue",
    title: "Open the label queue",
    view: "/lab#labels",
  },
];

export function renderCheatsheet(): string {
  const sections = operatorRecipes
    .map(
      (recipe) =>
        `### ${recipe.title}\n\n${recipe.description}\n\n\`\`\`bash\n${recipe.cli}\n\`\`\``,
    )
    .join("\n\n");

  return `# Operator CLI Cheatsheet\n\nGenerated from \`apps/operator-console/src/recipes.ts\`. Do not edit by hand. All query commands are read-only.\n\n## One-time setup\n\nRun \`pnpm ops setup\` to prepare local databases for every pipeline (stack, migrations, corpus, registry). To enable remote observability, add \`SUPABASE_SECRET_KEY\` to the ignored root \`.env\`, then run \`pnpm ops deploy\`. The deploy command deploys the read-only Operator API, generates its token, and atomically writes its URL and token back to a mode-\`0600\` \`.env\` before enabling reads. Use \`pnpm ops deploy --dry-run\` to validate without changing Cloudflare or local configuration. Browser code never receives these values.\n\n## Everyday startup\n\nRun \`pnpm ops:start\` to open the one-time authenticated local dashboard URL. Cloudflare continues processing when the dashboard is closed.\n\n## Output conventions\n\nAdd \`--json\` to read commands for machine-readable output. Warnings go to stderr. Health checks return a nonzero exit code when requested checks fail.\n\n${sections}\n`;
}
