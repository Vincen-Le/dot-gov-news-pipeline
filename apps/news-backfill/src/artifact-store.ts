import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function extensionFor(contentType: string): string {
  if (contentType.includes("json")) return "json";
  if (contentType.includes("xml") || contentType.includes("rss")) return "xml";
  if (contentType.includes("html")) return "html";
  return "txt";
}

export class ArtifactStore {
  public constructor(
    private readonly rootDirectory: string,
    private readonly runKey: string,
  ) {}

  public async archive(
    publisherKey: string,
    body: string,
    contentType: string,
  ): Promise<string> {
    const sha256 = createHash("sha256").update(body).digest("hex");
    const relativeKey = path.posix.join(
      "news-backfill",
      this.runKey,
      publisherKey,
      `${sha256}.${extensionFor(contentType)}`,
    );
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
