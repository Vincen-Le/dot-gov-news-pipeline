import { readFile } from "node:fs/promises";

import { fingerprint, sha256 } from "../shared/fingerprint.js";
import {
  findArticleOverviewV2Artifacts,
  loadTrustedTasks,
} from "../shared/manifests.js";
import {
  ArticleOverviewEnrichmentV2Schema,
  type ArticleOverviewEnrichmentV2,
  type OverviewTask,
} from "../shared/types.js";

const PROMPT_LEAK_PATTERNS = [
  /as an ai(?: language model)?/iu,
  /developer message/iu,
  /ignore (?:all|any|the|these|previous|prior) instructions/iu,
  /prompt injection/iu,
  /system prompt/iu,
  /you are (?:chatgpt|an ai|a language model)/iu,
];

const sentenceSegmenter = new Intl.Segmenter("en", {
  granularity: "sentence",
});
const WRITER_CONTRACT_URL = new URL(
  "../../docs/article_synthesis/article-overview-v2.md",
  import.meta.url,
);

export interface OverviewV2ValidationOptions {
  artifactInputs: string[];
  limit?: number;
  manifestDirectory: string;
}

export interface ValidatedArticleOverviewV2 {
  artifact: ArticleOverviewEnrichmentV2;
  artifactPath: string;
  task: OverviewTask;
}

function wordCount(value: string): number {
  return value.match(/[\p{L}\p{N}]+(?:[’'–-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function assertWords(
  label: string,
  value: string,
  minimum: number,
  maximum: number,
): void {
  const count = wordCount(value);
  if (count < minimum || count > maximum) {
    throw new Error(
      `${label} must be ${minimum}-${maximum} words (received ${count})`,
    );
  }
}

function assertNoPromptLeak(label: string, value: string): void {
  if (PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} contains prompt-leak language`);
  }
}

function assertOneOrTwoSentences(label: string, value: string): void {
  const count = [...sentenceSegmenter.segment(value)].filter(
    ({ segment }) => wordCount(segment) > 0,
  ).length;
  if (count < 1 || count > 2) {
    throw new Error(`${label} must contain 1-2 sentences (received ${count})`);
  }
}

function exactUniqueSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (
    actual.length !== actualSet.size ||
    expected.length !== expectedSet.size ||
    actualSet.size !== expectedSet.size
  ) {
    return false;
  }
  return [...actualSet].every((value) => expectedSet.has(value));
}

function validateContent(
  artifact: ArticleOverviewEnrichmentV2,
  task: OverviewTask,
): void {
  const trustedSourceIds = task.inputBasis.sources.map(
    (source) => source.newsEntryId,
  );
  if (!exactUniqueSet(artifact.sourceEntryIds, trustedSourceIds)) {
    throw new Error("sourceEntryIds must exactly match trusted card sources");
  }

  const sections = [
    artifact.articleOverview.summary,
    ...artifact.articleOverview.keyPoints,
  ];
  const allowed = new Set(trustedSourceIds);
  const cited = new Set<string>();
  for (const [index, section] of sections.entries()) {
    const label = index === 0 ? "summary" : `key point ${index}`;
    const sectionIds = new Set(section.sourceEntryIds);
    if (
      sectionIds.size !== section.sourceEntryIds.length ||
      sectionIds.size === 0 ||
      [...sectionIds].some((id) => !allowed.has(id))
    ) {
      throw new Error(`${label} must cite unique trusted source IDs`);
    }
    sectionIds.forEach((id) => cited.add(id));
    assertNoPromptLeak(label, section.text);
    if (index > 0) {
      assertWords(label, section.text, 12, 80);
      assertOneOrTwoSentences(label, section.text);
    }
  }

  if (![...allowed].every((id) => cited.has(id))) {
    throw new Error("overview sections must collectively cite every source");
  }

  assertWords("summary", artifact.articleOverview.summary.text, 25, 160);
  const overviewText = sections.map(({ text }) => text).join(" ");
  assertWords("articleOverview", overviewText, 60, 380);

  const normalizedPoints = artifact.articleOverview.keyPoints.map(({ text }) =>
    text.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim(),
  );
  if (new Set(normalizedPoints).size !== normalizedPoints.length) {
    throw new Error("key points must be distinct");
  }
}

async function validateOne(
  artifactPath: string,
  trustedTasks: ReadonlyMap<string, OverviewTask>,
  expectedPromptHash: string,
): Promise<ValidatedArticleOverviewV2> {
  const artifact = ArticleOverviewEnrichmentV2Schema.parse(
    JSON.parse(await readFile(artifactPath, "utf8")),
  );
  const task = trustedTasks.get(artifact.eventCardId);
  if (task === undefined) {
    throw new Error(`no trusted manifest for card ${artifact.eventCardId}`);
  }
  if (
    task.inputHash !== fingerprint(task.inputBasis) ||
    artifact.inputHash !== task.inputHash
  ) {
    throw new Error(`input hash mismatch for card ${artifact.eventCardId}`);
  }
  if (artifact.sourceCutoffAt !== task.inputBasis.card.newestEntryAt) {
    throw new Error(`source cutoff mismatch for card ${artifact.eventCardId}`);
  }
  if (artifact.promptHash !== expectedPromptHash) {
    throw new Error(`prompt hash mismatch for card ${artifact.eventCardId}`);
  }
  const cutoff = Date.parse(task.inputBasis.card.newestEntryAt);
  if (
    task.inputBasis.sources.some(
      (source) => Date.parse(source.publishedAt) > cutoff,
    )
  ) {
    throw new Error(
      "trusted card includes a source after its event-time cutoff",
    );
  }
  validateContent(artifact, task);
  return { artifact, artifactPath, task };
}

export async function validateArticleOverviewV2Artifacts(
  options: OverviewV2ValidationOptions,
): Promise<ValidatedArticleOverviewV2[]> {
  const trustedTasks = await loadTrustedTasks(options.manifestDirectory);
  const expectedPromptHash = sha256(await readFile(WRITER_CONTRACT_URL));
  const artifactPaths = (
    await findArticleOverviewV2Artifacts(options.artifactInputs)
  ).slice(0, options.limit);
  if (artifactPaths.length === 0) {
    throw new Error("no article-overview.v2 artifacts found");
  }
  const validated: ValidatedArticleOverviewV2[] = [];
  const eventCardIds = new Set<string>();
  for (const artifactPath of artifactPaths) {
    const value = await validateOne(
      artifactPath,
      trustedTasks,
      expectedPromptHash,
    );
    if (eventCardIds.has(value.artifact.eventCardId)) {
      throw new Error(
        `duplicate article-overview.v2 artifact for card ${value.artifact.eventCardId}`,
      );
    }
    eventCardIds.add(value.artifact.eventCardId);
    validated.push(value);
  }
  return validated;
}
