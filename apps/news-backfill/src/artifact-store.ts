import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface ArtifactStore {
  archive(
    publisherKey: string,
    body: string,
    contentType: string,
  ): Promise<string>;
}

export interface R2ArtifactStoreConfig {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  secretAccessKey: string;
}

function artifactKey(body: string): { key: string; sha256: string } {
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    key: path.posix.join("news-backfill", "objects", sha256),
    sha256,
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const metadata = Reflect.get(error, "$metadata");
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    Reflect.get(metadata, "httpStatusCode") === 404
  );
}

export class DryRunArtifactStore implements ArtifactStore {
  public async archive(
    _publisherKey: string,
    body: string,
    contentType: string,
  ): Promise<string> {
    void contentType;
    return artifactKey(body).key;
  }
}

export class LocalArtifactStore implements ArtifactStore {
  public constructor(private readonly rootDirectory: string) {}

  public async archive(
    _publisherKey: string,
    body: string,
    contentType: string,
  ): Promise<string> {
    void contentType;
    const { key: relativeKey } = artifactKey(body);
    const absolutePath = path.join(this.rootDirectory, relativeKey);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, body, { flag: "wx" }).catch(
      (error: unknown) => {
        if (
          typeof error !== "object" ||
          error === null ||
          Reflect.get(error, "code") !== "EEXIST"
        ) {
          throw error;
        }
      },
    );
    return relativeKey;
  }
}

export class R2ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;

  public constructor(private readonly config: R2ArtifactStoreConfig) {
    this.client = new S3Client({
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      endpoint: config.endpoint,
      forcePathStyle: true,
      region: "auto",
    });
  }

  public async archive(
    _publisherKey: string,
    body: string,
    contentType: string,
  ): Promise<string> {
    const { key, sha256 } = artifactKey(body);
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return key;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    await this.client.send(
      new PutObjectCommand({
        Body: body,
        Bucket: this.config.bucket,
        ContentLength: Buffer.byteLength(body),
        ContentType: contentType,
        Key: key,
        Metadata: { sha256 },
      }),
    );
    return key;
  }
}
