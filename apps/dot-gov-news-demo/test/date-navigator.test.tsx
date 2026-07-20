import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import { App } from "../src/App";
import { DateNavigator } from "../src/DateNavigator";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function installAnimationClock() {
  let nextId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId;
    nextId += 1;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });

  return {
    advance(time: number) {
      const next = frames.entries().next().value as
        [number, FrameRequestCallback] | undefined;
      if (next === undefined) throw new Error("No animation frame scheduled");
      frames.delete(next[0]);
      act(() => next[1](time));
    },
  };
}

describe("date navigator", () => {
  it("shows nearby dates as selectable carousel items", () => {
    const view = render(
      <DateNavigator
        asOf="2025-07-18"
        maximum="2025-07-29"
        minimum="2025-07-18"
        onChange={vi.fn()}
      />,
    );

    const carousel = view.container.querySelector(".date-carousel");
    const currentDate = screen.getByRole("button", { name: "Jul 18, 2025" });
    const nearbyDate = screen.getByRole("button", { name: "Jul 24, 2025" });
    const nextButton = screen.getByRole("button", { name: "Next date" });

    expect(carousel?.contains(currentDate)).toBe(true);
    expect(carousel?.contains(nearbyDate)).toBe(true);
    expect(carousel?.contains(nextButton)).toBe(false);
    expect(currentDate.getAttribute("aria-pressed")).toBe("true");
  });

  it("selects a specific date directly from the carousel", () => {
    installAnimationClock();
    const onChange = vi.fn();
    render(
      <DateNavigator
        asOf="2025-07-18"
        maximum="2025-07-29"
        minimum="2025-07-18"
        onChange={onChange}
      />,
    );
    const targetDate = screen.getByRole("button", { name: "Jul 20, 2025" });
    fireEvent.click(targetDate);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("2025-07-20");
    expect(targetDate.getAttribute("aria-pressed")).toBe("true");
  });

  it("updates immediately while smoothly retargeting consecutive arrow clicks", () => {
    const clock = installAnimationClock();
    const onChange = vi.fn();
    render(
      <DateNavigator
        asOf="2025-07-18"
        maximum="2025-07-29"
        minimum="2025-07-18"
        onChange={onChange}
      />,
    );
    const previous = screen.getByRole("button", { name: "Previous date" });
    const next = screen.getByRole("button", { name: "Next date" });

    expect((previous as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Advance date/u)).toBeNull();

    fireEvent.click(next);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("2025-07-19");
    expect((next as HTMLButtonElement).disabled).toBe(false);
    const july19 = screen.getByRole("button", { name: "Jul 19, 2025" });
    expect(july19.getAttribute("aria-pressed")).toBe("true");
    expect(july19.style.getPropertyValue("--date-offset")).toBe("112px");

    clock.advance(0);
    clock.advance(0);
    clock.advance(180);
    const movingOffset = Number.parseFloat(
      july19.style.getPropertyValue("--date-offset"),
    );
    expect(movingOffset).toBeGreaterThan(0);
    expect(movingOffset).toBeLessThan(112);

    fireEvent.click(next);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("2025-07-20");

    clock.advance(180);
    clock.advance(180);
    clock.advance(540);
    const july20 = screen.getByRole("button", { name: "Jul 20, 2025" });
    expect(july20.getAttribute("aria-pressed")).toBe("true");
    expect(july20.style.getPropertyValue("--date-offset")).toBe("0px");
  });

  it("starts the app on day zero when the timeline bounds load", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["bootstrap"], {
      agencies: [],
      categories: [],
      previews: [],
      storylines: {
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
      },
      themes: [],
    });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      screen
        .getByRole("button", { name: "Jul 18, 2025" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
