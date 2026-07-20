import { z } from "zod";

import {
  AgencyOptionSchema,
  BootstrapSchema,
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

const RevisionSchema = z.object({ revision: z.string().regex(/^\d+$/u) });
let pendingRevision: Promise<string> | undefined;

async function currentRevision(): Promise<string> {
  const lookup =
    pendingRevision ??
    get("/revision", RevisionSchema).then(({ revision }) => revision);
  pendingRevision = lookup;
  try {
    return await lookup;
  } finally {
    if (pendingRevision === lookup) pendingRevision = undefined;
  }
}

async function versionedGet<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  let staleError: DotGovApiError | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revision = await currentRevision();
    const separator = path.includes("?") ? "&" : "?";
    const versionedPath = `${path}${separator}revision=${encodeURIComponent(revision)}`;
    try {
      return await get(versionedPath, schema, signal);
    } catch (error) {
      if (
        !(error instanceof DotGovApiError) ||
        error.code !== "stale_revision"
      ) {
        throw error;
      }
      staleError = error;
    }
  }
  throw staleError;
}

export const dotGovApi = {
  bootstrap: (signal?: AbortSignal) =>
    versionedGet("/bootstrap?limit=500&sort=rank", BootstrapSchema, signal),
  agencies: (signal?: AbortSignal) =>
    versionedGet(
      "/agencies",
      z.object({ agencies: AgencyOptionSchema.array() }),
      signal,
    ),
  categories: (signal?: AbortSignal) =>
    versionedGet(
      "/topics/categories",
      z.object({ categories: CategorySchema.array() }),
      signal,
    ),
  rankOverview: (signal?: AbortSignal) =>
    versionedGet(
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
    return versionedGet(
      `/rank/golden/filtered-snapshot?${params.toString()}`,
      z.object({ rows: RankRowSchema.array() }),
      signal,
    );
  },
  storyline: (id: string, signal?: AbortSignal) =>
    versionedGet(
      `/storylines/${encodeURIComponent(id)}`,
      StorylineDetailSchema,
      signal,
    ),
  storylines: (signal?: AbortSignal) =>
    versionedGet(
      "/storylines?limit=500&sort=rank",
      z.object({
        hasMore: z.boolean(),
        items: StorylineListItemSchema.array(),
      }),
      signal,
    ),
  themes: (signal?: AbortSignal) =>
    versionedGet(
      "/topics/themes",
      z.object({ themes: ThemeSchema.array() }),
      signal,
    ),
};
