import type { NormalizedEntry, SourceProfile, TargetState } from "./types";

interface RepositoryConfig {
  secretKey: string;
  supabaseUrl: string;
}

export class BackfillRepository {
  private readonly headers: Record<string, string>;

  public constructor(private readonly config: RepositoryConfig) {
    this.headers = {
      apikey: config.secretKey,
      authorization: `Bearer ${config.secretKey}`,
      "content-type": "application/json",
    };
  }

  private async call<T>(
    name: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(
      `${this.config.supabaseUrl}/rest/v1/rpc/${name}`,
      {
        body: JSON.stringify(body),
        headers: this.headers,
        method: "POST",
        signal: AbortSignal.timeout(60_000),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `${name} failed (${response.status}): ${text.slice(0, 1000)}`,
      );
    }
    return (text === "" ? null : JSON.parse(text)) as T;
  }

  public registerSource(profile: SourceProfile): Promise<string> {
    return this.call<string>("register_curated_news_source", {
      p_adapter_config: {
        adapter: profile.adapter,
        adapterVariant: profile.adapterVariant,
        includeUrlPattern: profile.includeUrlPattern,
        maxPages: profile.maxPages,
        sourceKey: profile.sourceKey,
        urlTemplate: profile.urlTemplate,
      },
      p_canonical_url: profile.sourceUrl,
      p_home_page_url: new URL(profile.sourceUrl).origin,
      p_quality_flags: [],
      p_source_type: profile.sourceType,
      p_title: profile.title,
    });
  }

  public beginRun(input: {
    cohortId: string;
    manifestSha256: string;
    runKey: string;
    windowEnd: string;
    windowStart: string;
  }): Promise<string> {
    return this.call<string>("begin_news_backfill_run", {
      p_cohort_id: input.cohortId,
      p_manifest_sha256: input.manifestSha256,
      p_run_key: input.runKey,
      p_window_end: input.windowEnd,
      p_window_start: input.windowStart,
    });
  }

  public ensureTarget(input: {
    profile: SourceProfile;
    publisherKey: string;
    runId: string;
    sourceId: string;
  }): Promise<string> {
    return this.call<string>("ensure_news_backfill_target", {
      p_adapter: input.profile.adapter,
      p_news_source_id: input.sourceId,
      p_publisher_key: input.publisherKey,
      p_run_id: input.runId,
      p_source_key: input.profile.sourceKey,
    });
  }

  public async targetState(targetId: string): Promise<TargetState> {
    const response = await fetch(
      `${this.config.supabaseUrl}/rest/v1/news_backfill_targets?id=eq.${encodeURIComponent(targetId)}&select=id,status,cursor`,
      { headers: this.headers, signal: AbortSignal.timeout(30_000) },
    );
    const rows = (await response.json()) as TargetState[];
    if (!response.ok || rows[0] === undefined) {
      throw new Error(`unable to read target ${targetId}`);
    }
    return rows[0];
  }

  public ingest(
    targetId: string,
    entries: NormalizedEntry[],
  ): Promise<Array<{ disposition: string; error_code: string | null }>> {
    return this.call("ingest_news_entries", {
      p_entries: entries,
      p_target_id: targetId,
    });
  }

  public checkpoint(input: {
    coverageEvidenceArtifactKey: string;
    coverageReachedAt: string | null;
    cursor: Record<string, unknown>;
    targetId: string;
  }): Promise<boolean> {
    return this.call<boolean>("checkpoint_news_backfill_target", {
      p_coverage_evidence_artifact_key: input.coverageEvidenceArtifactKey,
      p_coverage_reached_at: input.coverageReachedAt,
      p_cursor: input.cursor,
      p_target_id: input.targetId,
    });
  }

  public completeTarget(input: {
    coverageEvidenceArtifactKey: string | null;
    coverageReachedAt: string | null;
    cursor: Record<string, unknown>;
    errorCode?: string;
    errorDetail?: string;
    status: "succeeded" | "partial" | "failed" | "cancelled";
    stopReason: string;
    targetId: string;
  }): Promise<boolean> {
    return this.call<boolean>("complete_news_backfill_target", {
      p_coverage_evidence_artifact_key: input.coverageEvidenceArtifactKey,
      p_coverage_reached_at: input.coverageReachedAt,
      p_cursor: input.cursor,
      p_error_code: input.errorCode ?? null,
      p_error_detail: input.errorDetail?.slice(0, 4096) ?? null,
      p_status: input.status,
      p_stop_reason: input.stopReason,
      p_target_id: input.targetId,
    });
  }

  public finishRun(runId: string): Promise<string> {
    return this.call<string>("finish_news_backfill_run", { p_run_id: runId });
  }
}
