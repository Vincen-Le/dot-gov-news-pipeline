// Mirror the local simple_v1 experiment ledger → hosted Supabase.
//
// experiment_runs upsert by id; rank + cluster snapshots are replaced per
// run_id (hosted keeps a payload-immutability trigger on cluster snapshots,
// so replace = delete + insert, mirroring local re-captures). Run from repo
// root after each slice:  node scripts/eval/mirror_experiments_hosted.mjs
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
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => [
      line.slice(0, line.indexOf("=")).trim(),
      line.slice(line.indexOf("=") + 1).trim(),
    ]),
);
const base = env.SUPABASE_URL.replace(/\/$/, "");
const headers = {
  apikey: env.SUPABASE_SECRET_KEY,
  authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
  "content-type": "application/json",
};

const LOCAL_DSN =
  process.env.GOLDEN_SOURCE_DSN ??
  "postgresql://postgres:postgres@127.0.0.1:57422/simple_v1_db";
const sql = postgres(LOCAL_DSN, { max: 1, prepare: false });

async function send(path, options) {
  const response = await fetch(`${base}/rest/v1/${path}`, options);
  if (!response.ok) {
    throw new Error(
      `${path} failed ${response.status}: ${await response.text()}`,
    );
  }
}

const runs = await sql`select * from public.simple_v1_experiment_runs`;
await send("simple_v1_experiment_runs?on_conflict=id", {
  method: "POST",
  headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify(runs),
});
console.log(`simple_v1_experiment_runs: ${runs.length} upserted`);

const runIds = runs.map((r) => r.id);
for (const table of [
  "simple_v1_rank_snapshots",
  "simple_v1_experiment_cluster_snapshots",
]) {
  const rows = await sql`select * from ${sql(table)}`;
  if (runIds.length > 0) {
    await send(`${table}?run_id=in.(${runIds.join(",")})`, {
      method: "DELETE",
      headers,
    });
  }
  for (let start = 0; start < rows.length; start += 200) {
    await send(table, {
      method: "POST",
      headers: { ...headers, prefer: "return=minimal" },
      body: JSON.stringify(rows.slice(start, start + 200)),
    });
  }
  console.log(`${table}: ${rows.length} replaced`);
}
await sql.end();
