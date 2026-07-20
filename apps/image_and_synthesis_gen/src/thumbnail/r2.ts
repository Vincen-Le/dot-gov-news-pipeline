import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { requiredEnvironment } from "../shared/database.js";
import { type PreparedImage } from "./images.js";

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const metadata = Reflect.get(error, "$metadata");
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    Reflect.get(metadata, "httpStatusCode") === 404
  );
}

function endpoint(): string {
  const configured = process.env.R2_S3_API_ENDPOINT?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return `https://${requiredEnvironment("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
}

export class R2ImageStore {
  private readonly bucket = requiredEnvironment("R2_BUCKET_NAME");
  private readonly client = new S3Client({
    credentials: {
      accessKeyId: requiredEnvironment("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment("R2_SECRET_ACCESS_KEY"),
    },
    endpoint: endpoint(),
    forcePathStyle: true,
    region: "auto",
  });

  private async head(image: PreparedImage): Promise<boolean> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: image.key }),
      );
      if (
        result.ContentLength !== image.bytes.byteLength ||
        result.Metadata?.sha256 !== image.sha256
      ) {
        throw new Error(`R2 HEAD verification failed for ${image.key}`);
      }
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  public async uploadAndVerify(image: PreparedImage): Promise<void> {
    if (!(await this.head(image))) {
      await this.client.send(
        new PutObjectCommand({
          Body: image.bytes,
          Bucket: this.bucket,
          ContentLength: image.bytes.byteLength,
          ContentType: image.mediaType,
          Key: image.key,
          Metadata: {
            sha256: image.sha256,
            variant: image.variant,
          },
        }),
      );
      if (!(await this.head(image))) {
        throw new Error(`R2 object disappeared after upload: ${image.key}`);
      }
    }
  }
}
