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
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

  return {
    advance(time: number) {
      const frame = frames.shift();
      if (frame === undefined) throw new Error("No animation frame scheduled");
      act(() => frame(time));
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

  it("moves continuously, ticks at crossed dates, and settles smoothly", () => {
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

    expect(slider.step).toBe("any");
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "2.1" } });
    fireEvent.change(slider, { target: { value: "2.4" } });

    expect(slider.value).toBe("2.4");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("2025-07-20");

    fireEvent.pointerUp(slider);
    expect(slider.value).toBe("2.4");
    clock.advance(0);
    clock.advance(0);
    clock.advance(110);
    expect(Number(slider.value)).toBeGreaterThan(2);
    expect(Number(slider.value)).toBeLessThan(2.4);
    clock.advance(220);
    expect(slider.value).toBe("2");
  });

  it("replaces the advance action with arrows that glide to each date", () => {
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
    expect(onChange).not.toHaveBeenCalled();
    clock.advance(0);
    clock.advance(230);
    expect(Number(slider.value)).toBeGreaterThan(0);
    expect(Number(slider.value)).toBeLessThan(1);
    expect((next as HTMLButtonElement).disabled).toBe(true);

    clock.advance(460);
    expect(slider.value).toBe("1");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("2025-07-19");
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
