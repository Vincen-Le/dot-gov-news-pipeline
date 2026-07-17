import type { DiscoveryMethod } from "../clients/site-discovery-repository";
import { canonicalizeFeedUrl } from "./canonicalize-feed-url";
import {
  CONVENTIONAL_FEED_PATHS,
  DISCOVERY_MAX_CANDIDATES,
} from "./discovery-policy";
import type { ExtractedFeedLink } from "./extract-feed-links";
import { UnsafeUrlError, validatePublisherUrl } from "./url-safety";

export interface FeedCandidate {
  discoveryMethod: DiscoveryMethod;
  discoveryUrl: string;
  url: string;
}

export function deduplicateFeedCandidates(
  candidates: Iterable<ExtractedFeedLink | FeedCandidate>,
  maximum = DISCOVERY_MAX_CANDIDATES,
): FeedCandidate[] {
  const unique = new Map<string, FeedCandidate>();
  for (const candidate of candidates) {
    if (unique.size >= maximum) break;
    try {
      const canonical = canonicalizeFeedUrl(candidate.url);
      if (!unique.has(canonical))
        unique.set(canonical, { ...candidate, url: canonical });
    } catch (error) {
      if (!(error instanceof UnsafeUrlError)) throw error;
    }
  }
  return [...unique.values()];
}

export function conventionalFeedCandidates(officialUrl: URL): FeedCandidate[] {
  return CONVENTIONAL_FEED_PATHS.map((path) => {
    const url = validatePublisherUrl(path, officialUrl).href;
    return {
      discoveryMethod: "conventional_path" as const,
      discoveryUrl: url,
      url,
    };
  });
}
