// Mirror locally computed news_entries features → hosted Supabase.
//
// prepare/reextract write embeddings, enriched_text, and v4 extraction only
// to the local pipeline database; the 2026-07-20 local wipe lost all of them
// because hosted held only the raw corpus. Run this after any prepare or
// reextract milestone so hosted stays a complete restore source:
//   node scripts/eval/mirror_corpus_features_hosted.mjs
//
// Patch-only semantics: updates feature columns on hosted rows by id, never
// inserts or deletes corpus rows (ingest owns those).
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
const FEATURES = ["embedding", "embedding_model", "enriched_text",
                  "enricher_version", "entity_set", "event_keys",
                  "extractor_version"];

const sql = postgres(LOCAL_DSN, { max: 1, prepare: false });
const rows = await sql`
  select id, ${sql(FEATURES)} from public.news_entries
  where embedding is not null or enriched_text is not null
     or extractor_version is not null
`;

let patched = 0;
for (const row of rows) {
  const body = {};
  for (const key of FEATURES) {
    const value = row[key];
    body[key] = Buffer.isBuffer(value) ? `\\x${value.toString("hex")}` : value;
  }
  const response = await fetch(
    `${base}/rest/v1/news_entries?id=eq.${row.id}`,
    { method: "PATCH", headers: { ...headers, prefer: "return=minimal" },
      body: JSON.stringify(body) },
  );
  if (!response.ok) {
    throw new Error(`patch ${row.id}: ${response.status} ${await response.text()}`);
  }
  patched += 1;
  if (patched % 500 === 0) console.log(`patched ${patched}/${rows.length}`);
}
console.log(`news_entries features mirrored: ${patched}/${rows.length}`);
await sql.end({ timeout: 5 });
