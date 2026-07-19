import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";

import { ExperimentRunSchema } from "../lab/contracts";
import { fetchLab } from "./lab-api";

const ExperimentListSchema = z.object({
  active: z.unknown().nullable(),
  items: ExperimentRunSchema.array(),
});

export function useExperimentRuns(pipeline?: string, enabled = true) {
  const experiments = useQuery({
    enabled,
    queryFn: () => fetchLab("/experiments", ExperimentListSchema, pipeline),
    queryKey: ["lab-experiments", pipeline],
    refetchInterval: 30_000,
    retry: false,
  });
  const captured = useMemo(
    () => experiments.data?.items.filter((run) => run.snapshot !== null) ?? [],
    [experiments.data?.items],
  );
  return { captured, experiments };
}

export function withExperiment(
  path: string,
  experimentId: string | null,
): string {
  if (experimentId === null) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}experiment=${encodeURIComponent(experimentId)}`;
}

export function ExperimentViewSelector({
  onChange,
  pipeline,
  ready = true,
  selectedId,
}: {
  onChange: (id: string | null) => void;
  pipeline?: string;
  ready?: boolean;
  selectedId: string | null;
}) {
  const { captured, experiments } = useExperimentRuns(pipeline, ready);
  const selectedRun = captured.find((run) => run.id === selectedId) ?? null;
  const rewardScore = selectedRun?.snapshot?.reward?.score;

  if (experiments.error || captured.length === 0) return null;
  return (
    <div className="experiment-view-selector">
      <label htmlFor="experiment-view">Experiment view</label>
      <select
        id="experiment-view"
        onChange={(event) =>
          onChange(event.target.value === "" ? null : event.target.value)
        }
        value={selectedId ?? ""}
      >
        <option value="">Live working state</option>
        {captured.map((run) => (
          <option key={run.id} value={run.id}>
            {run.snapshot?.isBest ? "BEST · " : ""}
            {run.name} · {run.id.slice(0, 8)}
          </option>
        ))}
      </select>
      <small title={selectedRun?.snapshot?.note ?? undefined}>
        {selectedRun === null
          ? "Mutable clustering tables"
          : `${selectedRun.snapshot?.note ?? "Frozen clustering snapshot"}${typeof rewardScore === "number" ? ` · R ${rewardScore.toFixed(6)}` : ""}`}
      </small>
    </div>
  );
}
