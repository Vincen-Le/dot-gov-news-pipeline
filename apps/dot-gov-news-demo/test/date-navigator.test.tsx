import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import { App } from "../src/App";
import { DateNavigator } from "../src/DateNavigator";

afterEach(cleanup);

describe("date navigator", () => {
  it("keeps the ending date aligned to the end of the range track", () => {
    const view = render(
      <DateNavigator
        asOf="2025-07-18"
        maximum="2025-07-29"
        minimum="2025-07-18"
        onChange={vi.fn()}
      />,
    );

    const track = view.container.querySelector(".date-track");
    const endDate = screen.getByText("Jul 29, 2025");
    const button = screen.getByRole("button", { name: /Advance date/u });

    expect(track?.contains(endDate)).toBe(true);
    expect(track?.contains(button)).toBe(false);
  });

  it("moves continuously while emitting only crossed day boundaries", () => {
    const onChange = vi.fn();
    render(
      <DateNavigator
        asOf="2025-07-18"
        maximum="2025-07-29"
        minimum="2025-07-18"
        onChange={onChange}
      />,
    );
    const slider = screen.getByRole("slider") as HTMLInputElement;

    expect(slider.step).toBe("any");
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "2.1" } });
    fireEvent.change(slider, { target: { value: "2.4" } });

    expect(slider.value).toBe("2.4");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("2025-07-20");

    fireEvent.pointerUp(slider);
    expect(slider.value).toBe("2");
  });

  it("starts the app on day zero when the timeline bounds load", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["storylines"], {
      hasMore: false,
      items: [
        {
          agencies: ["fema"],
          categoryName: "Disaster Response & Emergency",
          distinctFeeds: 1,
          entities: [],
          entryCount: 1,
          episodeCount: 1,
          eventKeys: [],
          firstEntryAt: "2025-07-18T12:00:00.000Z",
          firstOverviewAt: null,
          headline: null,
          id: "00000000-0000-4000-8000-000000000001",
          newestEntryAt: "2025-07-29T12:00:00.000Z",
          rankKey: null,
          themeId: null,
          themeName: null,
          unreviewedEntryCount: 0,
        },
      ],
    });
    client.setQueryData(["agencies"], { agencies: [] });
    client.setQueryData(["categories"], { categories: [] });
    client.setQueryData(["themes"], { themes: [] });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("0");
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe(
      "Jul 18, 2025",
    );
  });
});
