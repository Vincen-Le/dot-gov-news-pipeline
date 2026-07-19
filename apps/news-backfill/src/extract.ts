import { createHash } from "node:crypto";

import { load } from "cheerio";

import {
  linkHref,
  metaContent,
  stripMarkup,
  tagAttribute,
  tagText,
} from "./markup";
import type { Candidate, NewsSubtype, NormalizedEntry } from "./types";

export const EXTRACTOR_VERSION = 3;

interface ArticleMetadata {
  bodyText: string | null;
  canonicalUrl: string | null;
  publishedAt: string | null;
  summary: string | null;
  title: string | null;
}

function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = stripMarkup(value).replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

function articleTextFromHtml(html: string): string | null {
  const $ = load(html);
  $(
    [
      "script",
      "style",
      "noscript",
      "template",
      "svg",
      "form",
      "nav",
      "header",
      "footer",
      "aside",
      "dialog",
      "[hidden]",
      '[aria-hidden="true"]',
      ".usa-banner",
      ".usa-breadcrumb",
      ".breadcrumb",
      ".breadcrumbs",
      ".site-header",
      ".site-footer",
      ".navigation",
      ".pagination",
      ".social-share",
      ".share-buttons",
      ".related-content",
      ".cookie-banner",
      ".feedback",
      ".subscribe",
      '[class*="official-website"]',
      '[id*="official-website"]',
    ].join(","),
  ).remove();

  const selectors = [
    '[itemprop="articleBody"]',
    ".field--name-body",
    ".article-body",
    ".article__body",
    ".news-release-body",
    "main article",
    "article",
    'main [role="main"]',
    "main",
    '[role="main"]',
    "#content",
    "body",
  ];
  const blockSelector = "p, li, h2, h3, h4, blockquote, pre, tr";
  for (const selector of selectors) {
    const values: string[] = [];
    $(selector).each((_index, element) => {
      const container = $(element).clone();
      container
        .find(
          "nav, header, footer, aside, form, .usa-banner, .breadcrumb, .breadcrumbs, .social-share, .share-buttons, .related-content, .pagination, .feedback, .subscribe",
        )
        .remove();
      const parts: string[] = [];
      container.find(blockSelector).each((_blockIndex, block) => {
        if ($(block).parents(blockSelector).length > 0) return;
        const text = cleanText($(block).text());
        if (text !== null) parts.push(text);
      });
      const text = cleanText(
        parts.length > 0 ? parts.join("\n") : container.text(),
      );
      if (text !== null) values.push(text);
    });
    values.sort((left, right) => right.length - left.length);
    if (values[0] !== undefined) return values[0];
  }
  return null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value.replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1"));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function findArticleJson(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findArticleJson(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (
    type === "NewsArticle" ||
    type === "Article" ||
    type === "Report" ||
    (Array.isArray(type) && type.some((entry) => entry === "NewsArticle"))
  ) {
    return record;
  }
  for (const nested of Object.values(record)) {
    const found = findArticleJson(nested);
    if (found !== null) return found;
  }
  return null;
}

function findJsonString(value: unknown, keys: string[]): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonString(item, keys);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  for (const nested of Object.values(record)) {
    const found = findJsonString(nested, keys);
    if (found !== null) return found;
  }
  return null;
}

function dateFromMarkedField(html: string): string | null {
  const patterns = [
    /field--name-field-news-publication-date[\s\S]{0,500}?<time\b[^>]*datetime=["']([^"']+)/i,
    /field--name-field-publication-date-for-dis[\s\S]{0,500}?field__item["'][^>]*>([^<]+)/i,
    /<strong\b[^>]*>\s*News Release Date:\s*<\/strong>\s*([^<\r\n]+)/i,
    /article-meta__publish-date["'][^>]*>\s*([^<\r\n]+)/i,
    /field--name-dynamic-twig-fieldnode-press-release-lead-in[\s\S]{0,500}?<p\b[^>]*>[^<]*?,\s*([A-Z][a-z]{2,8}\.?\s+\d{1,2},\s+20\d{2})/i,
  ];
  for (const pattern of patterns) {
    const normalized = isoDate(pattern.exec(html)?.[1]);
    if (normalized !== null) return normalized;
  }
  return null;
}

function dateFromUrl(pageUrl: string): string | null {
  try {
    const path = new URL(pageUrl).pathname;
    const pathDate =
      /\/(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])(?:\/|$)/.exec(path);
    if (pathDate !== null) {
      return isoDate(`${pathDate[1]}-${pathDate[2]}-${pathDate[3]}`);
    }
    const segmentDate =
      /\/(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[./]|$)/.exec(path);
    if (segmentDate !== null) {
      return isoDate(`${segmentDate[1]}-${segmentDate[2]}-${segmentDate[3]}`);
    }
    const compactDate =
      /_(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(20\d{2})\.[a-z0-9]+$/i.exec(path);
    if (compactDate !== null) {
      return isoDate(`${compactDate[3]}-${compactDate[1]}-${compactDate[2]}`);
    }
  } catch {
    return null;
  }
  return null;
}

export function extractArticleMetadata(
  html: string,
  pageUrl: string,
): ArticleMetadata {
  let jsonArticle: Record<string, unknown> | null = null;
  let jsonDate: string | null = null;
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    if (jsonArticle !== null) break;
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "");
      jsonArticle = findArticleJson(parsed);
      jsonDate ??= findJsonString(parsed, [
        "datePublished",
        "datePosted",
        "dateCreated",
      ]);
    } catch {
      // Broken publisher JSON-LD is common; fall through to HTML metadata.
    }
  }
  const article = jsonArticle as Record<string, unknown> | null;

  const canonicalHref = linkHref(html, "canonical");
  let canonicalUrl: string;
  try {
    canonicalUrl = new URL(canonicalHref ?? pageUrl, pageUrl).href;
  } catch {
    canonicalUrl = pageUrl;
  }

  const title = cleanText(
    (typeof article?.headline === "string" ? article.headline : null) ??
      metaContent(html, "og:title") ??
      tagText(html, ["h1", "title"]),
  );
  const publishedAt =
    isoDate(article?.datePublished) ??
    isoDate(jsonDate) ??
    isoDate(metaContent(html, "article:published_time")) ??
    isoDate(metaContent(html, "cdc:first_published")) ??
    isoDate(metaContent(html, "date")) ??
    isoDate(metaContent(html, "dcterms.created")) ??
    isoDate(metaContent(html, "dcterms.date")) ??
    isoDate(metaContent(html, "dc.date.created")) ??
    isoDate(metaContent(html, "dc.date")) ??
    isoDate(metaContent(html, "datePublished")) ??
    dateFromMarkedField(html) ??
    dateFromUrl(pageUrl) ??
    isoDate(tagAttribute(html, "time", "datetime"));

  const description = cleanText(
    (typeof article?.description === "string" ? article.description : null) ??
      metaContent(html, "description") ??
      metaContent(html, "og:description"),
  );
  const articleBody = cleanText(
    typeof article?.articleBody === "string" ? article.articleBody : null,
  );
  const bodyText = articleBody ?? articleTextFromHtml(html);
  const summary = description;

  return { bodyText, canonicalUrl, publishedAt, summary, title };
}

export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (
      /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|os$|hss_meta$|_hsenc$|_hsmi$|_kx$)/i.test(
        key,
      )
    ) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

export function normalizeCandidate(input: {
  artifactKey: string;
  candidate: Candidate;
  fetchedAt: string;
  metadata?: ArticleMetadata;
  newsSubtype: NewsSubtype;
  windowEnd: string;
  windowStart: string;
}): NormalizedEntry | null {
  const metadata = input.metadata;
  const title = cleanText(input.candidate.title ?? metadata?.title);
  const publishedAt = isoDate(
    input.candidate.publishedAt ?? metadata?.publishedAt,
  );
  const summary = cleanText(input.candidate.summary ?? metadata?.summary);
  const bodyText = cleanText(metadata?.bodyText ?? input.candidate.bodyText);
  const rawUrl = metadata?.canonicalUrl ?? input.candidate.url;
  if (title === null || publishedAt === null) return null;
  if (publishedAt < input.windowStart || publishedAt >= input.windowEnd)
    return null;

  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(rawUrl);
  } catch {
    return null;
  }
  const contentHash = createHash("sha256")
    .update(
      `${title.toLowerCase().replace(/\s+/g, " ")}\n${(summary ?? "").toLowerCase().replace(/\s+/g, " ")}\n${(bodyText ?? "").toLowerCase().replace(/\s+/g, " ")}`,
    )
    .digest("hex");
  const candidateKey = createHash("sha256")
    .update(`${input.candidate.externalItemId ?? ""}\n${canonicalUrl}`)
    .digest("hex");

  return {
    body_text: bodyText,
    candidate_key: candidateKey,
    content_hash: contentHash,
    external_item_id: input.candidate.externalItemId,
    extractor_version: EXTRACTOR_VERSION,
    fetched_at: input.fetchedAt,
    news_subtype: input.newsSubtype,
    published_at: publishedAt,
    raw_artifact_key: input.artifactKey,
    summary,
    title: title.slice(0, 1024),
    url: input.candidate.url.slice(0, 2048),
    url_canonical: canonicalUrl.slice(0, 2048),
  };
}
