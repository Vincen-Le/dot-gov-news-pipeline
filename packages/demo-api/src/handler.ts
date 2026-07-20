import { z } from "zod";

import type { DemoRepository } from "./repository.js";

const responseHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

const StorylinesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(5000).default(500),
    sort: z.enum(["rank"]).optional(),
  })
  .strict();

const RankRowsQuerySchema = z
  .object({
    agency: z.string().trim().min(1).max(128).optional(),
    category: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    theme: z.uuid().optional(),
  })
  .strict();

class DemoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DemoHttpError";
  }
}

export type DemoMetadataFactory = (generatedAt: string) => unknown;

export interface DemoHandlerOptions {
  metadata?: DemoMetadataFactory;
  repository: DemoRepository;
}

function defaultMetadata(generatedAt: string): unknown {
  return {
    environment: "demo",
    generatedAt,
    sources: [{ name: "supabase", observedAt: generatedAt, state: "fresh" }],
    warnings: [],
  };
}

function responseBody(request: Request, body: unknown, status = 200): Response {
  if (request.method === "HEAD") {
    return new Response(null, { headers: responseHeaders, status });
  }
  return Response.json(body, { headers: responseHeaders, status });
}

function errorResponse(request: Request, error: unknown): Response {
  const safe =
    error instanceof DemoHttpError
      ? error
      : new DemoHttpError(
          503,
          "provider_unavailable",
          "A required provider is unavailable",
          true,
        );
  return responseBody(
    request,
    {
      error: {
        code: safe.code,
        message: safe.message,
        retryable: safe.retryable,
      },
      meta: { generatedAt: new Date().toISOString() },
    },
    safe.status,
  );
}

function parseQuery<T>(schema: z.ZodType<T>, url: URL): T {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key)) {
      throw new DemoHttpError(
        400,
        "invalid_query",
        "Duplicate query parameter",
      );
    }
    values[key] = value;
  }
  const result = schema.safeParse(values);
  if (!result.success) {
    throw new DemoHttpError(
      400,
      "invalid_query",
      "Query parameters are invalid",
    );
  }
  return result.data;
}

async function routeDemoRequest(
  request: Request,
  options: DemoHandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const generatedAt = new Date().toISOString();
  const meta = (options.metadata ?? defaultMetadata)(generatedAt);

  if (pathname === "/api/lab/storylines") {
    const query = parseQuery(StorylinesQuerySchema, url);
    const data = await options.repository.listStorylines(query.limit);
    return responseBody(request, {
      data: {
        ...data,
        items: data.items.filter((item) => item.unreviewedEntryCount === 0),
      },
      meta,
    });
  }

  const storylineMatch = /^\/api\/lab\/storylines\/([^/]+)$/u.exec(pathname);
  if (storylineMatch?.[1] !== undefined) {
    const id = z.uuid().safeParse(storylineMatch[1]);
    if (!id.success) {
      throw new DemoHttpError(
        400,
        "invalid_storyline_id",
        "Storyline ID is invalid",
      );
    }
    const data = await options.repository.getStoryline(id.data);
    if (data === null || data.unreviewedEntryCount !== 0) {
      throw new DemoHttpError(404, "not_found", "Unknown storyline");
    }
    return responseBody(request, { data, meta });
  }

  if (pathname === "/api/lab/agencies") {
    return responseBody(request, {
      data: { agencies: await options.repository.listAgencies() },
      meta,
    });
  }

  if (pathname === "/api/lab/topics/categories") {
    return responseBody(request, {
      data: { categories: await options.repository.listCategories() },
      meta,
    });
  }

  if (pathname === "/api/lab/topics/themes") {
    return responseBody(request, {
      data: { themes: await options.repository.listThemes() },
      meta,
    });
  }

  if (pathname === "/api/lab/rank/golden") {
    const data = await options.repository.getRankOverview();
    if (data === null) {
      throw new DemoHttpError(
        404,
        "not_found",
        "No canonical reviewed golden ranking is available",
      );
    }
    return responseBody(request, { data, meta });
  }

  if (pathname === "/api/lab/rank/golden/filtered-snapshot") {
    const query = parseQuery(RankRowsQuerySchema, url);
    return responseBody(request, {
      data: { rows: await options.repository.listRankRows(query) },
      meta,
    });
  }

  throw new DemoHttpError(404, "not_found", "Route was not found");
}

export async function handleDemoRequest(
  request: Request,
  options: DemoHandlerOptions,
): Promise<Response> {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new DemoHttpError(
        405,
        "method_not_allowed",
        "Only GET and HEAD are supported",
      );
    }
    return await routeDemoRequest(request, options);
  } catch (error) {
    return errorResponse(request, error);
  }
}
