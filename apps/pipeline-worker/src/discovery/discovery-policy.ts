export const DISCOVERY_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DISCOVERY_MAX_CANDIDATES = 10;
export const DISCOVERY_MAX_LANDING_PAGES = 3;
export const DISCOVERY_MAX_REDIRECTS = 5;
export const DISCOVERY_REQUEST_TIMEOUT_MS = 20_000;

export const CONVENTIONAL_FEED_PATHS = [
  "/feed",
  "/rss",
  "/rss.xml",
  "/feed.xml",
  "/atom.xml",
] as const;

export const FEED_MEDIA_TYPES = new Set([
  "application/atom+xml",
  "application/feed+json",
  "application/json",
  "application/rss+xml",
  "application/xml",
  "text/xml",
]);
