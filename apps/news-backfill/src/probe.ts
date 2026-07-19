export type ProbeKind = "wordpress" | "drupal" | "news_sitemap" | "robots";

export interface ProbeCheck {
  kind: ProbeKind;
  url: string;
}

export interface ProbeResult {
  detail: string;
  verdict: "available" | "unavailable" | "error";
}

const PUBLISHER_ORIGINS: Record<string, string[]> = {
  bls: ["https://www.bls.gov"],
  cdc: ["https://www.cdc.gov"],
  doj: ["https://www.justice.gov"],
  fda: ["https://www.fda.gov"],
  fsa: ["https://fsapartners.ed.gov"],
  irs: ["https://www.irs.gov"],
  nasa: ["https://www.nasa.gov"],
  ncbi: ["https://ncbiinsights.ncbi.nlm.nih.gov"],
  noaa: ["https://www.noaa.gov"],
  nps: ["https://www.nps.gov"],
  nws: ["https://www.weather.gov"],
  sec: ["https://www.sec.gov"],
  ssa: ["https://www.ssa.gov", "https://blog.ssa.gov"],
  state: ["https://www.state.gov"],
  treasury: ["https://home.treasury.gov"],
  uscis: ["https://www.uscis.gov"],
  usda: ["https://www.usda.gov"],
  usgs: ["https://www.usgs.gov"],
  usps: ["https://about.usps.com"],
  va: ["https://news.va.gov", "https://www.va.gov"],
};

export function probePlan(origin: string): ProbeCheck[] {
  return [
    { kind: "wordpress", url: `${origin}/wp-json/wp/v2/posts?per_page=1` },
    { kind: "drupal", url: `${origin}/jsonapi` },
    { kind: "news_sitemap", url: `${origin}/sitemap-news.xml` },
    { kind: "news_sitemap", url: `${origin}/news-sitemap.xml` },
    { kind: "robots", url: `${origin}/robots.txt` },
  ];
}

export function classifyProbe(
  check: ProbeCheck,
  status: number,
  contentType: string,
  body: string,
): ProbeResult {
  if (status !== 200) {
    return { detail: `status ${status}`, verdict: "unavailable" };
  }
  if (check.kind === "wordpress") {
    if (!contentType.toLowerCase().includes("json")) {
      return { detail: contentType, verdict: "unavailable" };
    }
    try {
      const parsed: unknown = JSON.parse(body);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return { detail: "no posts returned", verdict: "unavailable" };
      }
      const first = parsed[0] as Record<string, unknown> | null;
      const looksLikePost =
        typeof first === "object" &&
        first !== null &&
        typeof first.id === "number" &&
        typeof first.link === "string";
      return looksLikePost
        ? { detail: `${parsed.length} post(s) returned`, verdict: "available" }
        : { detail: "items are not posts", verdict: "unavailable" };
    } catch {
      return { detail: "invalid JSON", verdict: "unavailable" };
    }
  }
  if (check.kind === "drupal") {
    if (!contentType.toLowerCase().includes("json")) {
      return { detail: contentType, verdict: "unavailable" };
    }
    try {
      const parsed = JSON.parse(body) as {
        jsonapi?: { version?: unknown };
        links?: Record<string, unknown>;
      };
      if (typeof parsed.jsonapi?.version !== "string") {
        return { detail: "no jsonapi envelope", verdict: "unavailable" };
      }
      const nodeTypes = Object.keys(parsed.links ?? {})
        .filter((key) => key.startsWith("node--"))
        .sort();
      if (nodeTypes.length === 0) {
        return { detail: "no node links", verdict: "unavailable" };
      }
      return {
        detail: nodeTypes.join(", "),
        verdict: "available",
      };
    } catch {
      return { detail: "invalid JSON", verdict: "unavailable" };
    }
  }
  if (check.kind === "news_sitemap") {
    return body.includes("schemas/sitemap-news")
      ? { detail: "google news namespace present", verdict: "available" }
      : { detail: "no news namespace", verdict: "unavailable" };
  }
  const sitemaps = [...body.matchAll(/^sitemap:\s*(\S+)/gim)].map(
    (match) => match[1] ?? "",
  );
  return sitemaps.length > 0
    ? { detail: sitemaps.join(", "), verdict: "available" }
    : { detail: "no sitemap declarations", verdict: "unavailable" };
}

async function probeOne(check: ProbeCheck): Promise<ProbeResult> {
  try {
    const response = await fetch(check.url, {
      headers: {
        "user-agent":
          process.env.NEWS_BACKFILL_USER_AGENT ??
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36 DotGovNewsBackfill/1.0 structured-source-probe",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.text()).slice(0, 262_144);
    return classifyProbe(
      check,
      response.status,
      response.headers.get("content-type") ?? "",
      body,
    );
  } catch (error) {
    return { detail: String(error).slice(0, 200), verdict: "error" };
  }
}

function markdownCell(input: string): string {
  return input.replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim();
}

async function main(): Promise<void> {
  const publisherFlag = process.argv.indexOf("--publisher");
  const filter =
    publisherFlag === -1 ? undefined : process.argv[publisherFlag + 1];
  if (
    publisherFlag !== -1 &&
    (filter === undefined || !(filter in PUBLISHER_ORIGINS))
  ) {
    throw new Error(`unknown publisher: ${filter ?? ""}`);
  }
  const lines: string[] = [
    "# Alternate structured-source probe",
    "",
    `Probed: ${new Date().toISOString()}`,
    "",
    "| Publisher | Check | URL | Verdict | Detail |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const [publisher, origins] of Object.entries(PUBLISHER_ORIGINS)) {
    if (filter !== undefined && filter !== publisher) continue;
    for (const origin of origins) {
      for (const check of probePlan(origin)) {
        const result = await probeOne(check);
        lines.push(
          `| ${publisher} | ${check.kind} | ${check.url} | ${result.verdict} | ${markdownCell(result.detail)} |`,
        );
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (process.argv[1]?.endsWith("probe.ts") === true) await main();
