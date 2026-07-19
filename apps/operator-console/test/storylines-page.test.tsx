// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StorylinesPage } from "../src/ui/pages/StorylinesPage";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  // vitest globals are off, so testing-library's auto-cleanup never registers
  cleanup();
  vi.restoreAllMocks();
});

function renderPage(initialEntry = "/storylines"): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <StorylinesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const METRICS_PAYLOAD = {
  data: {
    attachMix: [],
    calibration: {
      pairCount: 0,
      percentiles: {},
      suggestedNearDupThreshold: null,
    },
    capturedAt: "2026-07-18T12:00:00.000Z",
    entriesPerEpisode: [],
    episodesPerStoryline: [],
    similarity: [],
    singletonEpisodeRate: null,
    storylineAttachMix: [],
    syndicationRate: null,
    topChains: [],
    volume: {
      cards: 4,
      entries: 12,
      episodes: 3,
      multiEpisodeStorylines: 1,
      storylines: 2,
    },
  },
};

const STORYLINES_PAYLOAD = {
  data: {
    hasMore: false,
    items: [
      {
        agencies: ["fda"],
        categoryName: "Food & Drug Safety",
        distinctFeeds: 2,
        entities: ["valsatrex"],
        entryCount: 5,
        episodeCount: 2,
        eventKeys: ["z-2026-0143"],
        firstEntryAt: "2026-05-14T14:00:00.000Z",
        headline: "Valsatrex recall chain",
        id: "00000000-0000-4000-8000-000000000021",
        newestEntryAt: "2026-05-17T15:00:00.000Z",
        themeId: "00000000-0000-4000-8000-0000000000d1",
        themeName: "Valsatrex recall fallout",
      },
    ],
  },
};

const STORYLINES_PAGE_2_PAYLOAD = {
  data: {
    hasMore: false,
    items: [
      {
        agencies: ["ssa.gov"],
        categoryName: null,
        distinctFeeds: 1,
        entities: ["tulsa"],
        entryCount: 1,
        episodeCount: 1,
        eventKeys: [],
        firstEntryAt: "2026-05-18T09:00:00.000Z",
        headline: "SSA opens Tulsa office",
        id: "00000000-0000-4000-8000-000000000022",
        newestEntryAt: "2026-05-18T09:00:00.000Z",
        themeId: null,
        themeName: null,
      },
    ],
  },
};

const AGENCIES_PAYLOAD = {
  data: { agencies: ["cdc", "fda"] },
};

const CATEGORIES_PAYLOAD = {
  data: {
    categories: [
      {
        displayName: "Food & Drug Safety",
        id: "00000000-0000-4000-8000-0000000000c1",
        origin: "seed",
        proposalReason: null,
        themeCount: 1,
      },
      {
        displayName: "Test LLM Category",
        id: "00000000-0000-4000-8000-0000000000c9",
        origin: "llm",
        proposalReason: "proposed by classifier",
        themeCount: 0,
      },
    ],
  },
};

const THEMES_PAYLOAD = {
  data: {
    themes: [
      {
        categoryId: "00000000-0000-4000-8000-0000000000c1",
        categoryName: "Food & Drug Safety",
        categoryOrigin: "seed",
        displayName: "Valsatrex recall fallout",
        id: "00000000-0000-4000-8000-0000000000d1",
        newestStorylineAt: "2026-05-17T15:00:00.000Z",
        storylineCount: 1,
      },
    ],
  },
};

function mockFetchRoutes(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/lab/capability")) {
        return jsonResponse({
          data: { experimentsEnabled: true, status: "available" },
        });
      }
      if (url.includes("/api/lab/metrics")) {
        return jsonResponse(METRICS_PAYLOAD);
      }
      if (url.includes("/api/lab/agencies")) {
        return jsonResponse(AGENCIES_PAYLOAD);
      }
      if (url.includes("/api/lab/topics/categories")) {
        return jsonResponse(CATEGORIES_PAYLOAD);
      }
      if (url.includes("/api/lab/topics/themes")) {
        return jsonResponse(THEMES_PAYLOAD);
      }
      return jsonResponse(STORYLINES_PAYLOAD);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("StorylinesPage", () => {
  it("renders chains from the lab api", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/lab/capability")) {
          return jsonResponse({
            data: { experimentsEnabled: true, status: "available" },
          });
        }
        if (url.includes("/api/lab/metrics")) {
          return jsonResponse(METRICS_PAYLOAD);
        }
        if (url.includes("/api/lab/agencies")) {
          return jsonResponse(AGENCIES_PAYLOAD);
        }
        return jsonResponse(STORYLINES_PAYLOAD);
      }),
    );
    renderPage();
    expect(
      await screen.findByText("Valsatrex recall chain"),
    ).toBeInTheDocument();
    expect(await screen.findByText("z-2026-0143")).toBeInTheDocument();
  });

  it("offers an agency quick filter and episode-count sort", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/lab/capability")) {
        return jsonResponse({
          data: { experimentsEnabled: true, status: "available" },
        });
      }
      if (url.includes("/api/lab/metrics")) {
        return jsonResponse(METRICS_PAYLOAD);
      }
      if (url.includes("/api/lab/agencies")) {
        return jsonResponse(AGENCIES_PAYLOAD);
      }
      return jsonResponse(STORYLINES_PAYLOAD);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/storylines?sort=episodes");
    // agency dropdown lists the filterable agency ids
    expect(
      await screen.findByRole("option", { name: "fda" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "cdc" })).toBeInTheDocument();
    expect(screen.getByLabelText("Agency")).toHaveValue("");
    // sort param round-trips: select reflects it, the api call carries it
    expect(screen.getByLabelText("Sort")).toHaveValue("episodes");
    await screen.findByText("Valsatrex recall chain");
    const storylineCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/api/lab/storylines"));
    expect(storylineCalls.at(0)).toContain("sort=episodes");
  });

  it("pages through chains with next and previous", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/lab/capability")) {
        return jsonResponse({
          data: { experimentsEnabled: true, status: "available" },
        });
      }
      if (url.includes("/api/lab/metrics")) {
        return jsonResponse(METRICS_PAYLOAD);
      }
      if (url.includes("/api/lab/agencies")) {
        return jsonResponse(AGENCIES_PAYLOAD);
      }
      if (url.includes("offset=50")) {
        return jsonResponse(STORYLINES_PAGE_2_PAYLOAD);
      }
      return jsonResponse({
        data: { ...STORYLINES_PAYLOAD.data, hasMore: true },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await screen.findByText("Valsatrex recall chain");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("SSA opens Tulsa office")).toBeInTheDocument();
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    const storylineCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/api/lab/storylines"));
    expect(storylineCalls.at(-1)).toContain("offset=50");
  });

  it("renders category and theme filters with llm origin badges", async () => {
    mockFetchRoutes();
    renderPage();
    expect(await screen.findByLabelText("Category")).toBeTruthy();
    expect(await screen.findByLabelText("Theme")).toBeTruthy();
    // llm-origin categories are visibly marked for auditability
    expect(
      await screen.findByText("Test LLM Category (LLM)"),
    ).toBeTruthy();
    expect(
      screen.getByRole("columnheader", { name: "Category" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Food & Drug Safety")).not.toHaveLength(0);
  });

  it("shows the theme chip on storyline rows and filters the api call", async () => {
    const fetchMock = mockFetchRoutes();
    renderPage(
      "/storylines?theme=00000000-0000-4000-8000-0000000000d1",
    );
    // theme chip on the row (the Theme column renders the storyline's theme)
    expect(
      await screen.findAllByText("Valsatrex recall fallout"),
    ).not.toHaveLength(0);
    // theme param round-trips into the storylines api call
    const storylineCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/api/lab/storylines"));
    expect(storylineCalls.at(0)).toContain(
      "theme=00000000-0000-4000-8000-0000000000d1",
    );
  });

  it("groups rows by theme and round-trips the grouping in the api call", async () => {
    const fetchMock = mockFetchRoutes();
    renderPage("/storylines?groupBy=theme");

    expect(await screen.findByLabelText("Group by")).toHaveValue("theme");
    expect(
      await screen.findByText("Valsatrex recall fallout", {
        selector: ".storyline-group-row strong",
      }),
    ).toBeInTheDocument();

    const storylineCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/api/lab/storylines"));
    expect(storylineCalls.at(0)).toContain("groupBy=theme");
  });

  it("groups rows by category", async () => {
    mockFetchRoutes();
    renderPage("/storylines?groupBy=category");

    expect(await screen.findByLabelText("Group by")).toHaveValue("category");
    expect(
      await screen.findByText("Food & Drug Safety", {
        selector: ".storyline-group-row strong",
      }),
    ).toBeInTheDocument();
  });

  it("renders the not-enabled state honestly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/lab/capability")) {
          return jsonResponse({
            data: {
              experimentsEnabled: false,
              reason: "Set DATABASE_URL",
              status: "not_enabled",
            },
          });
        }
        return new Response(
          JSON.stringify({
            error: { code: "not_enabled", message: "Set DATABASE_URL" },
          }),
          { status: 503 },
        );
      }),
    );
    renderPage();
    expect(await screen.findByText(/Set DATABASE_URL/)).toBeInTheDocument();
  });
});
