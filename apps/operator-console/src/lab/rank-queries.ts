// apps/operator-console/src/lab/rank-queries.ts
//
// Read-only queries over the rank observability tables (rank_snapshots,
// rank_audit_pairs, rank_audit_runs). Separate from LabQueries so the rank
// surface can evolve without touching the storyline queries.
import type postgres from "postgres";

import type {
  RankAuditPair,
  RankAuditRun,
  RankFacet,
  RankSnapshotRow,
  RankTerms,
} from "./contracts";

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : null;

export class RankQueries {
  constructor(private readonly sql: postgres.Sql) {}

  async rankFacets(runId: string): Promise<RankFacet[]> {
    const rows = await this.sql`
      select facet_type, facet_key, count(*)::integer as rows
      from public.rank_snapshots
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
    const rows = await this.sql`
      select facet_type, facet_key, position, storyline_id, card_id, rank_key,
             terms, judged, headline, summary, rubric, interest_reason,
             agencies, feeds, entry_count, newest_entry_at
      from public.rank_snapshots
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
}
