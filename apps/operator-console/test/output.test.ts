import { describe, expect, it, vi } from "vitest";

import { formatAge, sinceTimestamp } from "../src/output";

describe("CLI output helpers", () => {
  it("converts bounded duration filters to timestamps", () => {
    vi.setSystemTime(new Date("2026-07-17T16:00:00.000Z"));
    expect(sinceTimestamp("30m")).toBe("2026-07-17T15:30:00.000Z");
    expect(sinceTimestamp("2h")).toBe("2026-07-17T14:00:00.000Z");
    vi.useRealTimers();
  });

  it("rejects ambiguous durations", () => {
    expect(() => sinceTimestamp("30 minutes")).toThrow(/suffix/u);
  });

  it("formats age without reporting future values as negative", () => {
    vi.setSystemTime(new Date("2026-07-17T16:00:00.000Z"));
    expect(formatAge("2026-07-17T15:59:30.000Z")).toBe("30s");
    expect(formatAge("2026-07-17T16:01:00.000Z")).toBe("0s");
    vi.useRealTimers();
  });
});
