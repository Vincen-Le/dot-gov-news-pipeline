// @vitest-environment node

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface VercelConfig {
  rewrites?: Array<{ destination: string; source: string }>;
}

async function vercelConfig(): Promise<VercelConfig> {
  return JSON.parse(
    await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ) as VercelConfig;
}

describe("the Vercel deployment routes", () => {
  it("serves SPA paths without rewriting API requests to index.html", async () => {
    const config = await vercelConfig();
    const spaRewrite = config.rewrites?.find(
      (rewrite) => rewrite.destination === "/index.html",
    );

    expect(spaRewrite).toBeDefined();
    const source = new RegExp(`^${spaRewrite?.source}$`, "u");
    expect(source.test("/storylines/example")).toBe(true);
    expect(source.test("/api/lab/storylines")).toBe(false);
  });

  it("routes nested API paths to the Vercel function", async () => {
    const config = await vercelConfig();
    const apiRewrite = config.rewrites?.find((rewrite) =>
      rewrite.destination.startsWith("/api/lab?"),
    );

    expect(apiRewrite).toBeDefined();
    const source = new RegExp(`^${apiRewrite?.source}$`, "u");
    expect(source.test("/api/lab/topics/categories")).toBe(true);
  });
});
