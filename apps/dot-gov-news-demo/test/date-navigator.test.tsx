import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
});
