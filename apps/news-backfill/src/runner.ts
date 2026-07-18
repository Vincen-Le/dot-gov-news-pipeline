import { createHash } from "node:crypto";

import { enumerateBatches } from "./adapters";
import { ArtifactStore } from "./artifact-store";
import { extractArticleMetadata, normalizeCandidate } from "./extract";
import type { createFetcher } from "./fetcher";
import { BackfillRepository } from "./repository";
import type {
  BackfillManifest,
  Candidate,
  NormalizedEntry,
  PublisherProfile,
  RunSummary,
  SourceProfile,
} from "./types";

type FetchDocument = ReturnType<typeof createFetcher>;

interface RunnerOptions {
  artifactStore: ArtifactStore;
  dryRun: boolean;
  fetchDocument: FetchDocument;
  manifest: BackfillManifest;
  manifestSha256: string;
  publisherFilter?: Set<string>;
  repository: BackfillRepository;
  runKey: string;
}

function log(record: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
  );
}

function rejectedEntry(input: {
  artifactKey: string;
  candidate: Candidate;
  newsSubtype: SourceProfile["newsSubtype"];
  windowStart: string;
}): NormalizedEntry {
  const canonical = (() => {
    try {
      return new URL(input.candidate.url).href;
    } catch {
      return "https://invalid.invalid/";
    }
  })();
  const candidateKey = createHash("sha256")
    .update(`${input.candidate.externalItemId ?? ""}\n${canonical}`)
    .digest("hex");
  return {
    candidate_key: candidateKey,
    content_hash: createHash("sha256").update(canonical).digest("hex"),
    external_item_id: input.candidate.externalItemId,
    extractor_version: 1,
    fetched_at: new Date().toISOString(),
    news_subtype: input.newsSubtype,
    published_at: input.candidate.publishedAt ?? input.windowStart,
    raw_artifact_key: input.artifactKey,
    summary: null,
    title: "",
    url: canonical,
    url_canonical: canonical,
  };
}

async function normalizeOne(input: {
  artifactStore: ArtifactStore;
  candidate: Candidate;
  fetchDocument: FetchDocument;
  profile: SourceProfile;
  publisherKey: string;
  windowEnd: string;
  windowStart: string;
}): Promise<NormalizedEntry> {
  const fetchedAt = new Date().toISOString();
  let artifactKey = await input.artifactStore.archive(
    input.publisherKey,
    input.candidate.rawBody,
    input.candidate.rawContentType,
  );
  let metadata;
  const candidateTimestamp =
    input.candidate.publishedAt === null
      ? Number.NaN
      : Date.parse(input.candidate.publishedAt);
  const candidateMayBeInWindow =
    !Number.isFinite(candidateTimestamp) ||
    (candidateTimestamp >= Date.parse(input.windowStart) &&
      candidateTimestamp < Date.parse(input.windowEnd));
  const requiresHydration =
    candidateMayBeInWindow &&
    (input.profile.hydrate === true ||
      input.candidate.title === null ||
      input.candidate.publishedAt === null ||
      input.candidate.summary === null);
  if (requiresHydration) {
    try {
      const article = await input.fetchDocument(
        input.candidate.fetchUrl ?? input.candidate.url,
        input.profile.allowedHosts,
      );
      artifactKey = await input.artifactStore.archive(
        input.publisherKey,
        article.body,
        article.contentType,
      );
      metadata = extractArticleMetadata(article.body, input.candidate.url);
    } catch (error) {
      log({
        error: error instanceof Error ? error.message : String(error),
        event: "article_hydration_failed",
        publisher: input.publisherKey,
        url: input.candidate.url,
      });
    }
  }

  return (
    normalizeCandidate({
      artifactKey,
      candidate: input.candidate,
      fetchedAt,
      metadata,
      newsSubtype: input.profile.newsSubtype,
      windowEnd: input.windowEnd,
      windowStart: input.windowStart,
    }) ??
    rejectedEntry({
      artifactKey,
      candidate: input.candidate,
      newsSubtype: input.profile.newsSubtype,
      windowStart: input.windowStart,
    })
  );
}

async function processSource(input: {
  artifactStore: ArtifactStore;
  dryRun: boolean;
  fetchDocument: FetchDocument;
  manifest: BackfillManifest;
  profile: SourceProfile;
  publisher: PublisherProfile;
  repository: BackfillRepository;
  runId: string;
}): Promise<"succeeded" | "partial" | "failed"> {
  const { manifest, profile, publisher, repository } = input;
  let targetId: string | null = null;
  let cursor: Record<string, unknown> = {};
  let coverageReachedAt: string | null = null;
  let evidenceArtifactKey: string | null = null;
  let stopReason: string | undefined;
  try {
    if (!input.dryRun) {
      const sourceId = await repository.registerSource(profile);
      targetId = await repository.ensureTarget({
        profile,
        publisherKey: publisher.publisherKey,
        runId: input.runId,
        sourceId,
      });
      const state = await repository.targetState(targetId);
      if (
        ["succeeded", "partial", "failed", "cancelled"].includes(state.status)
      ) {
        log({
          event: "target_already_terminal",
          publisher: publisher.publisherKey,
          source: profile.sourceKey,
          status: state.status,
        });
        return state.status === "succeeded"
          ? "succeeded"
          : state.status === "partial"
            ? "partial"
            : "failed";
      }
      cursor = state.cursor;
    }

    for await (const batch of enumerateBatches({
      cursor,
      fetchDocument: input.fetchDocument,
      profile,
      windowEnd: manifest.windowEnd,
      windowStart: manifest.windowStart,
    })) {
      cursor = batch.cursor;
      coverageReachedAt = batch.coverageReachedAt ?? coverageReachedAt;
      stopReason = batch.stopReason ?? stopReason;
      evidenceArtifactKey = await input.artifactStore.archive(
        publisher.publisherKey,
        batch.evidenceBody,
        batch.evidenceContentType,
      );
      const normalized: NormalizedEntry[] = [];
      for (const candidate of batch.candidates) {
        normalized.push(
          await normalizeOne({
            artifactStore: input.artifactStore,
            candidate,
            fetchDocument: input.fetchDocument,
            profile,
            publisherKey: publisher.publisherKey,
            windowEnd: manifest.windowEnd,
            windowStart: manifest.windowStart,
          }),
        );
      }

      const dispositions: Record<string, number> = {};
      if (!input.dryRun && targetId !== null) {
        for (let index = 0; index < normalized.length; index += 50) {
          const chunk = normalized.slice(index, index + 50);
          if (chunk.length === 0) continue;
          const results = await repository.ingest(targetId, chunk);
          for (const result of results) {
            dispositions[result.disposition] =
              (dispositions[result.disposition] ?? 0) + 1;
          }
        }
        await repository.checkpoint({
          coverageEvidenceArtifactKey: evidenceArtifactKey,
          coverageReachedAt,
          cursor,
          targetId,
        });
      }
      log({
        candidates: batch.candidates.length,
        cursor,
        dispositions,
        event: "source_batch_completed",
        publisher: publisher.publisherKey,
        source: profile.sourceKey,
      });
    }

    const status = stopReason === undefined ? "partial" : "succeeded";
    if (!input.dryRun && targetId !== null) {
      await repository.completeTarget({
        coverageEvidenceArtifactKey: evidenceArtifactKey,
        coverageReachedAt,
        cursor,
        status,
        stopReason: stopReason ?? "page_limit_reached",
        targetId,
      });
    }
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({
      event: "source_failed",
      error: message,
      publisher: publisher.publisherKey,
      source: profile.sourceKey,
    });
    if (!input.dryRun && targetId !== null) {
      await repository
        .completeTarget({
          coverageEvidenceArtifactKey: evidenceArtifactKey,
          coverageReachedAt,
          cursor,
          errorCode: "publisher_failure",
          errorDetail: message,
          status: "failed",
          stopReason: "publisher_failure",
          targetId,
        })
        .catch(() => undefined);
    }
    return "failed";
  }
}

async function processPublisher(
  publisher: PublisherProfile,
  options: RunnerOptions,
  runId: string,
): Promise<"succeeded" | "partial" | "failed"> {
  const results: Array<"succeeded" | "partial" | "failed"> = [];
  for (const profile of publisher.sources) {
    results.push(
      await processSource({
        artifactStore: options.artifactStore,
        dryRun: options.dryRun,
        fetchDocument: options.fetchDocument,
        manifest: options.manifest,
        profile,
        publisher,
        repository: options.repository,
        runId,
      }),
    );
  }
  if (results.every((result) => result === "succeeded")) return "succeeded";
  if (results.some((result) => result === "succeeded" || result === "partial"))
    return "partial";
  return "failed";
}

export async function runBackfill(options: RunnerOptions): Promise<RunSummary> {
  const runId = options.dryRun
    ? "dry-run"
    : await options.repository.beginRun({
        cohortId: options.manifest.cohortId,
        manifestSha256: options.manifestSha256,
        runKey: options.runKey,
        windowEnd: options.manifest.windowEnd,
        windowStart: options.manifest.windowStart,
      });
  const publishers = options.manifest.publishers.filter(
    (publisher) =>
      options.publisherFilter === undefined ||
      options.publisherFilter.has(publisher.publisherKey),
  );
  const summary: RunSummary = {
    failed: 0,
    partial: 0,
    publishers: publishers.length,
    succeeded: 0,
  };

  const concurrency = 4;
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, publishers.length) },
      async () => {
        while (nextIndex < publishers.length) {
          const publisher = publishers[nextIndex];
          nextIndex += 1;
          if (publisher === undefined) return;
          log({
            event: "publisher_started",
            publisher: publisher.publisherKey,
          });
          const status = await processPublisher(publisher, options, runId);
          summary[status] += 1;
          log({
            event: "publisher_completed",
            publisher: publisher.publisherKey,
            status,
          });
        }
      },
    ),
  );

  if (!options.dryRun && options.publisherFilter === undefined) {
    await options.repository.finishRun(runId);
  }
  return summary;
}
