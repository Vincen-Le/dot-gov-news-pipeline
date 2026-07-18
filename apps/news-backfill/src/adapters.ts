import type { FetchedDocument } from "./fetcher";
import {
  attributeValue,
  blocks,
  htmlLinks,
  stripMarkup,
  tagAttribute,
  tagText,
} from "./markup";
import type { Candidate, CandidateBatch, SourceProfile } from "./types";

type FetchDocument = (
  url: string,
  allowedHosts: string[],
) => Promise<FetchedDocument>;

function textFromHtml(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = stripMarkup(input);
  return text === "" ? null : text;
}

function isoDate(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function oldestIso(inputs: Array<string | null>): string | null {
  return (
    inputs
      .map(isoDate)
      .filter((date): date is string => date !== null)
      .sort()[0] ?? null
  );
}

function feedCandidates(document: FetchedDocument): Candidate[] {
  const rawItems = blocks(document.body, "item");
  if (rawItems.length === 0) rawItems.push(...blocks(document.body, "entry"));
  return rawItems.flatMap((item) => {
    const url = tagText(item, ["link"]) ?? tagAttribute(item, "link", "href");
    if (url === null) return [];
    const externalItemId = tagText(item, ["guid", "id"]) ?? url;
    return [
      {
        externalItemId,
        publishedAt: tagText(item, ["pubDate", "published", "updated", "date"]),
        rawBody: document.body,
        rawContentType: document.contentType,
        sourceUrl: document.finalUrl,
        summary: tagText(item, [
          "description",
          "summary",
          "encoded",
          "content",
        ]),
        title: tagText(item, ["title"]),
        url,
      },
    ];
  });
}

function templateUrl(
  profile: SourceProfile,
  page: number,
  windowStart: string,
  windowEnd: string,
): string {
  return (profile.urlTemplate ?? profile.sourceUrl)
    .replaceAll("{page}", String(page))
    .replaceAll("{offset}", String((page - 1) * 100))
    .replaceAll("{start}", encodeURIComponent(windowStart))
    .replaceAll("{end}", encodeURIComponent(windowEnd));
}

function includeUrl(profile: SourceProfile, url: string): boolean {
  if (profile.includeUrlPattern === undefined) return true;
  return new RegExp(profile.includeUrlPattern, "i").test(url);
}

async function* syndicationBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  windowEnd: string,
  cursor: Record<string, unknown>,
): AsyncGenerator<CandidateBatch> {
  const isPagedUsgsFeed =
    profile.sourceUrl === "https://www.usgs.gov/news/all/feed" &&
    profile.urlTemplate === undefined;
  const pageStart = profile.pageStart ?? (isPagedUsgsFeed ? 0 : 1);
  const firstPage = Math.max(
    pageStart,
    typeof cursor.page === "number"
      ? cursor.page + 1
      : pageStart,
  );
  const maxPages = isPagedUsgsFeed ? 40 : profile.maxPages;
  for (let page = firstPage; page < firstPage + maxPages; page += 1) {
    const url = isPagedUsgsFeed
      ? `${profile.sourceUrl}?page=${page}`
      : templateUrl(profile, page, windowStart, windowEnd);
    const document = await fetchDocument(url, profile.allowedHosts);
    const candidates = feedCandidates(document).filter((candidate) =>
      includeUrl(profile, candidate.url),
    );
    if (candidates.length === 0) return;
    const oldest = oldestIso(
      candidates.map((candidate) => candidate.publishedAt),
    );
    yield {
      candidates,
      coverageReachedAt: oldest,
      cursor: { page },
      evidenceBody: document.body,
      evidenceContentType: document.contentType,
      evidenceUrl: document.finalUrl,
      stopReason:
        oldest !== null && oldest < windowStart
          ? "window_boundary_reached"
          : profile.urlTemplate === undefined && !isPagedUsgsFeed
            ? "source_exhausted"
            : undefined,
    };
    if (oldest !== null && oldest < windowStart) return;
    if (profile.urlTemplate === undefined && !isPagedUsgsFeed) return;
  }
}

async function* wordpressBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  windowEnd: string,
  cursor: Record<string, unknown>,
): AsyncGenerator<CandidateBatch> {
  const firstPage = typeof cursor.page === "number" ? cursor.page + 1 : 1;
  const pageSize = profile.pageSize ?? 100;
  for (let page = firstPage; page <= profile.maxPages; page += 1) {
    const separator = profile.sourceUrl.includes("?") ? "&" : "?";
    const url = `${profile.sourceUrl}${separator}per_page=${pageSize}&page=${page}&after=${encodeURIComponent(windowStart)}&before=${encodeURIComponent(windowEnd)}&_fields=id,link,date_gmt,title,excerpt,content`;
    let document: FetchedDocument;
    try {
      document = await fetchDocument(url, profile.allowedHosts);
    } catch (error) {
      if (
        page > 1 &&
        error instanceof Error &&
        error.message.includes("HTTP 400")
      )
        return;
      throw error;
    }
    const posts = JSON.parse(document.body) as Array<Record<string, unknown>>;
    if (!Array.isArray(posts) || posts.length === 0) return;
    const candidates = posts.flatMap((post): Candidate[] => {
      if (typeof post.link !== "string") return [];
      const title = post.title as Record<string, unknown> | undefined;
      const excerpt = post.excerpt as Record<string, unknown> | undefined;
      const content = post.content as Record<string, unknown> | undefined;
      return [
        {
          externalItemId: String(post.id ?? post.link),
          publishedAt:
            typeof post.date_gmt === "string" ? `${post.date_gmt}Z` : null,
          rawBody: document.body,
          rawContentType: document.contentType,
          sourceUrl: document.finalUrl,
          summary:
            textFromHtml(excerpt?.rendered) ?? textFromHtml(content?.rendered),
          title: textFromHtml(title?.rendered),
          url: post.link,
        },
      ];
    });
    const oldest = oldestIso(candidates.map(({ publishedAt }) => publishedAt));
    const reachedBoundary = oldest !== null && oldest < windowStart;
    const sourceExhausted = posts.length < pageSize;
    yield {
      candidates,
      coverageReachedAt: reachedBoundary
        ? oldest
        : sourceExhausted
          ? windowStart
          : null,
      cursor: { page },
      evidenceBody: document.body,
      evidenceContentType: document.contentType,
      evidenceUrl: document.finalUrl,
      stopReason: reachedBoundary
        ? "window_boundary_reached"
        : sourceExhausted
          ? "source_exhausted"
          : undefined,
    };
    if (reachedBoundary || sourceExhausted) return;
  }
}

async function* htmlArchiveBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  windowEnd: string,
  cursor: Record<string, unknown>,
): AsyncGenerator<CandidateBatch> {
  const seen = new Set<string>();
  const pageStart = profile.pageStart ?? 0;
  const firstPage =
    typeof cursor.page === "number" ? cursor.page + 1 : pageStart;
  let emptyPages = 0;
  for (let page = firstPage; page < firstPage + profile.maxPages; page += 1) {
    const url = templateUrl(profile, page, windowStart, windowEnd);
    const document = await fetchDocument(url, profile.allowedHosts);
    const candidates: Candidate[] = [];
    for (const link of htmlLinks(document.body, document.finalUrl)) {
      if (!includeUrl(profile, link.url) || seen.has(link.url)) continue;
      seen.add(link.url);
      candidates.push({
        externalItemId: link.url,
        publishedAt: null,
        rawBody: document.body,
        rawContentType: document.contentType,
        sourceUrl: document.finalUrl,
        summary: null,
        title: textFromHtml(link.text),
        url: link.url,
      });
    }
    emptyPages = candidates.length === 0 ? emptyPages + 1 : 0;
    yield {
      candidates,
      coverageReachedAt: emptyPages >= 2 ? windowStart : null,
      cursor: { page },
      evidenceBody: document.body,
      evidenceContentType: document.contentType,
      evidenceUrl: document.finalUrl,
      stopReason: emptyPages >= 2 ? "source_exhausted" : undefined,
    };
    if (emptyPages >= 2) return;
  }
}

async function* datedHtmlBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  windowEnd: string,
  cursor: Record<string, unknown>,
): AsyncGenerator<CandidateBatch> {
  const pageStart = profile.pageStart ?? 0;
  const firstPage =
    typeof cursor.page === "number" ? cursor.page + 1 : pageStart;
  const seen = new Set<string>();
  let emptyPages = 0;
  for (let page = firstPage; page < firstPage + profile.maxPages; page += 1) {
    const url = templateUrl(profile, page, windowStart, windowEnd);
    const document = await fetchDocument(url, profile.allowedHosts);
    const candidates: Candidate[] = [];
    for (const match of document.body.matchAll(
      /<time\b[^>]*datetime=["']([^"']+)["'][^>]*>[\s\S]{0,500}?<(?:div|h3)\b[^>]*class=["'][^"']*(?:news-title|featured-stories__headline)[^"']*["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    )) {
      const href = attributeValue(match[2] ?? "", "href");
      if (href === null) continue;
      let articleUrl: string;
      try {
        articleUrl = new URL(href, document.finalUrl).href;
      } catch {
        continue;
      }
      if (!includeUrl(profile, articleUrl) || seen.has(articleUrl)) continue;
      seen.add(articleUrl);
      const title = textFromHtml(match[3]);
      candidates.push({
        externalItemId: articleUrl,
        publishedAt: isoDate(match[1]),
        rawBody: document.body,
        rawContentType: document.contentType,
        sourceUrl: document.finalUrl,
        summary: title,
        title,
        url: articleUrl,
      });
    }
    emptyPages = candidates.length === 0 ? emptyPages + 1 : 0;
    const oldest = oldestIso(candidates.map(({ publishedAt }) => publishedAt));
    const reachedBoundary = oldest !== null && oldest < windowStart;
    const sourceExhausted = emptyPages >= 2;
    yield {
      candidates,
      coverageReachedAt: reachedBoundary
        ? oldest
        : sourceExhausted
          ? windowStart
          : null,
      cursor: { page },
      evidenceBody: document.body,
      evidenceContentType: document.contentType,
      evidenceUrl: document.finalUrl,
      stopReason: reachedBoundary
        ? "window_boundary_reached"
        : sourceExhausted
          ? "source_exhausted"
          : undefined,
    };
    if (reachedBoundary || sourceExhausted) return;
  }
}

interface SitemapRow {
  lastmod?: string;
  loc: string;
}

function sitemapRows(body: string): {
  indexes: SitemapRow[];
  urls: SitemapRow[];
} {
  const convert = (rows: string[]): SitemapRow[] =>
    rows.flatMap((row) => {
      const loc = tagText(row, ["loc"]);
      if (loc === null) return [];
      const lastmod = tagText(row, ["lastmod"]);
      return lastmod === null ? [{ loc }] : [{ lastmod, loc }];
    });
  return {
    indexes: convert(blocks(body, "sitemap")),
    urls: convert(blocks(body, "url")),
  };
}

async function* sitemapBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  cursor: Record<string, unknown>,
): AsyncGenerator<CandidateBatch> {
  const processedCursor =
    typeof cursor.processedSitemaps === "number"
      ? cursor.processedSitemaps
      : 0;
  const savedQueue = Array.isArray(cursor.remainingSitemaps)
    ? cursor.remainingSitemaps.filter(
        (url): url is string => typeof url === "string",
      )
    : [];
  const savedVisited = Array.isArray(cursor.visitedSitemaps)
    ? cursor.visitedSitemaps.filter(
        (url): url is string => typeof url === "string",
      )
    : [];
  const queue = [...savedQueue];
  const visited = new Set<string>(savedVisited);
  let processed = processedCursor;

  if (queue.length === 0 && processed === 0) {
    queue.push(profile.sourceUrl);
  } else if (queue.length === 0 && processed > 0) {
    const root = await fetchDocument(profile.sourceUrl, profile.allowedHosts);
    const rootRows = sitemapRows(root.body);
    visited.add(profile.sourceUrl);
    if (rootRows.indexes.length === 0) {
      yield {
        candidates: [],
        coverageReachedAt: windowStart,
        cursor: {
          processedSitemaps: processed,
          queuedSitemaps: 0,
          remainingSitemaps: [],
          visitedSitemaps: [...visited],
        },
        evidenceBody: root.body,
        evidenceContentType: root.contentType,
        evidenceUrl: root.finalUrl,
        stopReason: "source_exhausted",
      };
      return;
    }
    const completedChildren = Math.max(0, processed - 1);
    for (const child of rootRows.indexes.slice(0, completedChildren)) {
      visited.add(child.loc);
    }
    queue.push(
      ...rootRows.indexes.slice(completedChildren).map(({ loc }) => loc),
    );
  }

  while (queue.length > 0 && processed < profile.maxPages) {
    const url = queue.shift();
    if (url === undefined || visited.has(url)) continue;
    visited.add(url);
    processed += 1;
    const document = await fetchDocument(url, profile.allowedHosts);
    const rows = sitemapRows(document.body);
    for (const child of rows.indexes) {
      if (!visited.has(child.loc)) queue.push(child.loc);
    }
    const candidates = rows.urls.flatMap((row): Candidate[] => {
      if (!includeUrl(profile, row.loc)) return [];
      const lastModified = isoDate(row.lastmod);
      if (lastModified !== null && lastModified < windowStart) return [];
      return [
        {
          externalItemId: row.loc,
          publishedAt: null,
          rawBody: document.body,
          rawContentType: document.contentType,
          sourceUrl: document.finalUrl,
          summary: null,
          title: null,
          url: row.loc,
        },
      ];
    });
    yield {
      candidates,
      coverageReachedAt: queue.length === 0 ? windowStart : null,
      cursor: {
        processedSitemaps: processed,
        queuedSitemaps: queue.length,
        remainingSitemaps: [...queue],
        visitedSitemaps: [...visited],
      },
      evidenceBody: document.body,
      evidenceContentType: document.contentType,
      evidenceUrl: document.finalUrl,
      stopReason: queue.length === 0 ? "source_exhausted" : undefined,
    };
  }
}

async function* cdcApiBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  cursor: Record<string, unknown>,
): AsyncGenerator<CandidateBatch> {
  const firstPage = typeof cursor.page === "number" ? cursor.page + 1 : 1;
  for (let page = firstPage; page < firstPage + profile.maxPages; page += 1) {
    const url = `${profile.sourceUrl}?max=100&pagenum=${page}`;
    const document = await fetchDocument(url, profile.allowedHosts);
    const payload = JSON.parse(document.body) as {
      results?: Array<Record<string, unknown>>;
    };
    const results = payload.results ?? [];
    if (results.length === 0) return;
    const candidates = results.flatMap((item): Candidate[] => {
      const sourceUrl =
        typeof item.sourceUrl === "string" ? item.sourceUrl : null;
      if (sourceUrl === null || !includeUrl(profile, sourceUrl)) return [];
      return [
        {
          externalItemId: String(item.id ?? sourceUrl),
          publishedAt:
            typeof item.datePublished === "string" ? item.datePublished : null,
          rawBody: document.body,
          rawContentType: document.contentType,
          sourceUrl: document.finalUrl,
          summary:
            typeof item.description === "string"
              ? textFromHtml(item.description)
              : null,
          title: typeof item.name === "string" ? item.name : null,
          url: sourceUrl,
        },
      ];
    });
    const oldestResult = oldestIso(
      results.map((item) =>
        typeof item.datePublished === "string" ? item.datePublished : null,
      ),
    );
    yield {
      candidates,
      coverageReachedAt: oldestResult ?? null,
      cursor: { page },
      evidenceBody: document.body,
      evidenceContentType: document.contentType,
      evidenceUrl: document.finalUrl,
      stopReason:
        oldestResult !== null && oldestResult < windowStart
          ? "window_boundary_reached"
          : undefined,
    };
    if (oldestResult !== null && oldestResult < windowStart) return;
  }
}

async function* cdcSolrBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  windowEnd: string,
): AsyncGenerator<CandidateBatch> {
  const years: string[] = [];
  for (
    let year = Number(windowStart.slice(0, 4));
    year <= Number(windowEnd.slice(0, 4));
    year += 1
  ) {
    years.push(`permalink:*/media/releases/${year}/*`);
  }
  const url = new URL(profile.sourceUrl);
  url.searchParams.set("q", "*:*");
  url.searchParams.append("fq", "site_id:191");
  url.searchParams.append("fq", `(${years.join(" OR ")})`);
  url.searchParams.append("fq", '-status:"cdc_archive"');
  url.searchParams.append("fq", "cdc_sys_lang_str:en");
  url.searchParams.set("sort", "cdc_article_date_dt desc");
  url.searchParams.set("rows", "1000");
  url.searchParams.set(
    "fl",
    "id,type,type_txt,title_txt,permalink,cdc_article_date_dt,excerpt_txt",
  );
  url.searchParams.set("wt", "json");
  const document = await fetchDocument(url.href, profile.allowedHosts);
  const payload = JSON.parse(document.body) as {
    response?: { docs?: Array<Record<string, unknown>> };
  };
  const rows = payload.response?.docs ?? [];
  const candidates = rows.flatMap((item): Candidate[] => {
    if (
      typeof item.permalink !== "string" ||
      typeof item.title_txt !== "string" ||
      typeof item.cdc_article_date_dt !== "string"
    ) {
      return [];
    }
    return [
      {
        externalItemId: String(item.id ?? item.permalink),
        publishedAt: item.cdc_article_date_dt,
        rawBody: document.body,
        rawContentType: document.contentType,
        sourceUrl: document.finalUrl,
        summary:
          typeof item.excerpt_txt === "string"
            ? item.excerpt_txt
            : item.title_txt,
        title: item.title_txt,
        url: item.permalink,
      },
    ];
  });
  if (candidates.length === 0)
    throw new Error("CDC search returned no releases");
  yield {
    candidates,
    coverageReachedAt: windowStart,
    cursor: { rows: candidates.length },
    evidenceBody: document.body,
    evidenceContentType: document.contentType,
    evidenceUrl: document.finalUrl,
    stopReason: "source_exhausted",
  };
}

async function* npsApiBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  cursor: Record<string, unknown>,
): AsyncGenerator<CandidateBatch> {
  const apiKey =
    process.env[profile.apiKeyEnvironment ?? "NPS_API_KEY"] ?? "DEMO_KEY";
  const firstPage = typeof cursor.page === "number" ? cursor.page + 1 : 1;
  for (let page = firstPage; page < firstPage + profile.maxPages; page += 1) {
    const offset = (page - 1) * 50;
    const url = `${profile.sourceUrl}?limit=50&start=${offset}&sort=-releasedate&api_key=${encodeURIComponent(apiKey)}`;
    const document = await fetchDocument(url, profile.allowedHosts);
    const payload = JSON.parse(document.body) as {
      data?: Array<Record<string, unknown>>;
      error?: { code?: string; message?: string };
    };
    if (payload.error !== undefined) {
      throw new Error(
        `NPS API ${payload.error.code ?? "error"}: ${payload.error.message ?? "unknown error"}`,
      );
    }
    const rows = payload.data ?? [];
    if (rows.length === 0) return;
    const candidates = rows.flatMap((item): Candidate[] => {
      const articleUrl = typeof item.url === "string" ? item.url : null;
      if (articleUrl === null) return [];
      return [
        {
          externalItemId: String(item.id ?? articleUrl),
          publishedAt:
            typeof item.releaseDate === "string" ? item.releaseDate : null,
          rawBody: document.body,
          rawContentType: document.contentType,
          sourceUrl: document.finalUrl,
          summary:
            typeof item.abstract === "string"
              ? textFromHtml(item.abstract)
              : null,
          title: typeof item.title === "string" ? item.title : null,
          url: articleUrl,
        },
      ];
    });
    const oldest = oldestIso(
      candidates.map((candidate) => candidate.publishedAt),
    );
    yield {
      candidates,
      coverageReachedAt: oldest ?? null,
      cursor: { page },
      evidenceBody: document.body,
      evidenceContentType: document.contentType,
      evidenceUrl: document.finalUrl,
      stopReason:
        oldest !== null && oldest < windowStart
          ? "window_boundary_reached"
          : undefined,
    };
    if (oldest !== null && oldest < windowStart) return;
  }
}

interface WaybackRow {
  digest: string | null;
  original: string;
  timestamp: string;
}

function waybackRows(body: string): WaybackRow[] {
  const rows = JSON.parse(body) as string[][];
  return rows.slice(1).flatMap((row): WaybackRow[] => {
    const [timestamp, original, _status, digest] = row;
    if (timestamp === undefined || original === undefined) return [];
    return [{ digest: digest ?? null, original, timestamp }];
  });
}

function cdxUrl(
  profile: SourceProfile,
  windowStart: string,
  windowEnd: string,
  collapse: string,
  mimetype: string | null = "text/html",
  filterToWindowYears = false,
): string {
  const from = windowStart.slice(0, 10).replaceAll("-", "");
  const to = windowEnd.slice(0, 10).replaceAll("-", "");
  const mimeFilter =
    mimetype === null ? "" : `&filter=mimetype:${encodeURIComponent(mimetype)}`;
  const years = [...new Set([windowStart.slice(0, 4), windowEnd.slice(0, 4)])];
  const yearFilter = filterToWindowYears
    ? `&filter=${encodeURIComponent(`original:.*(${years.join("|")}).*`)}`
    : "";
  return `${profile.sourceUrl}&from=${from}&to=${to}&output=json&filter=statuscode:200${mimeFilter}${yearFilter}&collapse=${encodeURIComponent(collapse)}&fl=timestamp,original,statuscode,digest`;
}

function archivedUrl(row: WaybackRow, original = row.original): string {
  return `https://web.archive.org/web/${row.timestamp}id_/${original}`;
}

function originalUrl(input: string): string | null {
  try {
    const url = new URL(input);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (
        /^(utm_|fbclid$|gclid$|ref$|os$|hss_meta$|_hsenc$|_hsmi$|_kx$)/i.test(
          key,
        )
      )
        url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

function dateHintFromUrl(input: string): string | null {
  try {
    const path = new URL(input).pathname;
    const pathDate =
      /\/(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])(?:\/|$)/.exec(
        path,
      );
    if (pathDate !== null)
      return isoDate(`${pathDate[1]}-${pathDate[2]}-${pathDate[3]}`);
    const segmentDate =
      /\/(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:\/|$)/.exec(
        path,
      );
    if (segmentDate !== null)
      return isoDate(`${segmentDate[1]}-${segmentDate[2]}-${segmentDate[3]}`);
    const compactDate =
      /_(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(20\d{2})\.[a-z0-9]+$/i.exec(
        path,
      );
    if (compactDate !== null)
      return isoDate(`${compactDate[3]}-${compactDate[1]}-${compactDate[2]}`);
  } catch {
    return null;
  }
  return null;
}

function yearHintFromUrl(input: string): string | null {
  try {
    return /(?:\/|_)(20\d{2})(?:[-_/]|$)/.exec(new URL(input).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function* waybackBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  windowEnd: string,
): AsyncGenerator<CandidateBatch> {
  const url = cdxUrl(
    profile,
    windowStart,
    windowEnd,
    "urlkey",
    "text/html",
    true,
  );
  const document = await fetchDocument(url, profile.allowedHosts);
  const latest = new Map<string, WaybackRow>();
  for (const row of waybackRows(document.body)) {
    const original = originalUrl(row.original);
    const dateHint = original === null ? null : dateHintFromUrl(original);
    const yearHint = original === null ? null : yearHintFromUrl(original);
    if (
      original !== null &&
      includeUrl(profile, original) &&
      (dateHint === null ||
        (dateHint >= windowStart && dateHint < windowEnd)) &&
      (yearHint === null ||
        (yearHint >= windowStart.slice(0, 4) &&
          yearHint <= windowEnd.slice(0, 4)))
    )
      latest.set(original, row);
  }
  const candidates = [...latest.entries()].map(
    ([original, row]): Candidate => ({
      externalItemId: row.digest ?? `${row.timestamp}:${original}`,
      fetchUrl: archivedUrl(row, original),
      publishedAt: dateHintFromUrl(original),
      rawBody: document.body,
      rawContentType: document.contentType,
      sourceUrl: document.finalUrl,
      summary: null,
      title: null,
      url: original,
    }),
  );
  yield {
    candidates,
    coverageReachedAt: windowStart,
    cursor: { page: 1 },
    evidenceBody: document.body,
    evidenceContentType: document.contentType,
    evidenceUrl: document.finalUrl,
    stopReason: "source_exhausted",
  };
}

async function* waybackFeedBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  windowEnd: string,
): AsyncGenerator<CandidateBatch> {
  const cdx = await fetchDocument(
    cdxUrl(profile, windowStart, windowEnd, "timestamp:6", null),
    profile.allowedHosts,
  );
  const candidatesByUrl = new Map<string, Candidate>();
  for (const row of waybackRows(cdx.body)) {
    const feed = await fetchDocument(archivedUrl(row), profile.allowedHosts);
    for (const candidate of feedCandidates(feed)) {
      const original = originalUrl(candidate.url);
      if (original === null || !includeUrl(profile, original)) continue;
      candidatesByUrl.set(original, { ...candidate, url: original });
    }
  }
  if (candidatesByUrl.size === 0) {
    throw new Error("Wayback feed snapshots yielded no news items");
  }
  yield {
    candidates: [...candidatesByUrl.values()],
    coverageReachedAt: windowStart,
    cursor: { snapshots: waybackRows(cdx.body).length },
    evidenceBody: cdx.body,
    evidenceContentType: cdx.contentType,
    evidenceUrl: cdx.finalUrl,
    stopReason: "source_exhausted",
  };
}

async function* waybackListingBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  windowEnd: string,
): AsyncGenerator<CandidateBatch> {
  const cdx = await fetchDocument(
    cdxUrl(profile, windowStart, windowEnd, "timestamp:6"),
    profile.allowedHosts,
  );
  const candidatesByUrl = new Map<string, Candidate>();
  for (const row of waybackRows(cdx.body)) {
    let listing: FetchedDocument;
    try {
      listing = await fetchDocument(archivedUrl(row), profile.allowedHosts);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("anti-bot challenge")
      )
        continue;
      throw error;
    }
    for (const match of listing.body.matchAll(
      /<article\b[^>]*class=["'][^"']*news-content-listing[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi,
    )) {
      const body = match[1] ?? "";
      const link = htmlLinks(body, row.original).find(({ url }) =>
        includeUrl(profile, url),
      );
      const original = link === undefined ? null : originalUrl(link.url);
      const title = tagText(body, ["h2", "h3"]);
      const publishedAt = tagAttribute(body, "time", "datetime");
      if (original === null || title === null || publishedAt === null) continue;
      const summary = textFromHtml(blocks(body, "p").join(" ")) ?? title;
      candidatesByUrl.set(original, {
        externalItemId: original,
        publishedAt,
        rawBody: listing.body,
        rawContentType: listing.contentType,
        sourceUrl: listing.finalUrl,
        summary,
        title,
        url: original,
      });
    }
  }
  if (candidatesByUrl.size === 0) {
    throw new Error("Wayback listings yielded no matching news URLs");
  }
  yield {
    candidates: [...candidatesByUrl.values()],
    coverageReachedAt: windowStart,
    cursor: { snapshots: waybackRows(cdx.body).length },
    evidenceBody: cdx.body,
    evidenceContentType: cdx.contentType,
    evidenceUrl: cdx.finalUrl,
    stopReason: "source_exhausted",
  };
}

async function* ssaArchiveBatches(
  profile: SourceProfile,
  fetchDocument: FetchDocument,
  windowStart: string,
  windowEnd: string,
): AsyncGenerator<CandidateBatch> {
  const cdx = await fetchDocument(
    cdxUrl(profile, windowStart, windowEnd, "digest"),
    profile.allowedHosts,
  );
  const latestByYear = new Map<string, WaybackRow>();
  const firstYear = windowStart.slice(0, 4);
  const lastYear = windowEnd.slice(0, 4);
  for (const row of waybackRows(cdx.body)) {
    const original = originalUrl(row.original);
    const match = original?.match(/\/releases\/(20\d{2})\/?$/);
    if (
      match?.[1] !== undefined &&
      match[1] >= firstYear &&
      match[1] <= lastYear
    ) {
      latestByYear.set(match[1], row);
    }
  }
  const candidates: Candidate[] = [];
  let evidenceBody = cdx.body;
  let evidenceUrl = cdx.finalUrl;
  for (const [year, row] of latestByYear) {
    const page = await fetchDocument(archivedUrl(row), profile.allowedHosts);
    evidenceBody = page.body;
    evidenceUrl = page.finalUrl;
    for (const match of page.body.matchAll(
      /<article\b([^>]*\bid=["'][^"']+["'][^>]*)>([\s\S]*?)<\/article>/gi,
    )) {
      const id = attributeValue(match[1] ?? "", "id");
      const body = match[2] ?? "";
      if (id === null || !/^20\d{2}-\d{2}-\d{2}(?:-[a-z])?$/.test(id)) continue;
      const publishedAt = isoDate(id.slice(0, 10));
      const title = tagText(body, ["h3", "h2"]);
      if (publishedAt === null || title === null) continue;
      const url = `${row.original.split("?")[0]}#${id}`;
      candidates.push({
        externalItemId: `${year}:${id}`,
        publishedAt,
        rawBody: page.body,
        rawContentType: page.contentType,
        sourceUrl: page.finalUrl,
        summary: stripMarkup(body).slice(0, 16_384),
        title,
        url,
      });
    }
  }

  const blogProfile: SourceProfile = {
    ...profile,
    sourceUrl:
      "https://web.archive.org/cdx/search/cdx?url=blog.ssa.gov/feed/",
  };
  const blogCdx = await fetchDocument(
    cdxUrl(blogProfile, windowStart, windowEnd, "timestamp:6", null),
    profile.allowedHosts,
  );
  const blogCandidates = new Map<string, Candidate>();
  for (const row of waybackRows(blogCdx.body)) {
    const feed = await fetchDocument(archivedUrl(row), profile.allowedHosts);
    for (const candidate of feedCandidates(feed)) {
      const original = originalUrl(candidate.url);
      if (original === null) continue;
      try {
        if (new URL(original).hostname !== "blog.ssa.gov") continue;
      } catch {
        continue;
      }
      blogCandidates.set(original, {
        ...candidate,
        newsSubtype: "agency_news",
        url: original,
      });
    }
  }
  candidates.push(...blogCandidates.values());

  if (candidates.length === 0) {
    throw new Error("SSA archive yielded no press-release articles");
  }
  yield {
    candidates,
    coverageReachedAt: windowStart,
    cursor: {
      archivedYears: [...latestByYear.keys()],
      blogSnapshots: waybackRows(blogCdx.body).length,
    },
    evidenceBody,
    evidenceContentType: "text/html",
    evidenceUrl,
    stopReason: "source_exhausted",
  };
}

export function enumerateBatches(input: {
  cursor: Record<string, unknown>;
  fetchDocument: FetchDocument;
  profile: SourceProfile;
  windowEnd: string;
  windowStart: string;
}): AsyncGenerator<CandidateBatch> {
  const { cursor, fetchDocument, profile, windowEnd, windowStart } = input;
  if (profile.adapterVariant === "dated_html") {
    return datedHtmlBatches(
      profile,
      fetchDocument,
      windowStart,
      windowEnd,
      cursor,
    );
  }
  if (profile.adapter === "syndication") {
    return syndicationBatches(
      profile,
      fetchDocument,
      windowStart,
      windowEnd,
      cursor,
    );
  }
  if (profile.adapter === "wordpress") {
    return wordpressBatches(
      profile,
      fetchDocument,
      windowStart,
      windowEnd,
      cursor,
    );
  }
  if (profile.adapter === "sitemap") {
    return sitemapBatches(profile, fetchDocument, windowStart, cursor);
  }
  if (profile.adapter === "html_archive") {
    return htmlArchiveBatches(
      profile,
      fetchDocument,
      windowStart,
      windowEnd,
      cursor,
    );
  }
  if (profile.adapterVariant === "cdc") {
    return cdcApiBatches(profile, fetchDocument, windowStart, cursor);
  }
  if (profile.adapterVariant === "cdc_solr") {
    return cdcSolrBatches(profile, fetchDocument, windowStart, windowEnd);
  }
  if (profile.adapterVariant === "nps") {
    return npsApiBatches(profile, fetchDocument, windowStart, cursor);
  }
  if (profile.adapterVariant === "wayback") {
    return waybackBatches(profile, fetchDocument, windowStart, windowEnd);
  }
  if (profile.adapterVariant === "wayback_listing") {
    return waybackListingBatches(
      profile,
      fetchDocument,
      windowStart,
      windowEnd,
    );
  }
  if (profile.adapterVariant === "wayback_feed") {
    return waybackFeedBatches(profile, fetchDocument, windowStart, windowEnd);
  }
  if (profile.adapterVariant === "ssa_archive") {
    return ssaArchiveBatches(profile, fetchDocument, windowStart, windowEnd);
  }
  throw new Error(
    `unsupported adapter: ${profile.adapter}/${profile.adapterVariant ?? "default"}`,
  );
}
