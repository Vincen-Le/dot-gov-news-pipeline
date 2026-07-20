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
    const nextButton = screen.getByRole("button", { name: "Next date" });

    expect(track?.contains(endDate)).toBe(true);
    expect(track?.contains(nextButton)).toBe(false);
  });

  it("snaps to whole dates while the thumb is being dragged", () => {
    const onChange = vi.fn();
    const view = render(
      <DateNavigator
        asOf="2025-07-18"
        maximum="2025-07-29"
        minimum="2025-07-18"
        onChange={onChange}
      />,
    );
    const slider = screen.getByRole("slider") as HTMLInputElement;
    const dragValue = view.container.querySelector(".date-drag-value");

    expect(slider.step).toBe("1");
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "2.1" } });
    fireEvent.change(slider, { target: { value: "2.4" } });

    expect(slider.value).toBe("2");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("2025-07-20");
    expect(dragValue?.textContent).toContain("Jul 20, 2025");

    fireEvent.change(slider, { target: { value: "2.6" } });

    expect(slider.value).toBe("3");
    expect(onChange).toHaveBeenLastCalledWith("2025-07-21");
    expect(dragValue?.textContent).toContain("Jul 21, 2025");
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
    const slider = screen.getByRole("slider") as HTMLInputElement;
    const previous = screen.getByRole("button", { name: "Previous date" });
    const next = screen.getByRole("button", { name: "Next date" });

    expect((previous as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Advance date/u)).toBeNull();

    fireEvent.click(next);
    expect(slider.value).toBe("0");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("2025-07-19");
    expect((next as HTMLButtonElement).disabled).toBe(false);

    clock.advance(0);
    clock.advance(0);
    clock.advance(180);
    expect(Number(slider.value)).toBeGreaterThan(0);
    expect(Number(slider.value)).toBeLessThan(1);

    fireEvent.click(next);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("2025-07-20");

    clock.advance(180);
    clock.advance(180);
    clock.advance(540);
    expect(slider.value).toBe("2");
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

    expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("0");
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe(
      "Jul 18, 2025",
    );
  });
});
