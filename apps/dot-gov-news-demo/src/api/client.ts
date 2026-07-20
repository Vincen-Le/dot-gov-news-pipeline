import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

import {
  AgencyOptionSchema,
  CategorySchema,
  RankDatasetSchema,
  RankRowSchema,
  StorylineDetailSchema,
  StorylineListItemSchema,
  ThemeSchema,
  type RankRow,
} from "./contracts";

const configuredBase = import.meta.env.VITE_DOT_GOV_API_BASE_URL?.trim();
const apiBase = (
  configuredBase === "" || configuredBase === undefined
    ? "/api/lab"
    : configuredBase
).replace(/\/$/, "");

const ErrorEnvelopeSchema = z.object({
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .optional(),
});

export class DotGovApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DotGovApiError";
    this.code = code;
    this.status = status;
  }
}

async function get<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { accept: "application/json" },
    signal,
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = ErrorEnvelopeSchema.safeParse(body);
    throw new DotGovApiError(
      response.status,
      error.success ? (error.data.error?.code ?? "api_error") : "api_error",
      error.success
        ? (error.data.error?.message ?? `Request failed (${response.status})`)
        : `Request failed (${response.status})`,
    );
  }
  return z.object({ data: schema }).parse(body).data;
}

export const dotGovApi = {
  agencies: (signal?: AbortSignal) =>
    get(
      "/agencies",
      z.object({ agencies: AgencyOptionSchema.array() }),
      signal,
    ),
  categories: (signal?: AbortSignal) =>
    get(
      "/topics/categories",
      z.object({ categories: CategorySchema.array() }),
      signal,
    ),
  rankOverview: (signal?: AbortSignal) =>
    get(
      "/rank/golden",
      z.object({
        dataset: RankDatasetSchema,
        filters: z.object({
          agencies: AgencyOptionSchema.array(),
          categories: CategorySchema.array(),
          themes: ThemeSchema.array(),
        }),
      }),
      signal,
    ),
  rankRows: (
    filter: { agency?: string; category?: string; theme?: string },
    signal?: AbortSignal,
  ): Promise<{ rows: RankRow[] }> => {
    const params = new URLSearchParams({ limit: "100" });
    if (filter.agency !== undefined) params.set("agency", filter.agency);
    if (filter.category !== undefined) params.set("category", filter.category);
    if (filter.theme !== undefined) params.set("theme", filter.theme);
    return get(
      `/rank/golden/filtered-snapshot?${params.toString()}`,
      z.object({ rows: RankRowSchema.array() }),
      signal,
    );
  },
  storyline: (id: string, signal?: AbortSignal) =>
    get(`/storylines/${encodeURIComponent(id)}`, StorylineDetailSchema, signal),
  storylines: (signal?: AbortSignal) =>
    get(
      "/storylines?limit=500&sort=rank",
      z.object({
        hasMore: z.boolean(),
        items: StorylineListItemSchema.array(),
      }),
      signal,
    ),
  themes: (signal?: AbortSignal) =>
    get("/topics/themes", z.object({ themes: ThemeSchema.array() }), signal),
};

export function storylineDetailQuery(id: string) {
  return queryOptions({
    queryFn: ({ signal }) => dotGovApi.storyline(id, signal),
    queryKey: ["storyline", id] as const,
    staleTime: Infinity,
  });
}
