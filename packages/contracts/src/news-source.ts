import { z } from "zod";

export const NEWS_SOURCE_TYPES = [
  "rss",
  "atom",
  "json_feed",
  "publisher_api",
  "html_archive",
  "sitemap",
] as const;

export const NewsSourceTypeSchema = z.enum(NEWS_SOURCE_TYPES);

export const NEWS_SOURCE_DISCOVERY_METHODS = [
  "http_link",
  "html_alternate",
  "anchor",
  "conventional_path",
  "root_document",
  "api_documentation",
  "html_archive",
  "sitemap",
  "manual",
] as const;

export const NewsSourceDiscoveryMethodSchema = z.enum(
  NEWS_SOURCE_DISCOVERY_METHODS,
);

const HttpUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .url()
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
  );

export const DiscoveredNewsSourceSchema = z
  .object({
    canonical_url: HttpUrlSchema,
    source_type: NewsSourceTypeSchema,
    title: z.string().max(512).nullable().optional(),
    home_page_url: HttpUrlSchema.nullable().optional(),
    http_status: z.number().int().min(100).max(599).nullable().optional(),
    discovery_method: NewsSourceDiscoveryMethodSchema,
    discovery_url: HttpUrlSchema,
    adapter_config: z.record(z.string(), z.unknown()).optional(),
    backfill_supported: z.boolean().optional(),
    earliest_available_at: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional(),
    latest_observed_at: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (source) =>
      source.earliest_available_at === null ||
      source.earliest_available_at === undefined ||
      source.latest_observed_at === null ||
      source.latest_observed_at === undefined ||
      Date.parse(source.earliest_available_at) <=
        Date.parse(source.latest_observed_at),
    { message: "news-source observation window is invalid" },
  );

export const CompleteNewsSourceDiscoverySchema = z
  .object({
    p_site_id: z.string().uuid(),
    p_lease_token: z.string().uuid(),
    p_result: z.enum(["succeeded", "no_news_source"]),
    p_site_health: z
      .object({
        checked_source_types: z
          .array(NewsSourceTypeSchema)
          .max(NEWS_SOURCE_TYPES.length)
          .optional(),
        final_url: HttpUrlSchema.optional(),
        http_status: z.number().int().min(100).max(599).optional(),
        duration_ms: z.number().int().min(0).max(3_600_000).optional(),
      })
      .strict(),
    p_sources: z.array(DiscoveredNewsSourceSchema).max(10),
    p_policy_version: z.number().int().positive(),
  })
  .strict()
  .superRefine((completion, context) => {
    const hasSources = completion.p_sources.length > 0;
    if (
      (completion.p_result === "succeeded" && !hasSources) ||
      (completion.p_result === "no_news_source" && hasSources)
    ) {
      context.addIssue({
        code: "custom",
        message: "discovery result and news-source count are inconsistent",
        path: ["p_sources"],
      });
    }

    if (
      new Set(completion.p_sources.map((source) => source.canonical_url))
        .size !== completion.p_sources.length
    ) {
      context.addIssue({
        code: "custom",
        message: "canonical news-source URLs must be unique",
        path: ["p_sources"],
      });
    }

    if (completion.p_result === "no_news_source") {
      const checkedSourceTypes = new Set(
        completion.p_site_health.checked_source_types ?? [],
      );
      if (
        NEWS_SOURCE_TYPES.some(
          (sourceType) => !checkedSourceTypes.has(sourceType),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "no-news-source completion requires every adapter check",
          path: ["p_site_health", "checked_source_types"],
        });
      }
    }
  });

export type CompleteNewsSourceDiscovery = z.infer<
  typeof CompleteNewsSourceDiscoverySchema
>;
export type DiscoveredNewsSource = z.infer<typeof DiscoveredNewsSourceSchema>;
export type NewsSourceType = z.infer<typeof NewsSourceTypeSchema>;
