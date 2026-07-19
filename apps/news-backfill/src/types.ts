export type AdapterType =
  "syndication" | "wordpress" | "publisher_api" | "sitemap" | "html_archive";

export type NewsSubtype =
  "press_release" | "agency_news" | "advisory" | "release";

export interface SourceProfile {
  adapter: AdapterType;
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
  allowedHosts: string[];
  apiKeyEnvironment?: string;
  hydrate?: boolean;
  includeUrlPattern?: string;
  maxPages: number;
  newsSubtype: NewsSubtype;
  pageSize?: number;
  pageStart?: number;
  sourceKey: string;
  sourceType:
    "rss" | "atom" | "json_feed" | "publisher_api" | "html_archive" | "sitemap";
  sourceUrl: string;
  title: string;
  urlTemplate?: string;
}

export interface PublisherProfile {
  displayName: string;
  publisherKey: string;
  sources: SourceProfile[];
  trafficVisits: number;
}

export interface BackfillManifest {
  cohortId: string;
  publishers: PublisherProfile[];
  version: number;
  windowEnd: string;
  windowStart: string;
}

export interface Candidate {
  bodyText?: string | null;
  externalItemId: string | null;
  fetchUrl?: string;
  newsSubtype?: NewsSubtype;
  publishedAt: string | null;
  rawBody: string;
  rawContentType: string;
  sourceUrl: string;
  summary: string | null;
  title: string | null;
  url: string;
}

export interface CandidateBatch {
  candidates: Candidate[];
  coverageReachedAt: string | null;
  cursor: Record<string, unknown>;
  evidenceBody: string;
  evidenceContentType: string;
  evidenceUrl: string;
  stopReason?: string;
}

export interface NormalizedEntry {
  body_text: string | null;
  candidate_key: string;
  content_hash: string;
  external_item_id: string | null;
  extractor_version: number;
  fetched_at: string;
  news_subtype: NewsSubtype;
  published_at: string;
  raw_artifact_key: string;
  summary: string | null;
  title: string;
  url: string;
  url_canonical: string;
}

export interface TargetState {
  cursor: Record<string, unknown>;
  id: string;
  status: string;
}

export interface RunSummary {
  failed: number;
  partial: number;
  publishers: number;
  succeeded: number;
}
