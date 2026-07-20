import {
  createDemoRepository,
  handleDemoRequest,
  type DemoRepository,
  type DemoRepositoryConfig,
} from "@dot-gov-news/demo-api";
import { z } from "zod";

import {
  createR2AssetStore,
  type DemoAssetStore,
  type R2AssetStoreConfig,
  r2AssetStoreConfig,
} from "../_r2";

type DemoRepositoryFactory = (config: DemoRepositoryConfig) => DemoRepository;
type DemoAssetStoreFactory = (config: R2AssetStoreConfig) => DemoAssetStore;

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
    status,
  });
}

function environmentConfig(
  env: NodeJS.ProcessEnv,
): DemoRepositoryConfig | null {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const supabaseKey = (
    env.SUPABASE_DEMO_KEY ?? env.SUPABASE_SECRET_KEY
  )?.trim();
  if (
    supabaseUrl === undefined ||
    supabaseUrl === "" ||
    supabaseKey === undefined ||
    supabaseKey === ""
  ) {
    return null;
  }
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { supabaseKey, supabaseUrl };
}

function eventCardAssetId(pathname: string): string | null | undefined {
  const match = /^\/api\/lab\/assets\/event-cards\/([^/]+)\/card$/u.exec(
    pathname,
  );
  if (match?.[1] === undefined) return undefined;
  const id = z.uuid().safeParse(match[1]);
  return id.success ? id.data : null;
}

function withoutVercelRouteMetadata(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.delete("path");
  return new Request(url, request);
}

async function eventCardAssetResponse(
  request: Request,
  repository: DemoRepository,
  store: DemoAssetStore,
  eventCardId: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json(405, {
      error: {
        code: "method_not_allowed",
        message: "Only GET and HEAD are supported.",
      },
    });
  }
  try {
    const asset = await repository.getCardThumbnailAsset(eventCardId);
    if (asset === null) {
      return json(404, {
        error: { code: "not_found", message: "Unknown event-card asset." },
      });
    }
    const object = await store.get(asset.key);
    if (object === null) {
      return json(404, {
        error: { code: "not_found", message: "Unknown event-card asset." },
      });
    }
    const headers = new Headers({
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": asset.mimeType,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    if (object.etag !== null) headers.set("etag", object.etag);
    if (object.size !== null)
      headers.set("content-length", String(object.size));
    if (
      object.etag !== null &&
      request.headers.get("if-none-match") === object.etag
    ) {
      return new Response(null, { headers, status: 304 });
    }
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers,
    });
  } catch {
    return json(503, {
      error: {
        code: "provider_unavailable",
        message: "The event-card asset provider is unavailable.",
        retryable: true,
      },
    });
  }
}

export function createVercelDemoHandler(
  env: NodeJS.ProcessEnv,
  repositoryFactory: DemoRepositoryFactory = createDemoRepository,
  assetStoreFactory: DemoAssetStoreFactory = createR2AssetStore,
): (request: Request) => Promise<Response> {
  let repository: DemoRepository | undefined;
  let assetStore: DemoAssetStore | undefined;
  return async (request: Request): Promise<Response> => {
    const config = environmentConfig(env);
    if (config === null) {
      return json(503, {
        error: {
          code: "api_not_configured",
          message: "SUPABASE_URL and SUPABASE_DEMO_KEY are not configured.",
          retryable: false,
        },
        meta: { generatedAt: new Date().toISOString() },
      });
    }
    repository ??= repositoryFactory(config);
    const assetId = eventCardAssetId(new URL(request.url).pathname);
    if (assetId === null) {
      return json(400, {
        error: {
          code: "invalid_event_card_id",
          message: "Event card ID is invalid.",
        },
      });
    }
    if (assetId !== undefined) {
      const r2Config = r2AssetStoreConfig(env);
      if (r2Config === null) {
        return json(503, {
          error: {
            code: "asset_store_not_configured",
            message: "The event-card asset store is not configured.",
          },
        });
      }
      assetStore ??= assetStoreFactory(r2Config);
      return eventCardAssetResponse(request, repository, assetStore, assetId);
    }
    return handleDemoRequest(withoutVercelRouteMetadata(request), {
      repository,
    });
  };
}

export default { fetch: createVercelDemoHandler(process.env) };
