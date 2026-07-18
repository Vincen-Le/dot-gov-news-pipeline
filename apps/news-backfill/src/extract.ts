import { createHash } from "node:crypto";

import {
  blocks,
  linkHref,
  metaContent,
  stripMarkup,
  tagAttribute,
  tagText,
} from "./markup";
import type { Candidate, NewsSubtype, NormalizedEntry } from "./types";

interface ArticleMetadata {
  canonicalUrl: string | null;
  publishedAt: string | null;
  summary: string | null;
  title: string | null;
}

function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
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

export function extractArticleMetadata(
  html: string,
  pageUrl: string,
): ArticleMetadata {
  let jsonArticle: Record<string, unknown> | null = null;
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    if (jsonArticle !== null) break;
    try {
      jsonArticle = findArticleJson(JSON.parse(match[1] ?? ""));
    } catch {
      // Broken publisher JSON-LD is common; fall through to HTML metadata.
    }
  }
  const article = jsonArticle as Record<string, unknown> | null;

  const canonicalHref = linkHref(html, "canonical");
  let canonicalUrl: string | null = null;
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
    isoDate(metaContent(html, "article:published_time")) ??
    isoDate(metaContent(html, "date")) ??
    isoDate(tagAttribute(html, "time", "datetime")) ??
    isoDate(metaContent(html, "datePublished"));

  const description = cleanText(
    (typeof article?.description === "string" ? article.description : null) ??
      metaContent(html, "description") ??
      metaContent(html, "og:description"),
  );
  const articleBody = cleanText(
    typeof article?.articleBody === "string" ? article.articleBody : null,
  );
  const paragraphBody = cleanText(blocks(html, "p").map(stripMarkup).join(" "));
  const summary =
    (articleBody ?? paragraphBody ?? description)?.slice(0, 16_384) ?? null;

  return { canonicalUrl, publishedAt, summary, title };
}

export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
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
  const summary =
    cleanText(input.candidate.summary ?? metadata?.summary)?.slice(0, 16_384) ??
    null;
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
      `${title.toLowerCase().replace(/\s+/g, " ")}\n${(summary ?? "").toLowerCase().replace(/\s+/g, " ")}`,
    )
    .digest("hex");
  const candidateKey = createHash("sha256")
    .update(`${input.candidate.externalItemId ?? ""}\n${canonicalUrl}`)
    .digest("hex");

  return {
    candidate_key: candidateKey,
    content_hash: contentHash,
    external_item_id: input.candidate.externalItemId,
    extractor_version: 1,
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
