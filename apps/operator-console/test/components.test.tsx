import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NotEnabled, QueueTable } from "../src/ui/components";

describe("dashboard shared states", () => {
  it("explains capability prerequisites instead of showing zero", () => {
    render(
      <NotEnabled
        capability={{
          reason: "Polling state has not been implemented",
          status: "not_enabled",
        }}
        title="Polling observability is capability-gated"
      />,
    );
    expect(screen.getByText("Not enabled")).toBeInTheDocument();
    expect(screen.getByText(/has not been implemented/u)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("labels unavailable Queue metrics honestly", () => {
    render(
      <QueueTable
        queues={[
          {
            backlogBytes: null,
            backlogCount: null,
            name: "pipeline-events",
            observedAt: "2026-07-17T16:00:00.000Z",
            oldestMessageAt: null,
            state: "unavailable",
          },
        ]}
      />,
    );
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });
});
