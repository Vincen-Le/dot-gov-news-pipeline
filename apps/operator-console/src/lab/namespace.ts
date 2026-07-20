// apps/operator-console/src/lab/namespace.ts
//
// Per-pipeline table namespace, mirroring pipeline/experiment.py's
// _NAMESPACES dict: complex_v1 for the classic engine, simple_v1 for spine.
// rank_snapshots predates per-pipeline namespacing
// (supabase/migrations/20260719140000) and was left bare for complex_v1;
// only simple_v1 got its own namespaced copy (20260719150000).

export type PipelineNamespace = "complex_v1" | "simple_v1";

const ENGINE_NAMESPACE: Record<string, PipelineNamespace> = {
  classic: "complex_v1",
  spine: "simple_v1",
};

/** Matches the primary DB reality: the env-only default connection (no
 * registry entry, no engine) talks to the primary postgres database, which
 * holds complex_v1 data. */
export const DEFAULT_NAMESPACE: PipelineNamespace = "complex_v1";

export function namespaceForEngine(engine?: string): PipelineNamespace {
  if (engine === undefined) return DEFAULT_NAMESPACE;
  return ENGINE_NAMESPACE[engine] ?? DEFAULT_NAMESPACE;
}

export interface NamespaceTables {
  experimentRuns: string;
  experimentClusterSnapshots: string;
  rankSnapshots: string;
}

export function namespaceTables(namespace: PipelineNamespace): NamespaceTables {
  return {
    experimentRuns: `${namespace}_experiment_runs`,
    experimentClusterSnapshots: `${namespace}_experiment_cluster_snapshots`,
    rankSnapshots:
      namespace === "complex_v1"
        ? "rank_snapshots"
        : `${namespace}_rank_snapshots`,
  };
}
