import {
  parsePipelineEvent,
  type PipelineEvent,
} from "@dot-gov-news/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPipelineEventRow,
  type PipelineEventStore,
} from "../src/clients/supabase";
import type { WorkerEnv } from "../src/env";
import { handleHealth } from "../src/handlers/health";
import {
  artifactKeyForEvent,
  processQueueMessage,
} from "../src/handlers/queue";
import {
  createHeartbeatEvent,
  createScheduledHeartbeatEvent,
  handleScheduled,
} from "../src/handlers/scheduled";

const scheduledTime = Date.parse("2026-07-17T16:00:00.000Z");
const eventId = "8ae940f1-c65c-424c-97bd-c177d88320c3";

function makeEvent(): PipelineEvent {
  return createHeartbeatEvent(scheduledTime, eventId);
}

function makeMessage(
  body: unknown,
  attempts = 1,
): Message<unknown> & {
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  return {
    ack: vi.fn(),
    attempts,
    body,
    id: "queue-message-id",
    retry: vi.fn(),
    timestamp: new Date(scheduledTime),
  } as unknown as Message<unknown> & {
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
}

function makeEnv(): WorkerEnv & {
  ARTIFACTS: R2Bucket & { put: ReturnType<typeof vi.fn> };
  PIPELINE_EVENTS_QUEUE: Queue<PipelineEvent> & {
    send: ReturnType<typeof vi.fn>;
  };
} {
  return {
    ARTIFACTS: {
      put: vi.fn().mockResolvedValue({}),
    } as unknown as R2Bucket & { put: ReturnType<typeof vi.fn> },
    BUILD_VERSION: "test-build",
    DISCOVERY_CLAIM_LIMIT: "1",
    DISCOVERY_CONTACT: "",
    DISCOVERY_ENABLED: "false",
    DISCOVERY_LEASE_SECONDS: "900",
    DISCOVERY_MAX_DELAY_SECONDS: "30",
    DISCOVERY_MAX_PUBLISHER_REQUESTS: "36",
    DISCOVERY_POLICY_VERSION: "1",
    DISCOVERY_QUEUE_HIGH_WATER: "1",
    DISCOVERY_SITE_DEADLINE_SECONDS: "600",
    PIPELINE_EVENTS_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue<PipelineEvent> & {
      send: ReturnType<typeof vi.fn>;
    },
    SITE_DISCOVERY_QUEUE: {
      metrics: vi.fn().mockResolvedValue({ backlogCount: 0 }),
      sendBatch: vi.fn().mockResolvedValue({}),
    } as unknown as Queue,
    SUPABASE_SECRET_KEY: "sb_secret_test_value",
    SUPABASE_URL: "https://project.supabase.co",
  };
}

function makeEventStore(): PipelineEventStore & {
  upsert: ReturnType<typeof vi.fn>;
} {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
  };
}

describe("infrastructure heartbeat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a stable versioned event for a scheduled time", () => {
    expect(makeEvent()).toEqual({
      id: eventId,
      idempotencyKey: "infra.heartbeat:2026-07-17T16:00:00.000Z",
      occurredAt: "2026-07-17T16:00:00.000Z",
      payload: { source: "cloudflare-cron" },
      schemaVersion: 1,
      type: "infra.heartbeat",
    });
  });

  it("derives the same UUID for duplicate cron deliveries", async () => {
    const first = await createScheduledHeartbeatEvent(scheduledTime);
    const duplicate = await createScheduledHeartbeatEvent(scheduledTime);

    expect(first.id).toBe(duplicate.id);
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.idempotencyKey).toBe(
      "infra.heartbeat:2026-07-17T16:00:00.000Z",
    );
  });

  it("publishes a schema-valid heartbeat from the scheduled handler", async () => {
    const env = makeEnv();
    const controller = {
      cron: "0 * * * *",
      noRetry: vi.fn(),
      scheduledTime,
      type: "scheduled",
    } as unknown as ScheduledController;

    await handleScheduled(controller, env);

    expect(env.PIPELINE_EVENTS_QUEUE.send).toHaveBeenCalledOnce();
    expect(env.PIPELINE_EVENTS_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "infra.heartbeat:2026-07-17T16:00:00.000Z",
        type: "infra.heartbeat",
      }),
      { contentType: "json" },
    );
  });

  it("routes the minute Cron to a disabled discovery dispatcher", async () => {
    const env = makeEnv();
    const controller = {
      cron: "* * * * *",
      noRetry: vi.fn(),
      scheduledTime,
      type: "scheduled",
    } as unknown as ScheduledController;

    await handleScheduled(controller, env);

    expect(env.PIPELINE_EVENTS_QUEUE.send).not.toHaveBeenCalled();
  });

  it("rejects unconfigured Cron expressions", async () => {
    const controller = {
      cron: "17 4 * * *",
      noRetry: vi.fn(),
      scheduledTime,
      type: "scheduled",
    } as unknown as ScheduledController;
    await expect(handleScheduled(controller, makeEnv())).rejects.toThrow(
      /Unsupported Cron/,
    );
  });

  it("uses a deterministic artifact key", () => {
    expect(artifactKeyForEvent(makeEvent())).toBe(`health/${eventId}.json`);
  });

  it("writes both durable stores before acknowledging", async () => {
    const env = makeEnv();
    const message = makeMessage(makeEvent());
    const eventStore = makeEventStore();

    await processQueueMessage(message, env, eventStore);

    expect(env.ARTIFACTS.put).toHaveBeenCalledWith(
      `health/${eventId}.json`,
      JSON.stringify(parsePipelineEvent(makeEvent())),
      expect.objectContaining({
        httpMetadata: { contentType: "application/json" },
      }),
    );
    expect(eventStore.upsert).toHaveBeenCalledWith(
      makeEvent(),
      `health/${eventId}.json`,
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries without acknowledging when Supabase fails", async () => {
    const env = makeEnv();
    const message = makeMessage(makeEvent(), 2);
    const eventStore = makeEventStore();
    eventStore.upsert.mockRejectedValue(new Error("database unavailable"));

    await processQueueMessage(message, env, eventStore);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 2 });
  });

  it("retries without writing Supabase when R2 fails", async () => {
    const env = makeEnv();
    env.ARTIFACTS.put.mockRejectedValue(new Error("R2 unavailable"));
    const message = makeMessage(makeEvent());
    const eventStore = makeEventStore();

    await processQueueMessage(message, env, eventStore);

    expect(eventStore.upsert).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
  });

  it("retries malformed queue messages", async () => {
    const env = makeEnv();
    const message = makeMessage({ id: "malformed" });
    const eventStore = makeEventStore();

    await processQueueMessage(message, env, eventStore);

    expect(env.ARTIFACTS.put).not.toHaveBeenCalled();
    expect(eventStore.upsert).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it("maps events to idempotent Supabase rows", () => {
    expect(
      buildPipelineEventRow(makeEvent(), `health/${eventId}.json`),
    ).toEqual({
      artifact_key: `health/${eventId}.json`,
      event_type: "infra.heartbeat",
      id: eventId,
      idempotency_key: "infra.heartbeat:2026-07-17T16:00:00.000Z",
      occurred_at: "2026-07-17T16:00:00.000Z",
      payload: { source: "cloudflare-cron" },
      schema_version: 1,
    });
  });

  it("returns health without exposing secrets", async () => {
    const env = makeEnv();
    const response = handleHealth(
      new Request("https://worker.example/health"),
      env,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"status":"ok"');
    expect(body).toContain('"buildVersion":"test-build"');
    expect(body).toContain(
      '"discovery":{"configValid":true,"contactConfigured":false,"enabled":false}',
    );
    expect(body).not.toContain(env.SUPABASE_SECRET_KEY);
    expect(body).not.toContain(env.SUPABASE_URL);
  });

  it("rejects unknown HTTP routes", () => {
    const response = handleHealth(
      new Request("https://worker.example/not-health"),
      makeEnv(),
    );

    expect(response.status).toBe(404);
  });
});
