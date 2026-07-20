import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface DemoAssetObject {
  body: ReadableStream<Uint8Array>;
  etag: string | null;
  size: number | null;
}

export interface DemoAssetStore {
  get(key: string): Promise<DemoAssetObject | null>;
}

export interface R2AssetStoreConfig {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  secretAccessKey: string;
}

function value(env: NodeJS.ProcessEnv, name: string): string | null {
  const configured = env[name]?.trim();
  return configured === undefined || configured === "" ? null : configured;
}

export function r2AssetStoreConfig(
  env: NodeJS.ProcessEnv,
): R2AssetStoreConfig | null {
  const accessKeyId = value(env, "R2_ACCESS_KEY_ID");
  const bucket = value(env, "R2_BUCKET_NAME");
  const secretAccessKey = value(env, "R2_SECRET_ACCESS_KEY");
  const configuredEndpoint = value(env, "R2_S3_API_ENDPOINT");
  const accountId = value(env, "CLOUDFLARE_ACCOUNT_ID");
  const endpoint =
    configuredEndpoint ??
    (accountId === null
      ? null
      : `https://${accountId}.r2.cloudflarestorage.com`);
  if (
    accessKeyId === null ||
    bucket === null ||
    endpoint === null ||
    secretAccessKey === null
  ) {
    return null;
  }
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { accessKeyId, bucket, endpoint, secretAccessKey };
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    $metadata?: { httpStatusCode?: number };
    name?: string;
  };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export function createR2AssetStore(config: R2AssetStoreConfig): DemoAssetStore {
  const client = new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
    forcePathStyle: true,
    region: "auto",
  });
  return {
    async get(key: string): Promise<DemoAssetObject | null> {
      try {
        const object = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        if (object.Body === undefined) return null;
        return {
          body: object.Body.transformToWebStream(),
          etag: object.ETag ?? null,
          size: object.ContentLength ?? null,
        };
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw error;
      }
    },
  };
}
