// apps/operator-console/src/lab/rank-queries.ts
//
// Read-only queries over the rank observability tables (rank_snapshots,
// rank_audit_pairs, rank_audit_runs). Separate from LabQueries so the rank
// surface can evolve without touching the storyline queries.
import type postgres from "postgres";

import type {
  RankAuditPair,
  RankAuditRun,
  RankExperiment,
  RankFacet,
  RankRowDetail,
  RankSnapshotRow,
  RankTerms,
} from "./contracts";

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : null;

export class RankQueries {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly rankSnapshotsTable: string = "rank_snapshots",
  ) {}

  async rankExperiments(): Promise<RankExperiment[]> {
    const rows = await this.sql`
      select experiment.id, experiment.name, experiment.status,
             experiment.source_run_id, experiment.data_cutoff_at,
             experiment.created_at, experiment.rank_system_version_id,
             version.version_number
      from public.rank_experiments experiment
      join public.rank_system_versions version
        on version.id = experiment.rank_system_version_id
      where experiment.status in ('calculated', 'validated', 'promoted')
      order by experiment.created_at desc, experiment.id
    `;
    return rows.map((row) => ({
      createdAt: iso(row.created_at) ?? "",
      dataCutoffAt: iso(row.data_cutoff_at),
      id: String(row.id),
      name: String(row.name),
      rankSystemVersionId: String(row.rank_system_version_id),
      rankSystemVersionNumber: Number(row.version_number),
      sourceRunId:
        row.source_run_id === null ? null : String(row.source_run_id),
      status: String(row.status),
    }));
  }

  private async isVersionedExperiment(runId: string): Promise<boolean> {
    const rows = await this.sql`
      select 1 from public.rank_experiments where id = ${runId} limit 1
    `;
    return rows.length === 1;
  }

  async rankFacets(runId: string): Promise<RankFacet[]> {
    if (await this.isVersionedExperiment(runId)) {
      const rows = await this.sql`
        with ranked as (
          select category_id, theme_id, agency_ids
          from public.snapshot_rank_rows
          where experiment_id = ${runId}
        ), facets as (
          select 'global'::text as facet_type, ''::text as facet_key,
                 count(*)::integer as rows
          from ranked
          union all
          select 'category', category_id::text, count(*)::integer
          from ranked where category_id is not null group by category_id
          union all
          select 'theme', theme_id::text, count(*)::integer
          from ranked where theme_id is not null group by theme_id
          union all
          select 'agency', agency, count(*)::integer
          from ranked, lateral unnest(agency_ids) agency group by agency
        )
        select facet_type, facet_key, rows from facets
        where rows > 0 order by facet_type, facet_key
      `;
      return rows.map((row) => ({
        facetKey: String(row.facet_key),
        facetType: String(row.facet_type),
        rows: Number(row.rows),
      }));
    }
    const rows = await this.sql`
      select facet_type, facet_key, count(*)::integer as rows
      from public.${this.sql(this.rankSnapshotsTable)}
      where run_id = ${runId}
      group by facet_type, facet_key
      order by facet_type, facet_key
    `;
    return rows.map((row) => ({
      facetKey: String(row.facet_key),
      facetType: String(row.facet_type),
      rows: Number(row.rows),
    }));
  }

  async rankSnapshot(
    runId: string,
    facetType: string,
    facetKey: string,
    limit: number,
  ): Promise<RankSnapshotRow[]> {
    if (await this.isVersionedExperiment(runId)) {
      const rows = await this.sql`
        select global_position, category_position, storyline_id,
               golden_event_card_id, primary_rank_key, rank_terms,
               card_snapshot, context_snapshot, category_id, theme_id,
               agency_ids
        from public.snapshot_rank_rows
        where experiment_id = ${runId}
        order by global_position
      `;
      const filtered = rows.filter((row) => {
        if (facetType === "global") return true;
        if (facetType === "category")
          return String(row.category_id) === facetKey;
        if (facetType === "theme") return String(row.theme_id) === facetKey;
        if (facetType === "agency") {
          return (row.agency_ids as string[]).includes(facetKey);
        }
        return false;
      });
      return filtered.slice(0, limit).map((row, index) => {
        const card = row.card_snapshot as Record<string, unknown>;
        const context =
          (row.context_snapshot as Record<string, unknown> | null) ?? {};
        const position =
          facetType === "global"
            ? Number(row.global_position)
            : facetType === "category"
              ? Number(row.category_position)
              : index + 1;
        const termsAvailable = row.rank_terms !== null;
        return {
          agencies: (row.agency_ids as string[]).length,
          cardId: String(row.golden_event_card_id),
          entryCount: Number(context.entry_count ?? 0),
          facetKey,
          facetType,
          feeds: Number(context.distinct_feeds ?? 0),
          headline: (card.headline as string | null) ?? null,
          interestReason: (card.interest_reason as string | null) ?? null,
          judged: card.rubric !== null,
          newestEntryAt: (card.newest_entry_at as string | null) ?? null,
          position,
          rankKey: Number(row.primary_rank_key),
          rubric: (card.rubric as Record<string, unknown> | null) ?? null,
          storylineId: String(row.storyline_id),
          summary: (card.summary as string | null) ?? null,
          termsAvailable,
          terms: termsAvailable
            ? (row.rank_terms as RankTerms)
            : {
                agency_term: 0,
                feed_term: 0,
                freshness_term: 0,
                prior_used: false,
                rubric_points: 0,
                source_term: 0,
              },
        };
      });
    }
    const rows = await this.sql`
      select facet_type, facet_key, position, storyline_id, card_id, rank_key,
             terms, judged, headline, summary, rubric, interest_reason,
             agencies, feeds, entry_count, newest_entry_at
      from public.${this.sql(this.rankSnapshotsTable)}
      where run_id = ${runId} and facet_type = ${facetType}
        and facet_key = ${facetKey}
      order by position
      limit ${limit}
    `;
    return rows.map((row) => ({
      agencies: Number(row.agencies),
      cardId: String(row.card_id),
      entryCount: Number(row.entry_count),
      facetKey: String(row.facet_key),
      facetType: String(row.facet_type),
      feeds: Number(row.feeds),
      headline: (row.headline as string | null) ?? null,
      interestReason: (row.interest_reason as string | null) ?? null,
      judged: Boolean(row.judged),
      newestEntryAt: iso(row.newest_entry_at),
      position: Number(row.position),
      rankKey: Number(row.rank_key),
      rubric: (row.rubric as Record<string, unknown> | null) ?? null,
      storylineId: String(row.storyline_id),
      summary: (row.summary as string | null) ?? null,
      termsAvailable: true,
      terms: row.terms as RankTerms,
    }));
  }

  async rankAuditPairs(
    runId: string,
    facetType: string,
    facetKey: string,
  ): Promise<RankAuditPair[]> {
    const rows = await this.sql`
      select run_id, facet_type, facet_key, position_a, position_b,
             storyline_a, storyline_b, llm_prefers, llm_reason
      from public.rank_audit_pairs
      where run_id = ${runId} and facet_type = ${facetType}
        and facet_key = ${facetKey}
      order by position_a, position_b
    `;
    return rows.map((row) => ({
      facetKey: String(row.facet_key),
      facetType: String(row.facet_type),
      llmPrefers: row.llm_prefers as "a" | "b" | "inconsistent",
      llmReason: (row.llm_reason as string | null) ?? null,
      positionA: Number(row.position_a),
      positionB: Number(row.position_b),
      runId: String(row.run_id),
      storylineA: String(row.storyline_a),
      storylineB: String(row.storyline_b),
    }));
  }

  async rankAuditRuns(runId: string): Promise<RankAuditRun[]> {
    const rows = await this.sql`
      select id, run_id, metrics, created_at
      from public.rank_audit_runs
      where run_id = ${runId}
      order by created_at desc
    `;
    return rows.map((row) => ({
      createdAt: iso(row.created_at) ?? "",
      id: String(row.id),
      metrics: (row.metrics as Record<string, unknown> | null) ?? null,
      runId: String(row.run_id),
    }));
  }

  async rankRowDetail(
    experimentId: string,
    cardId: string,
  ): Promise<RankRowDetail | null> {
    const rows = await this.sql`
      select ranked.*, experiment.name as experiment_name,
             experiment.status as experiment_status, experiment.config_hash,
             experiment.data_snapshot_hash, experiment.code_commit,
             experiment.validation_profile,
             version.version_number, version.formula_key,
             opinion.status as opinion_status,
             opinion.direction as opinion_direction,
             opinion.current_category_position,
             opinion.suggested_category_position,
             opinion.position_delta, opinion.reason as opinion_reason
      from public.snapshot_rank_rows ranked
      join public.rank_experiments experiment
        on experiment.id = ranked.experiment_id
       and experiment.rank_system_version_id = ranked.rank_system_version_id
      join public.rank_system_versions version
        on version.id = ranked.rank_system_version_id
      left join public.rank_position_opinions opinion
        on opinion.experiment_id = ranked.experiment_id
       and opinion.rank_system_version_id = ranked.rank_system_version_id
       and opinion.golden_event_card_id = ranked.golden_event_card_id
      where ranked.experiment_id = ${experimentId}
        and ranked.golden_event_card_id = ${cardId}
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const card = row.card_snapshot as Record<string, unknown>;
    const context =
      (row.context_snapshot as Record<string, unknown> | null) ?? {};
    const terms = (row.rank_terms as Record<string, unknown> | null) ?? {};
    const legacy = row.validation_profile === "legacy_import";
    const rankInput = (row.rank_input as Record<string, unknown> | null) ?? {
      availability: "not captured for legacy import",
    };
    const termOrder = [
      "rubric_points",
      "agency_term",
      "feed_term",
      "source_term",
      "freshness_term",
    ];
    const neighbors =
      row.category_id === null
        ? []
        : await this.sql`
            select golden_event_card_id, category_position,
                   primary_rank_key, card_snapshot ->> 'headline' as headline
            from public.snapshot_rank_rows
            where experiment_id = ${experimentId}
              and rank_system_version_id = ${row.rank_system_version_id}
              and category_id = ${row.category_id}
              and category_position between
                  ${Math.max(Number(row.category_position) - 3, 1)}
                  and ${Number(row.category_position) + 3}
            order by category_position
          `;
    const episodes = Array.isArray(context.episodes) ? context.episodes : [];
    const sources = Array.isArray(context.source_entries)
      ? context.source_entries
      : [];
    const rubric = (card.rubric as Record<string, unknown> | null) ?? {};
    return {
      calculation: {
        formulaKey: legacy
          ? `${String(row.formula_key)} (legacy embedded key; terms unavailable)`
          : String(row.formula_key),
        rankInput,
        rankKey: Number(row.primary_rank_key),
        rubricDecisions: Object.entries(rubric).map(([key, value]) => ({
          key,
          value: value === true || value === 1 || value === "1",
        })),
        termBreakdown: legacy
          ? []
          : termOrder.map((key) => ({
              key,
              label: key.replaceAll("_", " "),
              value: Number(terms[key] ?? 0),
            })),
      },
      categoryNeighbors: neighbors.map((neighbor) => ({
        categoryPosition: Number(neighbor.category_position),
        goldenEventCardId: String(neighbor.golden_event_card_id),
        headline: String(neighbor.headline ?? "(no headline)"),
        rankKey: Number(neighbor.primary_rank_key),
        relation:
          Number(neighbor.category_position) < Number(row.category_position)
            ? "above"
            : Number(neighbor.category_position) > Number(row.category_position)
              ? "below"
              : "target",
      })),
      identity: {
        experimentId: String(row.experiment_id),
        goldenEventCardId: String(row.golden_event_card_id),
        rankSystemVersionId: String(row.rank_system_version_id),
        rankSystemVersionNumber: Number(row.version_number),
        storylineId: String(row.storyline_id),
      },
      positionOpinion:
        row.opinion_status === null
          ? null
          : {
              currentCategoryPosition: Number(row.current_category_position),
              direction: row.opinion_direction as
                "up" | "down" | "stay" | "uncertain",
              positionDelta:
                row.position_delta === null ? null : Number(row.position_delta),
              reason: (row.opinion_reason as string | null) ?? null,
              status: row.opinion_status as
                | "available"
                | "bounded"
                | "not_run"
                | "insufficient_neighbors"
                | "inconsistent"
                | "failed",
              suggestedCategoryPosition:
                row.suggested_category_position === null
                  ? null
                  : Number(row.suggested_category_position),
            },
      provenance: {
        codeCommit: (row.code_commit as string | null) ?? null,
        configHash: String(row.config_hash),
        contextHash: String(row.context_hash),
        dataSnapshotHash: (row.data_snapshot_hash as string | null) ?? null,
        experimentStatus: String(row.experiment_status),
        rankInputHash: legacy
          ? "legacy:not-captured"
          : String(row.rank_input_hash),
      },
      storylineSnapshot: {
        agencies: row.agency_ids as string[],
        categoryId: row.category_id === null ? null : String(row.category_id),
        entryCount: Number(context.entry_count ?? 0),
        episodes: episodes.map((episode) => {
          const value = episode as Record<string, unknown>;
          return {
            firstEntryAt: (value.first_entry_at as string | null) ?? null,
            headline: (value.headline as string | null) ?? null,
            id: String(value.id),
            newestEntryAt: (value.newest_entry_at as string | null) ?? null,
            summary: (value.summary as string | null) ?? null,
          };
        }),
        headline: String(card.headline ?? "(no headline)"),
        knowledgeCutoffAt: String(
          context.knowledge_cutoff_at ?? card.newest_entry_at,
        ),
        sourceEntries: sources.map((source) => {
          const value = source as Record<string, unknown>;
          return {
            agencies: (value.agencies as string[]) ?? [],
            contentHash: String(value.content_hash),
            episodeId:
              value.episode_id === null ? null : String(value.episode_id),
            id: String(value.id),
            isSyndicated:
              value.is_syndicated === null
                ? null
                : Boolean(value.is_syndicated),
            publishedAt: (value.published_at as string | null) ?? null,
            title: (value.title as string | null) ?? null,
            url: String(value.url),
          };
        }),
        summary: String(card.summary ?? ""),
        themeId: row.theme_id === null ? null : String(row.theme_id),
        timeline: Array.isArray(card.timeline)
          ? (card.timeline as Record<string, unknown>[])
          : [],
      },
    };
  }
}
