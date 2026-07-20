import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { fetchPipelines, type PipelineInfo } from "./lab-api";

interface PipelineEnvironmentValue {
  engine: string | undefined;
  pipeline: string | undefined;
  pipelines: PipelineInfo[];
  ready: boolean;
  setPipeline: (pipeline: string) => void;
}

const PipelineEnvironmentContext = createContext<PipelineEnvironmentValue>({
  engine: undefined,
  pipeline: undefined,
  pipelines: [],
  ready: true,
  setPipeline: () => undefined,
});

const storageKey = "ops-evaluation-pipeline";

export function PipelineEnvironmentProvider({
  children,
}: {
  children: ReactNode;
}) {
  const registry = useQuery({
    queryFn: fetchPipelines,
    queryKey: ["lab-pipelines"],
    retry: false,
  });
  const [pipeline, setPipelineState] = useState<string | undefined>(
    () => localStorage.getItem(storageKey) ?? undefined,
  );

  useEffect(() => {
    if (registry.data === undefined) return;
    if (registry.data.length === 0) {
      setPipelineState(undefined);
      return;
    }
    if (!registry.data.some((entry) => entry.name === pipeline)) {
      const fallback = registry.data[0]?.name;
      setPipelineState(fallback);
      if (fallback !== undefined) localStorage.setItem(storageKey, fallback);
    }
  }, [pipeline, registry.data]);

  const value = useMemo<PipelineEnvironmentValue>(() => {
    const selected = registry.data?.find((entry) => entry.name === pipeline);
    return {
      engine: selected?.engine,
      pipeline,
      pipelines: registry.data ?? [],
      ready:
        !registry.isPending &&
        ((registry.data?.length ?? 0) === 0 || selected !== undefined),
      setPipeline: (next) => {
        setPipelineState(next);
        localStorage.setItem(storageKey, next);
      },
    };
  }, [pipeline, registry.data, registry.isPending]);

  return (
    <PipelineEnvironmentContext.Provider value={value}>
      {children}
    </PipelineEnvironmentContext.Provider>
  );
}

export function usePipelineEnvironment(): PipelineEnvironmentValue {
  return useContext(PipelineEnvironmentContext);
}

export function PipelineEnvironmentSelector() {
  const { engine, pipeline, pipelines, setPipeline } = usePipelineEnvironment();
  if (pipelines.length === 0 || pipeline === undefined) return null;
  return (
    <div className="pipeline-environment-selector">
      <div className="pipeline-environment-meta">
        <label htmlFor="pipeline-environment">Evaluation pipeline</label>
        <small>{engine}</small>
      </div>
      <select
        id="pipeline-environment"
        onChange={(event) => setPipeline(event.currentTarget.value)}
        value={pipeline}
      >
        {pipelines.map((entry) => (
          <option key={entry.name} value={entry.name}>
            {entry.name} ({entry.engine})
          </option>
        ))}
      </select>
    </div>
  );
}
