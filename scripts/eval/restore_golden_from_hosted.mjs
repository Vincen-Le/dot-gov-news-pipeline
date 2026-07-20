// Restore golden_* + simple_v1 ledger from hosted Supabase → local
// simple_v1_db (recovery after a local wipe; see golden-slice-loop skill).
// Insert order respects FKs. Run after scripts/create-pipeline-db.sh:
//   node scripts/eval/restore_golden_from_hosted.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const repo = new URL("../..", import.meta.url).pathname;
const req = createRequire(
  `${repo}node_modules/.pnpm/postgres@3.4.7/node_modules/postgres/`,
);
const postgres = req("postgres");

const env = Object.fromEntries(
  readFileSync(`${repo}.env`, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const base = env.SUPABASE_URL.replace(/\/$/, "");
const headers = {
  apikey: env.SUPABASE_SECRET_KEY,
  authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
};

const sql = postgres("postgresql://postgres:postgres@127.0.0.1:57422/simple_v1_db", {
  max: 1,
  prepare: false,
});

async function fetchAll(table) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${base}/rest/v1/${table}?select=*&limit=1000&offset=${offset}`, { headers });
    if (!r.ok) throw new Error(`${table}: ${r.status} ${await r.text()}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

// bytea columns arrive as "\\x<hex>" strings — postgres.js sends them as
// text and postgres casts to bytea on insert, so no conversion needed.
const TABLES = [
  "golden_topic_categories",
  "golden_topic_themes",
  "golden_storylines",
  "golden_episodes",
  "golden_event_cards",
  "golden_news_entries",
  "simple_v1_experiment_runs",
  "simple_v1_experiment_cluster_snapshots",
  "simple_v1_rank_snapshots",
];

for (const table of TABLES) {
  const rows = await fetchAll(table);
  if (rows.length === 0) {
    console.log(`${table}: 0 rows (skip)`);
    continue;
  }
  const columns = Object.keys(rows[0]);
  for (let start = 0; start < rows.length; start += 500) {
    const batch = rows.slice(start, start + 500);
    await sql`insert into ${sql(table)} ${sql(batch, columns)} on conflict do nothing`;
  }
  const [{ count }] = await sql`select count(*)::int as count from ${sql(table)}`;
  console.log(`${table}: inserted ${rows.length}, local now ${count}`);
}

await sql.end({ timeout: 5 });
