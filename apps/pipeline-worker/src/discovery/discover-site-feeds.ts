import type {
  DiscoveredFeed,
  SiteDiscoveryHealth,
} from "../clients/site-discovery-repository";
import {
  boundedFetch,
  PublisherFetchError,
  type BoundedFetchResult,
  type PublisherFetcher,
} from "./bounded-fetch";
import { canonicalizeFeedUrl } from "./canonicalize-feed-url";
import { DiscoveryBudget, DiscoveryBudgetError } from "./discovery-budget";
import {
  DISCOVERY_MAX_BODY_BYTES,
  DISCOVERY_MAX_CANDIDATES,
  DISCOVERY_MAX_LANDING_PAGES,
  DISCOVERY_MAX_REDIRECTS,
  DISCOVERY_REQUEST_TIMEOUT_MS,
} from "./discovery-policy";
import { extractFeedLinks, extractHttpFeedLinks } from "./extract-feed-links";
import {
  conventionalFeedCandidates,
  deduplicateFeedCandidates,
  type FeedCandidate,
} from "./generate-feed-candidates";
import {
  UnsafeUrlError,
  isWithinBaseDomain,
  validatePublisherUrl,
} from "./url-safety";
import { validateFeed } from "./validate-feed";

export type SiteDiscoveryFailureCode =
  | "deadline_exceeded"
  | "publisher_http_4xx"
  | "publisher_http_429"
  | "publisher_http_5xx"
  | "publisher_network_error"
  | "publisher_response_too_large"
  | "publisher_timeout"
  | "request_budget_exhausted"
  | "unsafe_root_url";

export class SiteDiscoveryFailure extends Error {
  readonly code: SiteDiscoveryFailureCode;
  readonly durationMs: number;
  readonly peakResponseBytes: number;
  readonly requestCount: number;
  readonly retryAfterSeconds: number;

  constructor(
    code: SiteDiscoveryFailureCode,
    detail: string,
    retryAfterSeconds = 0,
    durationMs = 0,
    requestCount = 0,
    peakResponseBytes = 0,
  ) {
    super(detail.slice(0, 1_000));
    this.name = "SiteDiscoveryFailure";
    this.code = code;
    this.durationMs = durationMs;
    this.requestCount = requestCount;
    this.peakResponseBytes = peakResponseBytes;
    this.retryAfterSeconds = Math.max(0, Math.min(604_800, retryAfterSeconds));
  }
}

export interface DiscoverSiteFeedsOptions {
  baseDomain: string;
  fetcher?: PublisherFetcher;
  initialUrl: string;
  maxPublisherRequests: number;
  now?: () => number;
  siteDeadlineMs: number;
  userAgent: string;
}

export interface SiteDiscoveryResult {
  feeds: DiscoveredFeed[];
  health: SiteDiscoveryHealth;
  peakResponseBytes: number;
  requestCount: number;
  result: "no_feed" | "succeeded";
}

function contentType(response: BoundedFetchResult): string {
  return (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? ""
  );
}

function looksLikeHtml(response: BoundedFetchResult): boolean {
  if (contentType(response).includes("html")) return true;
  const prefix = new TextDecoder()
    .decode(response.body.slice(0, 512))
    .toLowerCase();
  return /<(?:!doctype\s+html|html|head|body)(?:\s|>)/.test(prefix);
}

function retryAfterSeconds(headers: Headers, now: number): number {
  const value = headers.get("retry-after")?.trim();
  if (value === undefined || value === "") return 0;
  if (/^\d{1,10}$/.test(value)) return Math.min(Number(value), 604_800);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return 0;
  return Math.max(0, Math.min(604_800, Math.ceil((date - now) / 1_000)));
}

function statusFailure(
  response: BoundedFetchResult,
  now: number,
): SiteDiscoveryFailure | null {
  if (response.status === 429) {
    return new SiteDiscoveryFailure(
      "publisher_http_429",
      "Publisher returned HTTP 429",
      retryAfterSeconds(response.headers, now),
    );
  }
  if (response.status >= 500) {
    return new SiteDiscoveryFailure(
      "publisher_http_5xx",
      "Publisher returned a server error",
      retryAfterSeconds(response.headers, now),
    );
  }
  if (response.status >= 400) {
    return new SiteDiscoveryFailure(
      "publisher_http_4xx",
      "Publisher returned a client error",
    );
  }
  return null;
}

function mapFetchFailure(error: unknown): SiteDiscoveryFailure {
  if (error instanceof SiteDiscoveryFailure) return error;
  if (error instanceof DiscoveryBudgetError) {
    return new SiteDiscoveryFailure(error.code, error.message);
  }
  if (error instanceof UnsafeUrlError) {
    return new SiteDiscoveryFailure(
      "unsafe_root_url",
      error.message,
      7 * 86_400,
    );
  }
  if (error instanceof PublisherFetchError) {
    if (error.code === "request_timeout") {
      return new SiteDiscoveryFailure("publisher_timeout", error.message);
    }
    if (error.code === "response_too_large") {
      return new SiteDiscoveryFailure(
        "publisher_response_too_large",
        error.message,
      );
    }
    return new SiteDiscoveryFailure("publisher_network_error", error.message);
  }
  return new SiteDiscoveryFailure(
    "publisher_network_error",
    "Unexpected publisher failure",
  );
}

function fetchOptions(
  budget: DiscoveryBudget,
  options: DiscoverSiteFeedsOptions,
  redirectAllowed?: (target: URL) => boolean,
): Parameters<typeof boundedFetch>[1] {
  return {
    budget,
    fetcher: options.fetcher,
    maxBytes: DISCOVERY_MAX_BODY_BYTES,
    maxRedirects: DISCOVERY_MAX_REDIRECTS,
    ...(redirectAllowed === undefined ? {} : { redirectAllowed }),
    timeoutMs: DISCOVERY_REQUEST_TIMEOUT_MS,
    userAgent: options.userAgent,
  };
}

async function fetchRoot(
  budget: DiscoveryBudget,
  options: DiscoverSiteFeedsOptions,
): Promise<BoundedFetchResult> {
  const httpsUrl = validatePublisherUrl(`https://${options.initialUrl}/`);
  const redirectAllowed = (target: URL) =>
    isWithinBaseDomain(target.hostname, options.baseDomain);
  try {
    return await boundedFetch(
      httpsUrl,
      fetchOptions(budget, options, redirectAllowed),
    );
  } catch (error) {
    if (
      !(error instanceof PublisherFetchError) ||
      error.code !== "network_error"
    )
      throw error;
    const httpUrl = validatePublisherUrl(httpsUrl);
    httpUrl.protocol = "http:";
    return boundedFetch(
      httpUrl,
      fetchOptions(budget, options, redirectAllowed),
    );
  }
}

function safeHomePageUrl(value: string | null, baseUrl: URL): string | null {
  if (value === null) return null;
  try {
    return validatePublisherUrl(value, baseUrl).href;
  } catch (error) {
    if (error instanceof UnsafeUrlError) return null;
    throw error;
  }
}

function acceptedFeed(
  candidate: FeedCandidate,
  response: BoundedFetchResult,
): DiscoveredFeed | null {
  const validated = validateFeed(response.body);
  if (validated === null) return null;
  return {
    canonicalUrl: canonicalizeFeedUrl(response.finalUrl),
    discoveryMethod: candidate.discoveryMethod,
    discoveryUrl: candidate.discoveryUrl,
    feedType: validated.feedType,
    homePageUrl: safeHomePageUrl(validated.homePageUrl, response.finalUrl),
    httpStatus: response.status,
    title: validated.title,
  };
}

export async function discoverSiteFeeds(
  options: DiscoverSiteFeedsOptions,
): Promise<SiteDiscoveryResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const budget = new DiscoveryBudget(
    options.maxPublisherRequests,
    options.siteDeadlineMs,
    now,
  );

  try {
    const root = await fetchRoot(budget, options);
    const rootFailure = statusFailure(root, now());
    if (rootFailure !== null) throw rootFailure;

    const rootValidated = validateFeed(root.body);
    if (rootValidated !== null) {
      return {
        feeds: [
          {
            canonicalUrl: canonicalizeFeedUrl(root.finalUrl),
            discoveryMethod: "root_document",
            discoveryUrl: root.finalUrl.href,
            feedType: rootValidated.feedType,
            homePageUrl: safeHomePageUrl(
              rootValidated.homePageUrl,
              root.finalUrl,
            ),
            httpStatus: root.status,
            title: rootValidated.title,
          },
        ],
        health: {
          durationMs: Math.max(0, now() - startedAt),
          finalUrl: root.finalUrl.href,
          httpStatus: root.status,
        },
        peakResponseBytes: budget.peakResponseBytes,
        requestCount: budget.requestCount,
        result: "succeeded",
      };
    }

    const rootLinks = looksLikeHtml(root)
      ? await extractFeedLinks(
          root.body,
          root.finalUrl,
          root.headers.get("link"),
        )
      : {
          feeds: extractHttpFeedLinks(root.headers.get("link"), root.finalUrl),
          landingPages: [],
        };
    const extractedCandidates: FeedCandidate[] = [...rootLinks.feeds];
    const landingPages = [...new Set(rootLinks.landingPages)]
      .filter((url) =>
        isWithinBaseDomain(new URL(url).hostname, options.baseDomain),
      )
      .slice(0, DISCOVERY_MAX_LANDING_PAGES);

    for (const landingPage of landingPages) {
      let landing: BoundedFetchResult;
      try {
        landing = await boundedFetch(
          landingPage,
          fetchOptions(budget, options, (target) =>
            isWithinBaseDomain(target.hostname, options.baseDomain),
          ),
        );
      } catch (error) {
        if (error instanceof UnsafeUrlError) continue;
        throw error;
      }
      if (!isWithinBaseDomain(landing.finalUrl.hostname, options.baseDomain))
        continue;
      const landingFailure = statusFailure(landing, now());
      if (landingFailure?.code === "publisher_http_4xx") continue;
      if (landingFailure !== null) throw landingFailure;
      if (!looksLikeHtml(landing)) continue;
      const links = await extractFeedLinks(
        landing.body,
        landing.finalUrl,
        landing.headers.get("link"),
      );
      extractedCandidates.push(...links.feeds);
    }

    const conventionalBase = isWithinBaseDomain(
      root.finalUrl.hostname,
      options.baseDomain,
    )
      ? root.finalUrl
      : validatePublisherUrl(`https://${options.initialUrl}/`);
    const candidates = deduplicateFeedCandidates(
      [...extractedCandidates, ...conventionalFeedCandidates(conventionalBase)],
      DISCOVERY_MAX_CANDIDATES,
    );
    const feeds = new Map<string, DiscoveredFeed>();

    for (const candidate of candidates) {
      if (
        candidate.discoveryMethod === "conventional_path" &&
        !isWithinBaseDomain(
          validatePublisherUrl(candidate.url).hostname,
          options.baseDomain,
        )
      ) {
        continue;
      }
      let response: BoundedFetchResult;
      try {
        response = await boundedFetch(
          candidate.url,
          fetchOptions(
            budget,
            options,
            candidate.discoveryMethod === "conventional_path"
              ? (target) =>
                  isWithinBaseDomain(target.hostname, options.baseDomain)
              : undefined,
          ),
        );
      } catch (error) {
        if (error instanceof UnsafeUrlError) continue;
        if (
          error instanceof PublisherFetchError &&
          error.code === "response_too_large"
        )
          continue;
        throw error;
      }
      if (
        candidate.discoveryMethod === "conventional_path" &&
        !isWithinBaseDomain(response.finalUrl.hostname, options.baseDomain)
      ) {
        continue;
      }
      const failure = statusFailure(response, now());
      if (failure?.code === "publisher_http_4xx") continue;
      if (failure !== null) throw failure;
      const feed = acceptedFeed(candidate, response);
      if (feed !== null && !feeds.has(feed.canonicalUrl))
        feeds.set(feed.canonicalUrl, feed);
    }

    return {
      feeds: [...feeds.values()],
      health: {
        durationMs: Math.max(0, now() - startedAt),
        finalUrl: root.finalUrl.href,
        httpStatus: root.status,
      },
      peakResponseBytes: budget.peakResponseBytes,
      requestCount: budget.requestCount,
      result: feeds.size > 0 ? "succeeded" : "no_feed",
    };
  } catch (error) {
    const failure = mapFetchFailure(error);
    throw new SiteDiscoveryFailure(
      failure.code,
      failure.message,
      failure.retryAfterSeconds,
      Math.max(0, now() - startedAt),
      budget.requestCount,
      budget.peakResponseBytes,
    );
  }
}
