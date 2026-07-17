import type { PipelineEvent } from "@dot-gov-news/contracts";
import { createClient } from "@supabase/supabase-js";

import type { WorkerEnv } from "../env";

export interface PipelineEventStore {
  upsert(event: PipelineEvent, artifactKey: string): Promise<void>;
}

export interface PipelineEventRow {
  artifact_key: string;
  event_type: string;
  id: string;
  idempotency_key: string;
  occurred_at: string;
  payload: Record<string, unknown>;
  schema_version: number;
}

export function buildPipelineEventRow(
  event: PipelineEvent,
  artifactKey: string,
): PipelineEventRow {
  return {
    artifact_key: artifactKey,
    event_type: event.type,
    id: event.id,
    idempotency_key: event.idempotencyKey,
    occurred_at: event.occurredAt,
    payload: event.payload,
    schema_version: event.schemaVersion,
  };
}

export function createSupabaseEventStore(
  env: Pick<WorkerEnv, "SUPABASE_SECRET_KEY" | "SUPABASE_URL">,
): PipelineEventStore {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  return {
    async upsert(event, artifactKey) {
      const { error } = await client
        .from("pipeline_events")
        .upsert(buildPipelineEventRow(event, artifactKey), {
          ignoreDuplicates: false,
          onConflict: "idempotency_key",
        });

      if (error !== null) {
        throw new Error(`Supabase upsert failed with code ${error.code}`);
      }
    },
  };
}
