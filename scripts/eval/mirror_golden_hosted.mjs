// Mirror the local golden_* tables → hosted Supabase (durable copy).
//
// Full-rewrite semantics per table: upsert every local row by id, then
// delete hosted rows that no longer exist locally. golden_news_entries is
// the append-only anchor (upsert only). bytea columns (centroids,
// embeddings) travel as \x hex strings. Run from repo root:
//   node scripts/eval/mirror_golden_hosted.mjs
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
    .map((line) => [line.slice(0, line.indexOf("=")).trim(),
                    line.slice(line.indexOf("=") + 1).trim()]),
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
const MIRRORS = [
  "golden_topic_categories",
  "golden_topic_themes",
  "golden_storylines",
  "golden_episodes",
  "golden_event_cards",
];

function wire(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = Buffer.isBuffer(value) ? `\\x${value.toString("hex")}` : value;
  }
  return out;
}

async function upsert(table, rows, conflict = "id") {
  for (let start = 0; start < rows.length; start += 500) {
    const batch = rows.slice(start, start + 500).map(wire);
    const response = await fetch(
      `${base}/rest/v1/${table}?on_conflict=${conflict}`,
      {
        method: "POST",
        headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(batch),
      },
    );
    if (!response.ok) {
      throw new Error(`${table} upsert failed ${response.status}: ${await response.text()}`);
    }
  }
}

async function deleteMissing(table, keepIds) {
  const hosted = await (await fetch(
    `${base}/rest/v1/${table}?select=id&limit=100000`, { headers })).json();
  const keep = new Set(keepIds.map(String));
  const dead = hosted.map((r) => r.id).filter((id) => !keep.has(String(id)));
  for (let start = 0; start < dead.length; start += 200) {
    const chunk = dead.slice(start, start + 200);
    const response = await fetch(
      `${base}/rest/v1/${table}?id=in.(${chunk.join(",")})`,
      { method: "DELETE", headers },
    );
    if (!response.ok) {
      throw new Error(`${table} delete failed: ${await response.text()}`);
    }
  }
  return dead.length;
}

const sql = postgres(LOCAL_DSN, { max: 1, prepare: false });

// mirrors last-write-wins; cards reference storylines only by uuid (no FK),
// so ordering is cosmetic
for (const table of MIRRORS) {
  const rows = await sql`select * from ${sql(table)}`;
  await upsert(table, rows);
  const removed = await deleteMissing(table, rows.map((r) => r.id));
  console.log(`${table}: ${rows.length} upserted, ${removed} removed`);
}

const anchor = await sql`
  select news_entry_id, content_hash_at_review, ordinal, batch_number,
         review_status, gold_episode_id, gold_episode_label,
         gold_storyline_id, gold_storyline_label, gold_theme_id,
         gold_theme_name, gold_category_id, is_syndicated, notes,
         proposed_at, reviewed_at, created_at, updated_at
  from public.golden_news_entries order by ordinal`;
await upsert("golden_news_entries", anchor, "news_entry_id");
console.log(`golden_news_entries: ${anchor.length} upserted`);
await sql.end();

const check = await fetch(
  `${base}/rest/v1/golden_storylines?select=id`,
  { method: "HEAD", headers: { ...headers, prefer: "count=exact" } });
console.log("hosted golden_storylines:", check.headers.get("content-range"));
