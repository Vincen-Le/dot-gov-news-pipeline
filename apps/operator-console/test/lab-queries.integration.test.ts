/** DB-backed LabQueries tests.
 *
 * Gated: needs a running local Supabase with all migrations applied
 * (including 20260718100200_create_experiment_runs) and an otherwise EMPTY
 * database — corpus-level assertions count whole tables. When the bench db
 * holds live data, point DATABASE_URL at a dedicated empty database on the
 * same instance (create it once, apply supabase/migrations in order):
 *   LAB_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57422/lab_test \
 *     pnpm --filter @dot-gov-news/operator-console test -- lab-queries
 * The fixture is applied inside a transaction and rolled back after each test.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { LabQueries } from "../src/lab/queries";

const enabled = process.env.LAB_DB_TESTS === "1";
const dsn =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const fixture = readFileSync(
  resolve(import.meta.dirname, "fixtures/lab-fixture.sql"),
  "utf8",
);

const sql = enabled ? postgres(dsn, { max: 1, prepare: false }) : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function withFixture<T>(
  run: (queries: LabQueries) => Promise<T>,
): Promise<T> {
  if (sql === null) throw new Error("gated");
  return sql.begin(async (tx) => {
    await tx.unsafe(fixture);
    const result = await run(new LabQueries(tx as unknown as postgres.Sql));
    throw Object.assign(new Error("rollback"), { result });
  }).catch((error: Error & { result?: T }) => {
    if (error.message === "rollback" && "result" in error)
      return error.result as T;
    throw error;
  });
}

describe.skipIf(!enabled)("LabQueries against local Supabase", () => {
  it("summarizes the corpus with feature and prepare coverage", async () => {
    const summary = await withFixture((queries) => queries.corpusSummary());
    expect(summary.entries).toBe(4);
    expect(summary.embedded).toBe(3);
    expect(summary.needsPrepare).toBe(1);
    expect(summary.clustered).toBe(4);
    expect(summary.agencies[0]!.agency).toBe("fda");
  });

  it("lists storylines newest-first with headline and filters", async () => {
    const all = await withFixture((queries) => queries.storylines({}));
    expect(all).toHaveLength(2);
    // newest_entry_at desc: the Tulsa storyline (2026-05-18, no card) sorts first
    expect(all.map((item) => item.headline)).toEqual([
      null,
      "Valsatrex recall chain",
    ]);
    const chains = await withFixture((queries) =>
      queries.storylines({ minEpisodes: 2 }),
    );
    expect(chains).toHaveLength(1);
    const byEntity = await withFixture((queries) =>
      queries.storylines({ entity: "tulsa" }),
    );
    expect(byEntity).toHaveLength(1);
    // sort=episodes: the two-episode Valsatrex chain outranks the newer Tulsa one
    const byEpisodes = await withFixture((queries) =>
      queries.storylines({ sort: "episodes" }),
    );
    expect(byEpisodes.map((item) => item.headline)).toEqual([
      "Valsatrex recall chain",
      null,
    ]);
    // the quick-filter dropdown lists exactly the filterable agency ids
    const agencies = await withFixture((queries) =>
      queries.storylineAgencies(),
    );
    expect(agencies).toEqual(["fda", "hhs"]);
    // offset pages past the newest chain to the older Valsatrex one
    const paged = await withFixture((queries) =>
      queries.storylines({ limit: 1, offset: 1 }),
    );
    expect(paged.map((item) => item.headline)).toEqual([
      "Valsatrex recall chain",
    ]);
  });

  it("returns the full chain with attach evidence and citation flags", async () => {
    const detail = await withFixture((queries) =>
      queries.storylineDetail("00000000-0000-4000-8000-000000000021"),
    );
    expect(detail).not.toBeNull();
    expect(detail?.episodes).toHaveLength(2);
    expect(detail?.episodes[0]!.entries).toHaveLength(2);
    expect(detail?.episodes[0]!.card?.headline).toBe("FDA recalls Valsatrex");
    expect(detail?.episodes[1]!.attachMethod).toBe("event_key");
    const latest = detail?.overviewCards[0];
    expect(latest?.version).toBe(2);
    expect(latest?.timeline?.map((item) => item.cited)).toEqual([
      true,
      true,
      false,
    ]);
    expect(
      await withFixture((queries) =>
        queries.storylineDetail("00000000-0000-4000-8000-00000000dead"),
      ),
    ).toBeNull();
  });

  it("computes attach mix, shapes, syndication, and calibration inputs", async () => {
    const mix = await withFixture((queries) => queries.attachMix());
    expect(mix.find((row) => row.method === "content_hash")?.count).toBe(1);
    const singleton = await withFixture((queries) =>
      queries.entriesPerEpisode(),
    );
    expect(singleton.sort()).toEqual([1, 1, 2]);
    const syndication = await withFixture((queries) =>
      queries.syndicationRate(),
    );
    expect(syndication).toBeCloseTo(0.25, 5);
    const cosines = await withFixture((queries) =>
      queries.contentHashPairCosines(),
    );
    expect(cosines).toHaveLength(1);
    expect(cosines[0]).toBeCloseTo(1, 5);
    const borderline = await withFixture((queries) =>
      queries.borderlinePairs(0.03, 10),
    );
    expect(borderline.map((pair) => pair.attachMethod).sort()).toEqual([
      "content_hash",
      "near_dup",
    ]);
  });

  it("reads experiment runs newest-first with parsed payloads", async () => {
    // The shared bench db legitimately accumulates real runs; assert on the
    // fixture's rows (still newest-first relative to each other).
    const runs = (
      await withFixture((queries) => queries.experimentRuns())
    ).filter((run) => ["baseline", "near-dup-0.87"].includes(run.name));
    expect(runs.map((run) => run.name)).toEqual(["near-dup-0.87", "baseline"]);
    expect(runs[0]!.durationSeconds).toBeCloseTo(21, 1);
    expect(runs[0]!.cacheHits).toBe(2);
    expect(runs[0]!.config?.near_dup_threshold).toBe(0.87);
    expect(runs[1]!.summary?.multi_episode_storylines).toBe(1);
    const single = await withFixture((queries) =>
      queries.experimentRun("00000000-0000-4000-8000-0000000000a1"),
    );
    expect(single?.name).toBe("baseline");
    expect(
      await withFixture((queries) =>
        queries.experimentRun("00000000-0000-4000-8000-00000000dead"),
      ),
    ).toBeNull();
  });

  it("filters storylines by theme and category and shapes theme fields", async () => {
    const byTheme = await withFixture((queries) =>
      queries.storylines({ theme: "00000000-0000-4000-8000-0000000000d1" }),
    );
    expect(byTheme).toHaveLength(1);
    expect(byTheme[0]!.themeName).toBe("Valsatrex recall fallout");
    expect(byTheme[0]!.categoryName).toBe("Food & Drug Safety");

    const foodAndDrug = await withFixture(async (queries) => {
      const categories = await queries.topicCategories();
      const target = categories.find(
        (category) => category.displayName === "Food & Drug Safety",
      );
      return queries.storylines({ category: target!.id });
    });
    expect(foodAndDrug).toHaveLength(1);

    const unthemed = await withFixture((queries) =>
      queries.storylines({ theme: "00000000-0000-4000-8000-0000000000d2" }),
    );
    expect(unthemed).toHaveLength(0);
  });

  it("lists themes with category origin and narrows by category", async () => {
    const themes = await withFixture((queries) => queries.topicThemes({}));
    expect(themes.map((theme) => theme.displayName)).toContain(
      "Valsatrex recall fallout",
    );
    const llmOnly = await withFixture((queries) =>
      queries.topicThemes({ category: "00000000-0000-4000-8000-0000000000c9" }),
    );
    expect(llmOnly.map((theme) => theme.displayName)).toEqual([
      "Field office access",
    ]);
  });

  it("lists categories with origin badges", async () => {
    const categories = await withFixture((queries) => queries.topicCategories());
    const llm = categories.find(
      (category) => category.displayName === "Test LLM Category",
    );
    expect(llm?.origin).toBe("llm");
    expect(
      categories.some((category) => category.origin === "seed"),
    ).toBe(true);
  });

  it("exposes the theme attach audit on storyline detail", async () => {
    const all = await withFixture((queries) => queries.storylines({}));
    const valsatrex = all.find((item) => item.headline !== null);
    const detail = await withFixture((queries) =>
      queries.storylineDetail(valsatrex!.id),
    );
    expect(detail?.themeName).toBe("Valsatrex recall fallout");
    expect(detail?.themeAttachMethod).toBe("adjudicated_join");
    expect(detail?.themeSimilarity).toBeCloseTo(0.81, 2);
  });
});
