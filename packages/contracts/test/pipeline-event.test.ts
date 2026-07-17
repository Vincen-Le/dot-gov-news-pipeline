import { describe, expect, it } from "vitest";

import {
  PIPELINE_EVENT_SCHEMA_VERSION,
  parsePipelineEvent,
} from "../src/pipeline-event";

describe("parsePipelineEvent", () => {
  const event = {
    id: "8ae940f1-c65c-424c-97bd-c177d88320c3",
    schemaVersion: PIPELINE_EVENT_SCHEMA_VERSION,
    type: "infra.heartbeat",
    idempotencyKey: "infra.heartbeat:2026-07-17T16:00:00.000Z",
    occurredAt: "2026-07-17T16:00:00.000Z",
    payload: { source: "test" },
  };

  it("accepts a valid versioned event", () => {
    expect(parsePipelineEvent(event)).toEqual(event);
  });

  it("rejects malformed IDs", () => {
    expect(() => parsePipelineEvent({ ...event, id: "not-a-uuid" })).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parsePipelineEvent({ ...event, secret: "unexpected" }),
    ).toThrow();
  });

  it("rejects unsupported schema versions", () => {
    expect(() => parsePipelineEvent({ ...event, schemaVersion: 2 })).toThrow();
  });
});
