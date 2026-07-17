import { createReadStream } from "node:fs";

import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface InventorySnapshotStore {
  archive(input: {
    bytes: number;
    filePath: string;
    sha256: string;
  }): Promise<string>;
}

export interface R2SnapshotStoreConfig {
  accessKeyId: string;
  accountId: string;
  bucket: string;
  secretAccessKey: string;
}

function artifactKey(sha256: string): string {
  return `inventory/gsa/${sha256}.csv`;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const metadata = Reflect.get(error, "$metadata");
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    Reflect.get(metadata, "httpStatusCode") === 404
  );
}

export function createR2SnapshotStore(
  config: R2SnapshotStoreConfig,
): InventorySnapshotStore {
  const client = new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    region: "auto",
  });

  return {
    async archive(input) {
      const key = artifactKey(input.sha256);

      try {
        await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        return key;
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }

      await client.send(
        new PutObjectCommand({
          Body: createReadStream(input.filePath),
          Bucket: config.bucket,
          ContentLength: input.bytes,
          ContentType: "text/csv",
          Key: key,
          Metadata: {
            sha256: input.sha256,
            source: "gsa-federal-website-index",
          },
        }),
      );

      return key;
    },
  };
}
