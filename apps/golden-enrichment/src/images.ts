import path from "node:path";

import sharp from "sharp";

import { sha256 } from "./fingerprint.js";

export type ImageVariant = "card" | "master" | "social";

export interface PreparedImage {
  bytes: Buffer;
  height: number;
  key: string;
  mediaType: string;
  sha256: string;
  variant: ImageVariant;
  width: number;
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      throw new Error(`unsupported image media type: ${mediaType}`);
  }
}

export function objectKey(
  variant: ImageVariant,
  hash: string,
  mediaType: string,
): string {
  return path.posix.join(
    "golden-enrichment",
    "images",
    variant,
    "sha256",
    `${hash}.${extensionForMediaType(mediaType)}`,
  );
}

function cropBox(
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
  focalX: number,
  focalY: number,
): { height: number; left: number; top: number; width: number } {
  const targetRatio = targetWidth / targetHeight;
  const sourceRatio = width / height;
  let cropWidth = width;
  let cropHeight = height;
  if (sourceRatio > targetRatio) cropWidth = Math.round(height * targetRatio);
  else cropHeight = Math.round(width / targetRatio);
  const left = Math.max(
    0,
    Math.min(width - cropWidth, Math.round(focalX * width - cropWidth / 2)),
  );
  const top = Math.max(
    0,
    Math.min(height - cropHeight, Math.round(focalY * height - cropHeight / 2)),
  );
  return { height: cropHeight, left, top, width: cropWidth };
}

async function derivative(
  master: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  focalX: number,
  focalY: number,
  variant: "card" | "social",
): Promise<PreparedImage> {
  const bytes = await sharp(master)
    .extract(
      cropBox(
        sourceWidth,
        sourceHeight,
        targetWidth,
        targetHeight,
        focalX,
        focalY,
      ),
    )
    .resize(targetWidth, targetHeight, { fit: "fill" })
    .webp({ effort: 6, quality: 86 })
    .toBuffer();
  const hash = sha256(bytes);
  return {
    bytes,
    height: targetHeight,
    key: objectKey(variant, hash, "image/webp"),
    mediaType: "image/webp",
    sha256: hash,
    variant,
    width: targetWidth,
  };
}

export async function prepareImages(input: {
  focalX: number;
  focalY: number;
  master: Buffer;
  masterHeight: number;
  masterMediaType: string;
  masterSha256: string;
  masterWidth: number;
}): Promise<[PreparedImage, PreparedImage, PreparedImage]> {
  const master: PreparedImage = {
    bytes: input.master,
    height: input.masterHeight,
    key: objectKey("master", input.masterSha256, input.masterMediaType),
    mediaType: input.masterMediaType,
    sha256: input.masterSha256,
    variant: "master",
    width: input.masterWidth,
  };
  const [card, social] = await Promise.all([
    derivative(
      input.master,
      input.masterWidth,
      input.masterHeight,
      1200,
      480,
      input.focalX,
      input.focalY,
      "card",
    ),
    derivative(
      input.master,
      input.masterWidth,
      input.masterHeight,
      1200,
      630,
      input.focalX,
      input.focalY,
      "social",
    ),
  ]);
  return [master, card, social];
}
