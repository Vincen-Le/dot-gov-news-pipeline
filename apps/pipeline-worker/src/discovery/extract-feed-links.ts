import type { DiscoveryMethod } from "../clients/site-discovery-repository";
import {
  DISCOVERY_MAX_CANDIDATES,
  DISCOVERY_MAX_LANDING_PAGES,
  FEED_MEDIA_TYPES,
} from "./discovery-policy";
import { UnsafeUrlError, validatePublisherUrl } from "./url-safety";

export interface ExtractedFeedLink {
  discoveryMethod: DiscoveryMethod;
  discoveryUrl: string;
  url: string;
}

export interface ExtractedPageLinks {
  feeds: ExtractedFeedLink[];
  landingPages: string[];
}

const FEED_HINT = /(?:^|[\s/_\-.])(rss|atom|feed|feeds)(?:$|[\s/_\-.])/i;
const LANDING_HINT = /(?:news|press(?:-releases?)?|newsroom|alerts?|blog)/i;

export type FeedLinkExtractor = (
  body: Uint8Array,
  baseUrl: URL,
  linkHeader: string | null,
) => Promise<ExtractedPageLinks>;

export function normalizeMediaType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function resolvePublisherLink(
  value: string,
  baseUrl: URL,
): string | null {
  try {
    return validatePublisherUrl(value, baseUrl).href;
  } catch (error) {
    if (error instanceof UnsafeUrlError) return null;
    throw error;
  }
}

export function isFeedLinkEvidence(value: string): boolean {
  return FEED_HINT.test(value);
}

export function isLandingPageEvidence(value: string): boolean {
  return LANDING_HINT.test(value);
}

export function extractHttpFeedLinks(
  header: string | null,
  baseUrl: URL,
): ExtractedFeedLink[] {
  if (header === null || header.length > 16_384) return [];
  const links: ExtractedFeedLink[] = [];
  for (const part of header.split(/,(?=\s*<)/)) {
    const match = part.match(/^\s*<([^>]+)>(.*)$/s);
    if (match?.[1] === undefined) continue;
    const parameters = match[2] ?? "";
    const rel = parameters.match(/;\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    const type = parameters.match(/;\s*type\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    const relationships = (rel?.[1] ?? rel?.[2] ?? "")
      .toLowerCase()
      .split(/\s+/);
    const declaredType = normalizeMediaType(type?.[1] ?? type?.[2] ?? null);
    if (
      !relationships.includes("alternate") ||
      !FEED_MEDIA_TYPES.has(declaredType)
    )
      continue;
    const url = resolvePublisherLink(match[1], baseUrl);
    if (
      url !== null &&
      links.length < DISCOVERY_MAX_CANDIDATES &&
      !links.some((link) => link.url === url)
    ) {
      links.push({ discoveryMethod: "http_link", discoveryUrl: url, url });
    }
  }
  return links;
}

export const extractFeedLinks: FeedLinkExtractor = async (
  body: Uint8Array,
  baseUrl: URL,
  linkHeader: string | null,
): Promise<ExtractedPageLinks> => {
  const feeds = extractHttpFeedLinks(linkHeader, baseUrl);
  const landingPages: string[] = [];
  const feedUrls = new Set(feeds.map((feed) => feed.url));
  const landingPageUrls = new Set<string>();
  const addFeed = (feed: ExtractedFeedLink): void => {
    if (feeds.length >= DISCOVERY_MAX_CANDIDATES || feedUrls.has(feed.url)) {
      return;
    }
    feedUrls.add(feed.url);
    feeds.push(feed);
  };
  const addLandingPage = (url: string): void => {
    if (
      landingPages.length >= DISCOVERY_MAX_LANDING_PAGES ||
      landingPageUrls.has(url)
    ) {
      return;
    }
    landingPageUrls.add(url);
    landingPages.push(url);
  };
  let activeAnchor:
    | { elementToken: symbol; href: string; text: string; title: string }
    | undefined;

  const transformed = new HTMLRewriter()
    .on('link[rel~="alternate"][href]', {
      element(element) {
        const href = element.getAttribute("href");
        const type = normalizeMediaType(element.getAttribute("type"));
        if (
          href === null ||
          href.length > 2_048 ||
          !FEED_MEDIA_TYPES.has(type)
        ) {
          return;
        }
        const url = resolvePublisherLink(href, baseUrl);
        if (url !== null) {
          addFeed({
            discoveryMethod: "html_alternate",
            discoveryUrl: url,
            url,
          });
        }
      },
    })
    .on("a[href]", {
      element(element) {
        const href = element.getAttribute("href");
        if (href === null || href.length > 2_048) return;
        const token = Symbol("anchor");
        activeAnchor = {
          elementToken: token,
          href,
          text: "",
          title:
            `${element.getAttribute("title") ?? ""} ${element.getAttribute("aria-label") ?? ""}`.slice(
              0,
              256,
            ),
        };
        element.onEndTag(() => {
          if (activeAnchor?.elementToken !== token) return;
          const anchor = activeAnchor;
          activeAnchor = undefined;
          const url = resolvePublisherLink(anchor.href, baseUrl);
          if (url === null) return;
          const evidence = `${anchor.href} ${anchor.text.slice(0, 256)} ${anchor.title}`;
          if (isFeedLinkEvidence(evidence)) {
            addFeed({ discoveryMethod: "anchor", discoveryUrl: url, url });
          } else if (isLandingPageEvidence(evidence)) {
            addLandingPage(url);
          }
        });
      },
      text(text) {
        if (activeAnchor !== undefined && activeAnchor.text.length < 256) {
          activeAnchor.text += text.text.slice(
            0,
            256 - activeAnchor.text.length,
          );
        }
      },
    })
    .transform(
      new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

  // The input is already bounded by boundedFetch. Draining drives HTMLRewriter
  // without performing a second publisher read.
  await transformed.arrayBuffer();
  return { feeds, landingPages };
};
