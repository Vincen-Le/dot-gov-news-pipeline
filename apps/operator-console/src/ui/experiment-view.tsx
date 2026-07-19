import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { z } from "zod";

import { ExperimentRunSchema, type ExperimentRun } from "../lab/contracts";
import { fetchLab } from "./lab-api";

const ExperimentListSchema = z.object({
  active: z.unknown().nullable(),
  items: ExperimentRunSchema.array(),
});

interface ExperimentViewValue {
  selectedId: string | null;
  selectedRun: ExperimentRun | null;
  setSelectedId: (id: string | null) => void;
}

const ExperimentViewContext = createContext<ExperimentViewValue>({
  selectedId: null,
  selectedRun: null,
  setSelectedId: () => undefined,
});

const storageKey = "ops-experiment-view";

export function ExperimentViewProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedIdState] = useState<string | null | undefined>(
    () => {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? undefined : stored === "live" ? null : stored;
    },
  );
  const experiments = useQuery({
    queryFn: () => fetchLab("/experiments", ExperimentListSchema),
    queryKey: ["lab-experiments"],
    refetchInterval: 30_000,
    retry: false,
  });
  const captured = useMemo(
    () => experiments.data?.items.filter((run) => run.snapshot !== null) ?? [],
    [experiments.data?.items],
  );

  useEffect(() => {
    if (experiments.data === undefined) return;
    if (selectedId === undefined) {
      setSelectedIdState(
        captured.find((run) => run.snapshot?.isBest)?.id ?? null,
      );
      return;
    }
    if (selectedId !== null && !captured.some((run) => run.id === selectedId)) {
      setSelectedIdState(
        captured.find((run) => run.snapshot?.isBest)?.id ?? null,
      );
    }
  }, [captured, experiments.data, selectedId]);

  const setSelectedId = (id: string | null): void => {
    setSelectedIdState(id);
    localStorage.setItem(storageKey, id ?? "live");
  };
  const selectedRun =
    selectedId === undefined || selectedId === null
      ? null
      : (captured.find((run) => run.id === selectedId) ?? null);

  return (
    <ExperimentViewContext.Provider
      value={{
        selectedId: selectedId ?? null,
        selectedRun,
        setSelectedId,
      }}
    >
      {children}
    </ExperimentViewContext.Provider>
  );
}

export function useExperimentView(): ExperimentViewValue {
  return useContext(ExperimentViewContext);
}

export function withExperiment(
  path: string,
  experimentId: string | null,
): string {
  if (experimentId === null) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}experiment=${encodeURIComponent(experimentId)}`;
}

export function ExperimentViewSelector() {
  const { selectedId, selectedRun, setSelectedId } = useExperimentView();
  const experiments = useQuery({
    queryFn: () => fetchLab("/experiments", ExperimentListSchema),
    queryKey: ["lab-experiments"],
    refetchInterval: 30_000,
    retry: false,
  });
  const captured =
    experiments.data?.items.filter((run) => run.snapshot !== null) ?? [];
  const rewardScore = selectedRun?.snapshot?.reward?.score;

  if (experiments.error || captured.length === 0) return null;
  return (
    <div className="experiment-view-selector">
      <label htmlFor="experiment-view">Experiment view</label>
      <select
        id="experiment-view"
        onChange={(event) =>
          setSelectedId(event.target.value === "" ? null : event.target.value)
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
