import { load } from "cheerio";

import {
  extractHttpFeedLinks,
  isFeedLinkEvidence,
  isLandingPageEvidence,
  normalizeMediaType,
  resolvePublisherLink,
  type ExtractedFeedLink,
  type FeedLinkExtractor,
} from "../../apps/pipeline-worker/src/discovery/extract-feed-links";
import {
  DISCOVERY_MAX_CANDIDATES,
  DISCOVERY_MAX_LANDING_PAGES,
  FEED_MEDIA_TYPES,
} from "../../apps/pipeline-worker/src/discovery/discovery-policy";

export const extractFeedLinksNode: FeedLinkExtractor = async (
  body,
  baseUrl,
  linkHeader,
) => {
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

  const $ = load(new TextDecoder().decode(body));
  $("link[href]").each((_index, element) => {
    const href = $(element).attr("href");
    const relationships = ($(element).attr("rel") ?? "")
      .toLowerCase()
      .split(/\s+/);
    const type = normalizeMediaType($(element).attr("type") ?? null);
    if (
      href === undefined ||
      href.length > 2_048 ||
      !relationships.includes("alternate") ||
      !FEED_MEDIA_TYPES.has(type)
    ) {
      return;
    }
    const url = resolvePublisherLink(href, baseUrl);
    if (url !== null) {
      addFeed({ discoveryMethod: "html_alternate", discoveryUrl: url, url });
    }
  });

  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (href === undefined || href.length > 2_048) return;
    const url = resolvePublisherLink(href, baseUrl);
    if (url === null) return;
    const evidence = `${href} ${$(element).text().slice(0, 256)} ${(
      ($(element).attr("title") ?? "") +
      " " +
      ($(element).attr("aria-label") ?? "")
    ).slice(0, 256)}`;
    if (isFeedLinkEvidence(evidence)) {
      addFeed({ discoveryMethod: "anchor", discoveryUrl: url, url });
    } else if (isLandingPageEvidence(evidence)) {
      addLandingPage(url);
    }
  });

  return { feeds, landingPages };
};
