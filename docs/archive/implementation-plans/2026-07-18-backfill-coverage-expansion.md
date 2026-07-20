# Backfill Scraping-Strategy Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two structured scraping strategies (Drupal JSON:API, Google News sitemaps) to the backfill collector and freeze a probe-evidenced `top-20-diversity-v3` manifest, so the `news_entries` corpus for clustering/ranking evaluation is built from the most reliable per-site source available.

**Architecture:** The collector (`apps/news-backfill`) already dispatches syndication, WordPress, publisher-API, sitemap, and HTML-archive adapters (plus Wayback CDX variants) from `enumerateBatches` in `apps/news-backfill/src/adapters.ts`, driven by a versioned manifest. This plan (1) probes each cohort publisher's own site for structured sources it isn't using yet, (2) reads Google News metadata inside the existing sitemap adapter, (3) adds a `drupal_jsonapi` publisher-API variant, and (4) encodes the winners in a frozen v3 manifest with staged, idempotency-proven reruns. Discovery-worker integration is explicitly deferred — but probe classifications reuse the `news_sources` schema vocabulary (`source_type`, `adapter_config`, `backfill_supported` from migration `20260718000300`) so lifting these methods into the live infrastructure later is mechanical, not a redesign.

**Tech Stack:** TypeScript (Node 24, ESM), vitest, tsx, existing `markup.ts` regex helpers (no new dependencies), Supabase PostgREST + existing security-definer RPCs.

## Context: what already exists (do not rebuild)

- Wayback CDX enumeration: `waybackBatches`, `waybackFeedBatches`, `waybackListingBatches` in `apps/news-backfill/src/adapters.ts` already query `web.archive.org/cdx/search/cdx`.
- Article hydration with JSON-LD → OpenGraph → meta-tag → `<time>` fallback: `apps/news-backfill/src/extract.ts`.
- Hidden internal JSON endpoints as a source class: the `cdc`/`cdc_solr` publisher-API variants; the Drupal variant in Task 3 generalizes the same idea to a standard endpoint shape.
- Idempotent ingest via `ingest_news_entries` RPC with lease/checkpoint lifecycle: `apps/news-backfill/src/repository.ts`, migrations `20260718000900`–`20260718001400`.
- Manifest v2: `config/news-backfill/top-20-diversity-v2.json` (frozen; 20 publishers).

## Global Constraints

- **On-site only.** Every strategy runs against the cohort publishers' own sites (or their robots.txt/sitemaps). External aggregators are out of scope — see Non-Goals.
- Manifest v2 is frozen. Source changes land only in `config/news-backfill/top-20-diversity-v3.json` (`"cohortId": "top-20-diversity-v3"`, `"version": 3`); never edit v2 after data is loaded.
- `loadManifest` (`apps/news-backfill/src/config.ts`) requires exactly 20 publishers, `maxPages` 1–10000, `pageSize` 1–100, `sourceUrl` starting `https://`.
- Politeness ceilings hold: one request per host at a time, `minimumHostIntervalMs: 750` (`apps/news-backfill/src/index.ts`), honor `Retry-After`, bounded response sizes via `createFetcher`. The probe script matches this pacing.
- No direct table writes; all ingestion goes through `ingest_news_entries`. Probe is metadata-only — it never writes to `news_entries`.
- **Infra parity:** probe classifications use only values valid in the `news_sources` schema — `source_type` ∈ `rss | atom | json_feed | publisher_api | html_archive | sitemap`, `adapter_config` shaped like the collector's manifest source fields — so the same classifiers can later move into the discovery worker unchanged.
- No new runtime dependencies. Parse XML/JSON with `markup.ts` helpers and `JSON.parse` like the existing adapters.
- All checks pass: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.

---

### Task 1: Structured-source probe script

Probes every cohort publisher for four cheap structured signals — WordPress REST, Drupal JSON:API, Google News sitemaps, robots.txt sitemap declarations — and writes a markdown evidence report. The report decides which publishers move to the new adapters in Task 4. Several v2 sources are brittle HTML archives or hydrate-everything sitemaps (NWS, DOJ, Treasury, FDA, USDA, State); any hit here upgrades corpus reliability directly.

**Files:**
- Create: `apps/news-backfill/src/probe.ts`
- Test: `apps/news-backfill/src/probe.test.ts`
- Create (output, committed as evidence): `docs/operations/alternate-source-probe-2026-07.md`

**Interfaces:**
- Consumes: nothing from other tasks. Uses global `fetch` directly (probe hits ~100 URLs once; the runner's lease machinery is unnecessary).
- Produces: `probePlan(origin: string): ProbeCheck[]` and `classifyProbe(check: ProbeCheck, status: number, contentType: string, body: string): ProbeResult` (exported for tests), plus the committed report consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/news-backfill/src/probe.test.ts
import { describe, expect, it } from "vitest";

import { classifyProbe, probePlan } from "./probe";

describe("probePlan", () => {
  it("derives one URL per structured-source check", () => {
    const plan = probePlan("https://www.noaa.gov");
    expect(plan).toEqual([
      { kind: "wordpress", url: "https://www.noaa.gov/wp-json/wp/v2/posts?per_page=1" },
      { kind: "drupal", url: "https://www.noaa.gov/jsonapi" },
      { kind: "news_sitemap", url: "https://www.noaa.gov/sitemap-news.xml" },
      { kind: "news_sitemap", url: "https://www.noaa.gov/news-sitemap.xml" },
      { kind: "robots", url: "https://www.noaa.gov/robots.txt" },
    ]);
  });
});

describe("classifyProbe", () => {
  it("confirms WordPress only for a JSON array of post-shaped items", () => {
    const check = { kind: "wordpress" as const, url: "https://a.gov/wp-json/wp/v2/posts?per_page=1" };
    const post = '[{"id":1,"link":"https://a.gov/news/a","date_gmt":"2026-06-01T00:00:00"}]';
    expect(classifyProbe(check, 200, "application/json", post).verdict).toBe("available");
    expect(classifyProbe(check, 200, "application/json", "[]").verdict).toBe("unavailable");
    expect(classifyProbe(check, 200, "text/html", "<html></html>").verdict).toBe("unavailable");
    expect(classifyProbe(check, 404, "application/json", "{}").verdict).toBe("unavailable");
  });

  it("confirms Drupal JSON:API from the version envelope and lists node collections", () => {
    const check = { kind: "drupal" as const, url: "https://a.gov/jsonapi" };
    const body = '{"jsonapi":{"version":"1.0"},"links":{"node--news":{"href":"https://a.gov/jsonapi/node/news"},"self":{"href":"https://a.gov/jsonapi"}}}';
    const result = classifyProbe(check, 200, "application/vnd.api+json", body);
    expect(result.verdict).toBe("available");
    expect(result.detail).toBe("node--news");
  });

  it("confirms a news sitemap from the news namespace", () => {
    const check = { kind: "news_sitemap" as const, url: "https://a.gov/sitemap-news.xml" };
    const body = '<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url/></urlset>';
    expect(classifyProbe(check, 200, "application/xml", body).verdict).toBe("available");
    expect(classifyProbe(check, 200, "application/xml", "<urlset/>").verdict).toBe("unavailable");
  });

  it("extracts sitemap declarations from robots.txt", () => {
    const check = { kind: "robots" as const, url: "https://a.gov/robots.txt" };
    const body = "User-agent: *\nSitemap: https://a.gov/sitemap.xml\nSitemap: https://a.gov/sitemap-news.xml\n";
    const result = classifyProbe(check, 200, "text/plain", body);
    expect(result.verdict).toBe("available");
    expect(result.detail).toBe("https://a.gov/sitemap.xml, https://a.gov/sitemap-news.xml");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dot-gov-news/news-backfill test -- run src/probe.test.ts`
Expected: FAIL — `Cannot find module './probe'`.

- [ ] **Step 3: Implement probe.ts**

```ts
// apps/news-backfill/src/probe.ts
export type ProbeKind = "wordpress" | "drupal" | "news_sitemap" | "robots";

export interface ProbeCheck {
  kind: ProbeKind;
  url: string;
}

export interface ProbeResult {
  detail: string;
  verdict: "available" | "unavailable" | "error";
}

// One probe origin set per cohort publisher (matches top-20-diversity-v2 hosts).
const PUBLISHER_ORIGINS: Record<string, string[]> = {
  bls: ["https://www.bls.gov"],
  cdc: ["https://www.cdc.gov"],
  doj: ["https://www.justice.gov"],
  fda: ["https://www.fda.gov"],
  fsa: ["https://fsapartners.ed.gov"],
  irs: ["https://www.irs.gov"],
  nasa: ["https://www.nasa.gov"],
  ncbi: ["https://ncbiinsights.ncbi.nlm.nih.gov"],
  noaa: ["https://www.noaa.gov"],
  nps: ["https://www.nps.gov"],
  nws: ["https://www.weather.gov"],
  sec: ["https://www.sec.gov"],
  ssa: ["https://www.ssa.gov", "https://blog.ssa.gov"],
  state: ["https://www.state.gov"],
  treasury: ["https://home.treasury.gov"],
  uscis: ["https://www.uscis.gov"],
  usda: ["https://www.usda.gov"],
  usgs: ["https://www.usgs.gov"],
  usps: ["https://about.usps.com"],
  va: ["https://news.va.gov", "https://www.va.gov"],
};

export function probePlan(origin: string): ProbeCheck[] {
  return [
    { kind: "wordpress", url: `${origin}/wp-json/wp/v2/posts?per_page=1` },
    { kind: "drupal", url: `${origin}/jsonapi` },
    { kind: "news_sitemap", url: `${origin}/sitemap-news.xml` },
    { kind: "news_sitemap", url: `${origin}/news-sitemap.xml` },
    { kind: "robots", url: `${origin}/robots.txt` },
  ];
}

export function classifyProbe(
  check: ProbeCheck,
  status: number,
  contentType: string,
  body: string,
): ProbeResult {
  if (status !== 200) return { detail: `status ${status}`, verdict: "unavailable" };
  if (check.kind === "wordpress") {
    if (!contentType.includes("json")) return { detail: contentType, verdict: "unavailable" };
    try {
      const parsed: unknown = JSON.parse(body);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return { detail: "no posts returned", verdict: "unavailable" };
      }
      const first = parsed[0] as Record<string, unknown> | null;
      const looksLikePost =
        typeof first === "object" &&
        first !== null &&
        typeof first.id === "number" &&
        typeof first.link === "string";
      return looksLikePost
        ? { detail: `${parsed.length} post(s) returned`, verdict: "available" }
        : { detail: "items are not posts", verdict: "unavailable" };
    } catch {
      return { detail: "invalid JSON", verdict: "unavailable" };
    }
  }
  if (check.kind === "drupal") {
    try {
      const parsed = JSON.parse(body) as {
        jsonapi?: { version?: unknown };
        links?: Record<string, unknown>;
      };
      if (typeof parsed.jsonapi?.version !== "string") {
        return { detail: "no jsonapi envelope", verdict: "unavailable" };
      }
      const nodeTypes = Object.keys(parsed.links ?? {})
        .filter((key) => key.startsWith("node--"))
        .sort();
      return { detail: nodeTypes.join(", ") || "no node links", verdict: "available" };
    } catch {
      return { detail: "invalid JSON", verdict: "unavailable" };
    }
  }
  if (check.kind === "news_sitemap") {
    return body.includes("schemas/sitemap-news")
      ? { detail: "google news namespace present", verdict: "available" }
      : { detail: "no news namespace", verdict: "unavailable" };
  }
  const sitemaps = [...body.matchAll(/^sitemap:\s*(\S+)/gim)].map(
    (match) => match[1] ?? "",
  );
  return sitemaps.length > 0
    ? { detail: sitemaps.join(", "), verdict: "available" }
    : { detail: "no sitemap declarations", verdict: "unavailable" };
}

async function probeOne(check: ProbeCheck): Promise<ProbeResult> {
  try {
    const response = await fetch(check.url, {
      headers: {
        "user-agent":
          process.env.NEWS_BACKFILL_USER_AGENT ?? "DotGovNewsBackfill/1.0 probe",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.text()).slice(0, 262_144);
    return classifyProbe(
      check,
      response.status,
      response.headers.get("content-type") ?? "",
      body,
    );
  } catch (error) {
    return { detail: String(error).slice(0, 200), verdict: "error" };
  }
}

async function main(): Promise<void> {
  const filter = process.argv.includes("--publisher")
    ? process.argv[process.argv.indexOf("--publisher") + 1]
    : undefined;
  const lines: string[] = [
    "# Alternate structured-source probe",
    "",
    `Probed: ${new Date().toISOString()}`,
    "",
    "| Publisher | Check | URL | Verdict | Detail |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const [publisher, origins] of Object.entries(PUBLISHER_ORIGINS)) {
    if (filter !== undefined && filter !== publisher) continue;
    for (const origin of origins) {
      for (const check of probePlan(origin)) {
        const result = await probeOne(check);
        lines.push(
          `| ${publisher} | ${check.kind} | ${check.url} | ${result.verdict} | ${result.detail.replaceAll("|", "\\|")} |`,
        );
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (process.argv[1]?.endsWith("probe.ts") === true) await main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/news-backfill test -- run src/probe.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Smoke-run against one publisher, then all 20**

Run: `pnpm --filter @dot-gov-news/news-backfill exec tsx src/probe.ts --publisher noaa`
Expected: markdown table on stdout with five rows for noaa, no exceptions.

Run: `pnpm --filter @dot-gov-news/news-backfill exec tsx src/probe.ts > docs/operations/alternate-source-probe-2026-07.md`
Expected: ~110 rows (5 checks × 22 origins), exit 0. All-error rows mean a network problem — rerun those publishers with `--publisher`.

- [ ] **Step 6: Annotate the report**

Append a `## Findings` section to `docs/operations/alternate-source-probe-2026-07.md` by hand: for each publisher whose current v2 source is `html_archive` or a hydrate-everything `sitemap`, note whether a `drupal` or `news_sitemap` verdict of `available` offers an upgrade, and name the Drupal node collection to use (from the `detail` column, e.g. `node--news`). Verify the chosen collection actually contains news (one manual `curl` per candidate, pasted into the doc). Rank upgrades by expected corpus impact: publishers with missing dates/summaries in the v2 run first.

- [ ] **Step 7: Verify workspace checks and commit**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: PASS.

```bash
git add apps/news-backfill/src/probe.ts apps/news-backfill/src/probe.test.ts docs/operations/alternate-source-probe-2026-07.md
git commit -m "feat: probe cohort publishers for structured news sources"
```

---

### Task 2: Google News sitemap metadata in the sitemap adapter

The sitemap adapter (`sitemapBatches` in `apps/news-backfill/src/adapters.ts`) reads only `<loc>`/`<lastmod>`, so every candidate needs article hydration for a publication date and out-of-window URLs are fetched before they can be rejected. Google News sitemaps carry `<news:publication_date>` and `<news:title>` inline — trustworthy event-time for clustering, and window filtering before any article fetch.

**Files:**
- Modify: `apps/news-backfill/src/adapters.ts` (the `SitemapRow` interface at ~line 353, `sitemapRows` at ~line 359, candidate mapping in `sitemapBatches` at ~line 436)
- Test: `apps/news-backfill/src/adapters.test.ts`

**Interfaces:**
- Consumes: `tagText(input, names)` from `./markup` — already matches namespace-prefixed tags (`<news:publication_date>` matches name `publication_date`); `blocks`, `isoDate`, `includeUrl` already local to `adapters.ts`.
- Produces: unchanged `CandidateBatch` shape; candidates from news sitemaps populate `publishedAt` and `title` instead of `null`.

- [ ] **Step 1: Write the failing test**

Add to `describe("source adapters", ...)` in `apps/news-backfill/src/adapters.test.ts` (match the `enumerateBatches` call shape of the neighboring sitemap tests):

```ts
it("uses Google News sitemap metadata for dates, titles, and window filtering", async () => {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url>
    <loc>https://agency.gov/news/in-window</loc>
    <news:news>
      <news:publication_date>2026-06-01T12:00:00Z</news:publication_date>
      <news:title>In Window Story</news:title>
    </news:news>
  </url>
  <url>
    <loc>https://agency.gov/news/too-old</loc>
    <news:news>
      <news:publication_date>2024-01-01T00:00:00Z</news:publication_date>
      <news:title>Too Old Story</news:title>
    </news:news>
  </url>
  <url>
    <loc>https://agency.gov/news/plain-row</loc>
    <lastmod>2026-05-01</lastmod>
  </url>
</urlset>`;
  const batches = await collect(
    enumerateBatches({
      cursor: {},
      fetchDocument: async (url) => ({
        body,
        contentType: "application/xml",
        finalUrl: url,
        status: 200,
      }),
      profile: profile({ sourceUrl: "https://agency.gov/sitemap-news.xml" }),
      windowEnd: "2026-07-18T00:00:00.000Z",
      windowStart: "2025-07-18T00:00:00.000Z",
    }),
  );
  const candidates = batches.flatMap((batch) => batch.candidates);
  expect(candidates.map((candidate) => candidate.url)).toEqual([
    "https://agency.gov/news/in-window",
    "https://agency.gov/news/plain-row",
  ]);
  expect(candidates[0]?.title).toBe("In Window Story");
  expect(candidates[0]?.publishedAt).toBe("2026-06-01T12:00:00.000Z");
  expect(candidates[1]?.publishedAt).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dot-gov-news/news-backfill test -- run src/adapters.test.ts -t "Google News sitemap"`
Expected: FAIL — `too-old` included, `title`/`publishedAt` are `null`.

- [ ] **Step 3: Implement**

Extend the row type and parser in `apps/news-backfill/src/adapters.ts`:

```ts
interface SitemapRow {
  lastmod?: string;
  loc: string;
  newsPublishedAt?: string;
  newsTitle?: string;
}
```

```ts
const convert = (rows: string[]): SitemapRow[] =>
  rows.flatMap((row) => {
    const loc = tagText(row, ["loc"]);
    if (loc === null) return [];
    const entry: SitemapRow = { loc };
    const lastmod = tagText(row, ["lastmod"]);
    if (lastmod !== null) entry.lastmod = lastmod;
    const newsBlock = blocks(row, "news:news")[0];
    if (newsBlock !== undefined) {
      const publishedAt = tagText(newsBlock, ["publication_date"]);
      if (publishedAt !== null) entry.newsPublishedAt = publishedAt;
      const title = tagText(newsBlock, ["title"]);
      if (title !== null) entry.newsTitle = title;
    }
    return [entry];
  });
```

Candidate mapping inside `sitemapBatches` (currently `publishedAt: null, title: null`):

```ts
const candidates = rows.urls.flatMap((row): Candidate[] => {
  if (!includeUrl(profile, row.loc)) return [];
  const lastModified = isoDate(row.lastmod);
  if (lastModified !== null && lastModified < windowStart) return [];
  const newsPublishedAt = isoDate(row.newsPublishedAt);
  if (newsPublishedAt !== null && newsPublishedAt < windowStart) return [];
  return [
    {
      externalItemId: row.loc,
      publishedAt: newsPublishedAt,
      rawBody: document.body,
      rawContentType: document.contentType,
      sourceUrl: document.finalUrl,
      summary: null,
      title: row.newsTitle ?? null,
      url: row.loc,
    },
  ];
});
```

`blocks(row, "news:news")` builds a regex from the literal tag name; `news:news` contains no regex metacharacters, so the existing helper is safe. Do not modify `markup.ts`.

- [ ] **Step 4: Run the full adapter suite**

Run: `pnpm --filter @dot-gov-news/news-backfill test -- run src/adapters.test.ts`
Expected: all tests PASS (plain sitemaps keep working; the news fields are optional).

- [ ] **Step 5: Commit**

```bash
git add apps/news-backfill/src/adapters.ts apps/news-backfill/src/adapters.test.ts
git commit -m "feat: read Google News sitemap dates and titles in sitemap adapter"
```

---

### Task 3: Drupal JSON:API adapter variant

Drupal is the most common federal CMS. Publishers confirmed by the Task 1 probe expose `GET /jsonapi/node/<bundle>?sort=-created&page[limit]=50` with `links.next.href` pagination — the same structured-history win the WordPress adapter provides: stable external IDs (node UUIDs), reliable `created` timestamps for event-time clustering, and summaries without per-article hydration. Implement as a new `publisher_api` variant so brittle HTML-archive sources can switch.

**Files:**
- Modify: `apps/news-backfill/src/types.ts` (add `"drupal_jsonapi"` to the `adapterVariant` union at lines 9–17)
- Modify: `apps/news-backfill/src/adapters.ts` (new `drupalJsonApiBatches` generator + dispatch branch in `enumerateBatches` next to the `cdc`/`nps` branches at ~line 1094)
- Test: `apps/news-backfill/src/adapters.test.ts`

**Interfaces:**
- Consumes: `FetchDocument`, `includeUrl`, `isoDate`, `textFromHtml` (already in `adapters.ts`); `SourceProfile.urlTemplate` carries the article-URL template with an `{alias}` placeholder (e.g. `"https://www.noaa.gov{alias}"`).
- Produces: standard `CandidateBatch` stream. Manifest sources select it with `"adapter": "publisher_api", "adapterVariant": "drupal_jsonapi"`. Cursor shape: `{ nextUrl: string, pages: number }`.

- [ ] **Step 1: Write the failing test**

```ts
it("paginates Drupal JSON:API via links.next and stops at the window boundary", async () => {
  const pageOne = JSON.stringify({
    data: [
      {
        id: "uuid-1",
        attributes: {
          body: { summary: "<p>Summary one</p>" },
          created: "2026-06-01T12:00:00+00:00",
          path: { alias: "/news-release/story-one" },
          title: "Story One",
        },
      },
    ],
    links: {
      next: { href: "https://agency.gov/jsonapi/node/news?page[offset]=50" },
    },
  });
  const pageTwo = JSON.stringify({
    data: [
      {
        id: "uuid-2",
        attributes: {
          body: { summary: "<p>Old summary</p>" },
          created: "2024-01-01T00:00:00+00:00",
          path: { alias: "/news-release/story-old" },
          title: "Old Story",
        },
      },
    ],
    links: {},
  });
  const requested: string[] = [];
  const batches = await collect(
    enumerateBatches({
      cursor: {},
      fetchDocument: async (url) => {
        requested.push(url);
        return {
          body: url.includes("page[offset]") ? pageTwo : pageOne,
          contentType: "application/vnd.api+json",
          finalUrl: url,
          status: 200,
        };
      },
      profile: profile({
        adapter: "publisher_api",
        adapterVariant: "drupal_jsonapi",
        sourceType: "publisher_api",
        sourceUrl:
          "https://agency.gov/jsonapi/node/news?sort=-created&page[limit]=50",
        urlTemplate: "https://agency.gov{alias}",
      }),
      windowEnd: "2026-07-18T00:00:00.000Z",
      windowStart: "2025-07-18T00:00:00.000Z",
    }),
  );
  expect(requested).toHaveLength(2);
  const candidates = batches.flatMap((batch) => batch.candidates);
  expect(candidates).toHaveLength(2);
  expect(candidates[0]).toMatchObject({
    externalItemId: "uuid-1",
    publishedAt: "2026-06-01T12:00:00.000Z",
    summary: "Summary one",
    title: "Story One",
    url: "https://agency.gov/news-release/story-one",
  });
  const last = batches.at(-1);
  expect(last?.coverageReachedAt).toBe("2025-07-18T00:00:00.000Z");
  expect(last?.stopReason).toBe("window_boundary");
});
```

(The out-of-window `uuid-2` candidate is still yielded — the runner already rejects out-of-window items and records dispositions; the adapter's job is stopping pagination once a whole page is older than the window, mirroring the WordPress adapter's stop rule.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dot-gov-news/news-backfill test -- run src/adapters.test.ts -t "Drupal"`
Expected: FAIL — `unsupported adapter: publisher_api/drupal_jsonapi`.

- [ ] **Step 3: Add the variant to types.ts**

In `apps/news-backfill/src/types.ts`, extend the union (alphabetical order):

```ts
adapterVariant?:
  | "cdc"
  | "cdc_solr"
  | "dated_html"
  | "drupal_jsonapi"
  | "nps"
  | "ssa_archive"
  | "wayback"
  | "wayback_feed"
  | "wayback_listing";
```

- [ ] **Step 4: Implement drupalJsonApiBatches in adapters.ts**

```ts
interface DrupalJsonApiPage {
  data?: Array<{
    attributes?: {
      body?: { processed?: unknown; summary?: unknown; value?: unknown };
      created?: unknown;
      path?: { alias?: unknown };
      title?: unknown;
    };
    id?: unknown;
  }>;
  links?: { next?: { href?: unknown } };
}

async function* drupalJsonApiBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  cursor: Record<string, unknown>,
): AsyncGenerator<CandidateBatch> {
  let pageUrl =
    typeof cursor.nextUrl === "string" ? cursor.nextUrl : profile.sourceUrl;
  let pages = typeof cursor.pages === "number" ? cursor.pages : 0;
  while (pages < profile.maxPages) {
    const document = await fetchDocument(pageUrl, profile.allowedHosts);
    let parsed: DrupalJsonApiPage;
    try {
      parsed = JSON.parse(document.body) as DrupalJsonApiPage;
    } catch {
      throw new Error(`drupal JSON:API response is not JSON: ${pageUrl}`);
    }
    const nodes = Array.isArray(parsed.data) ? parsed.data : [];
    const candidates = nodes.flatMap((node): Candidate[] => {
      const alias = node.attributes?.path?.alias;
      if (typeof alias !== "string" || profile.urlTemplate === undefined) {
        return [];
      }
      const url = profile.urlTemplate.replace("{alias}", alias);
      if (!includeUrl(profile, url)) return [];
      const body = node.attributes?.body;
      return [
        {
          externalItemId: typeof node.id === "string" ? node.id : url,
          publishedAt: isoDate(node.attributes?.created),
          rawBody: document.body,
          rawContentType: document.contentType,
          sourceUrl: document.finalUrl,
          summary: textFromHtml(body?.summary ?? body?.processed ?? body?.value),
          title: textFromHtml(node.attributes?.title),
          url,
        },
      ];
    });
    pages += 1;
    const next = parsed.links?.next?.href;
    const newest = candidates
      .map((candidate) => candidate.publishedAt)
      .filter((date): date is string => date !== null)
      .sort()
      .at(-1);
    const crossedWindow = newest !== undefined && newest < windowStart;
    const exhausted =
      typeof next !== "string" || nodes.length === 0 || crossedWindow;
    yield {
      candidates,
      coverageReachedAt:
        crossedWindow || typeof next !== "string" ? windowStart : null,
      cursor: { nextUrl: typeof next === "string" ? next : pageUrl, pages },
      evidenceBody: document.body,
      evidenceContentType: document.contentType,
      evidenceUrl: document.finalUrl,
      ...(exhausted
        ? { stopReason: crossedWindow ? "window_boundary" : "source_exhausted" }
        : {}),
    };
    if (exhausted) return;
    pageUrl = next as string;
  }
}
```

Dispatch branch in `enumerateBatches`, alongside the other `publisher_api` variants:

```ts
if (profile.adapterVariant === "drupal_jsonapi") {
  return drupalJsonApiBatches(profile, fetchDocument, windowStart, cursor);
}
```

Before finalizing the `"window_boundary"` string: grep `stop_reason` in `supabase/migrations/20260718000900_create_news_backfill_control.sql` for an allowed-value constraint; if the column is constrained, use an already-allowed value and adjust the test to match.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dot-gov-news/news-backfill test -- run src/adapters.test.ts`
Expected: PASS, including all pre-existing adapter tests.

- [ ] **Step 6: One live read-only spot check**

Pick one publisher whose Task 1 probe returned `drupal: available` (expected candidates: NOAA, FDA, Treasury, State — all currently on HTML archive or hydrated sitemap sources). Verify the node collection paginates and carries `created`/`path.alias`:

Run: `curl -s "https://www.noaa.gov/jsonapi/node/news?sort=-created&page%5Blimit%5D=5" | head -c 2000`
Expected: JSON:API envelope with `data[].attributes.created` and `data[].attributes.path.alias`. Record the working collection URL in `docs/operations/alternate-source-probe-2026-07.md` next to that publisher. If no cohort publisher exposes a usable node collection, mark Task 4's Drupal swap not-applicable and keep the adapter (tested, dormant) — the wider `government_sites` inventory will use it when these methods move to the infrastructure.

- [ ] **Step 7: Commit**

```bash
git add apps/news-backfill/src/types.ts apps/news-backfill/src/adapters.ts apps/news-backfill/src/adapters.test.ts docs/operations/alternate-source-probe-2026-07.md
git commit -m "feat: add Drupal JSON:API adapter variant"
```

---

### Task 4: Manifest v3 with probe-selected upgrades, staged rerun

Encode the Task 1 evidence into a new frozen manifest and prove the new adapters on live publishers with the same idempotency guarantees as v2. Only publishers whose probe verdict was `available` change sources; everything else is copied verbatim from v2. The evaluation corpus gets strictly better inputs — more real dates, more real summaries, fewer selector-dependent extractions — without moving the frozen evaluation window.

**Files:**
- Create: `config/news-backfill/top-20-diversity-v3.json`
- Modify: `docs/operations/alternate-source-probe-2026-07.md` (record final source decisions + manifest SHA-256)

**Interfaces:**
- Consumes: news-sitemap metadata (Task 2), `drupal_jsonapi` variant (Task 3), probe report (Task 1).
- Produces: the frozen v3 manifest that the clustering/ranking evaluation snapshot references.

- [ ] **Step 1: Draft v3 from v2**

Copy `config/news-backfill/top-20-diversity-v2.json` → `config/news-backfill/top-20-diversity-v3.json`; set `"cohortId": "top-20-diversity-v3"`, `"version": 3`; keep `windowStart`/`windowEnd` identical (same frozen evaluation window). For each publisher the probe upgraded, replace or prepend the source. Drupal example (adjust collection path and hosts to the probe evidence):

```json
{
  "sourceKey": "noaa-jsonapi-news",
  "title": "NOAA News (JSON:API)",
  "sourceUrl": "https://www.noaa.gov/jsonapi/node/news?sort=-created&page%5Blimit%5D=50",
  "urlTemplate": "https://www.noaa.gov{alias}",
  "sourceType": "publisher_api",
  "adapter": "publisher_api",
  "adapterVariant": "drupal_jsonapi",
  "newsSubtype": "agency_news",
  "allowedHosts": ["www.noaa.gov"],
  "includeUrlPattern": "https://www\\.noaa\\.gov/news[^?#]*$",
  "hydrate": true,
  "maxPages": 40
}
```

For a news-sitemap upgrade, point the existing sitemap source's `sourceUrl` at the discovered news sitemap (keep `"adapter": "sitemap"`; Task 2 needs no manifest schema change). Keep `hydrate: true` wherever the summary must come from the article page — news sitemaps carry dates and titles but not summaries, and acceptance criterion 5 of the base plan (≥200-char summaries for 90% of rows) still applies.

- [ ] **Step 2: Validate the manifest offline**

Run: `pnpm --filter @dot-gov-news/news-backfill exec tsx -e "import('./src/config.ts').then(m => m.loadManifest('../../config/news-backfill/top-20-diversity-v3.json')).then(m => console.log(m.cohortId, m.publishers.length))"`
Expected: `top-20-diversity-v3 20`.

- [ ] **Step 3: Dry-run the changed publishers only**

For each publisher whose sources changed (example: noaa):

Run: `pnpm --filter @dot-gov-news/news-backfill backfill -- --manifest config/news-backfill/top-20-diversity-v3.json --publisher noaa --dry-run`
Expected: exit 0, structured progress lines, candidate counts in the same order of magnitude as that publisher's v2 run. Investigate a 5× swing in either direction before proceeding.

- [ ] **Step 4: Live run the changed publishers, then prove idempotency**

Run: `pnpm --filter @dot-gov-news/news-backfill backfill -- --manifest config/news-backfill/top-20-diversity-v3.json --publisher noaa`
Expected: `backfill_completed` summary with `failed: 0`.

Record the `news_entries` total, rerun the identical command, verify zero growth:

`curl -s -o /dev/null -D - -H "apikey: $SUPABASE_SECRET_KEY" -H "authorization: Bearer $SUPABASE_SECRET_KEY" -H "prefer: count=exact" -H "range: 0-0" "$SUPABASE_URL/rest/v1/news_entries?select=id" | grep -i content-range`
Expected: identical totals — rerun yields only `existing_url` / `existing_external_id` dispositions.

- [ ] **Step 5: Compare corpus quality per upgraded publisher**

For each upgraded publisher, query date and summary completeness before/after (v2 origin rows vs v3 run membership) and record in the probe report: percentage of rows with non-null `published_at` inside the window and summaries ≥ 200 chars. Expected: both rates improve or hold; a regression means the new source is worse than probed — revert that publisher's v3 sources to the v2 entries and note why.

- [ ] **Step 6: Freeze and commit**

Record `shasum -a 256 config/news-backfill/top-20-diversity-v3.json` in `docs/operations/alternate-source-probe-2026-07.md`.

```bash
git add config/news-backfill/top-20-diversity-v3.json docs/operations/alternate-source-probe-2026-07.md
git commit -m "feat: freeze top-20-diversity-v3 manifest with structured-source upgrades"
```

---

## Deferred: infrastructure translation

Deliberately out of this plan, by design easy later:

- **Discovery worker adoption.** The probe's classifiers (`classifyProbe`) use the `news_sources` vocabulary (`source_type`, adapter/variant names identical to manifest fields), and the hosted `complete_site_discovery` RPC already accepts `publisher_api`/`sitemap` sources with `adapter_config` and `backfill_supported`. When discovery goes live, the classifiers move into `apps/pipeline-worker/src/discovery/` as probe validators and the Worker client is updated to the generalized `p_sources` contract (it still sends retired `p_feeds`/`feed_type`/`no_feed` fields — the known drift keeping `DISCOVERY_ENABLED=false`). Nothing in this plan makes that harder; the adapter variants built here are exactly what discovered sources will point at.
- **Live polling.** The `drupal_jsonapi` and news-sitemap adapters work unchanged for current-tail polling (`sort=-created`, page 1 only).

## Non-Goals

- Discovery worker changes (`apps/pipeline-worker`) — not live; see Deferred above.
- **External aggregators** — GDELT, Common Crawl CC-NEWS, Media Cloud, Federal Register/GovInfo. They index content *about* the curated sites rather than running on them.
- **Search.gov Results API** — keyless third-party access is closed (per-affiliate `access_key`).
- **GovDelivery bulletins** — hosted off-site on `content.govdelivery.com`.
- Expanding beyond the 20-publisher cohort; building the clustering/ranking algorithms themselves.

## Definition of Done

Probe evidence for all 20 publishers is committed; the sitemap adapter consumes Google News metadata; the `drupal_jsonapi` variant is fixture-tested and either live on at least one publisher or documented as not-applicable for this cohort; `top-20-diversity-v3` is frozen with its SHA-256 recorded; reruns of changed publishers produce zero duplicate growth; per-publisher date/summary completeness improves or holds for every upgraded source; and `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` all pass.
