import { type SupabaseRestClient } from "./database.js";
import { type ValidatedArticleOverviewV2 } from "./overview-v2-validation.js";

interface ExistingOverviewRow {
  article_overview: unknown;
  enrichment_version: unknown;
  event_card_id: unknown;
  input_hash: unknown;
  model: unknown;
  prompt_hash: unknown;
  prompt_version: unknown;
}

export interface ArticleOverviewV2PublishResult {
  cardCount: number;
  overviewRows: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function assertArticleOverviewRowsUpgradeable(
  existingRows: readonly ExistingOverviewRow[],
  expectedByCard: ReadonlyMap<string, ValidatedArticleOverviewV2>,
): void {
  for (const row of existingRows) {
    if (
      typeof row.event_card_id !== "string" ||
      typeof row.input_hash !== "string" ||
      typeof row.enrichment_version !== "number" ||
      typeof row.prompt_version !== "number"
    ) {
      throw new Error("article overviews returned an invalid version row");
    }
    const expected = expectedByCard.get(row.event_card_id);
    if (
      expected === undefined ||
      row.input_hash !== expected.artifact.inputHash
    ) {
      throw new Error(
        `article overview already contains a different input hash for card ${row.event_card_id}`,
      );
    }
    const { artifact } = expected;
    if (
      row.enrichment_version > artifact.enrichmentVersion ||
      row.prompt_version > artifact.promptVersion
    ) {
      throw new Error(
        `article overview is newer than this artifact for card ${row.event_card_id}`,
      );
    }
    if (
      row.enrichment_version === artifact.enrichmentVersion &&
      row.prompt_version === artifact.promptVersion &&
      (row.prompt_hash !== artifact.promptHash ||
        row.model !== artifact.model ||
        canonicalJson(row.article_overview) !==
          canonicalJson(artifact.articleOverview))
    ) {
      throw new Error(
        `article overview v2 is immutable for card ${row.event_card_id}; increment the version to revise it`,
      );
    }
  }
}

export function articleOverviewV2Record(
  validated: ValidatedArticleOverviewV2,
): Record<string, unknown> {
  const { artifact, task } = validated;
  return {
    article_overview: artifact.articleOverview,
    enrichment_version: artifact.enrichmentVersion,
    event_card_id: artifact.eventCardId,
    generated_at: artifact.generatedAt,
    input_hash: artifact.inputHash,
    model: artifact.model,
    prompt_hash: artifact.promptHash,
    prompt_version: artifact.promptVersion,
    source_card_version: task.inputBasis.card.version,
    source_content_hashes: task.inputBasis.sources.map(
      (source) => source.contentHash,
    ),
    source_entry_ids: task.inputBasis.sources.map(
      (source) => source.newsEntryId,
    ),
  };
}

function rpcParameters(
  validated: ValidatedArticleOverviewV2,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(articleOverviewV2Record(validated)).map(([key, value]) => [
      `p_${key}`,
      value,
    ]),
  );
}

export async function assertArticleOverviewRowsCompatible(
  database: SupabaseRestClient,
  artifacts: readonly ValidatedArticleOverviewV2[],
): Promise<void> {
  const expectedByCard = new Map(
    artifacts.map((artifact) => [artifact.artifact.eventCardId, artifact]),
  );
  const cardIds = [...expectedByCard.keys()];
  if (cardIds.length === 0) return;
  const existingRows = (await database.select(
    "golden_event_card_article_overviews",
    "article_overview,enrichment_version,event_card_id,input_hash,model,prompt_hash,prompt_version",
    { filters: { event_card_id: `in.(${cardIds.join(",")})` } },
  )) as ExistingOverviewRow[];
  assertArticleOverviewRowsUpgradeable(existingRows, expectedByCard);
}

export async function publishArticleOverviewV2Artifacts(
  artifacts: readonly ValidatedArticleOverviewV2[],
  options: { database: SupabaseRestClient; dryRun: boolean },
): Promise<ArticleOverviewV2PublishResult> {
  if (!options.dryRun) {
    for (const artifact of artifacts) {
      await options.database.rpc(
        "publish_golden_event_card_article_overview",
        rpcParameters(artifact),
      );
    }
  }
  return {
    cardCount: artifacts.length,
    overviewRows: options.dryRun ? 0 : artifacts.length,
  };
}
