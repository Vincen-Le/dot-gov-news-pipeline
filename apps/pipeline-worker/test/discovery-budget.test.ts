import { describe, expect, it } from "vitest";

import {
  DiscoveryBudget,
  DiscoveryBudgetError,
} from "../src/discovery/discovery-budget";

describe("DiscoveryBudget", () => {
  it("enforces the cumulative publisher request cap", () => {
    const budget = new DiscoveryBudget(2, 1_000);
    budget.consumeRequest();
    budget.consumeRequest();
    expect(() => budget.consumeRequest()).toThrowError(DiscoveryBudgetError);
    expect(budget.requestCount).toBe(2);
  });

  it("enforces the overall deadline", () => {
    let time = 1_000;
    const budget = new DiscoveryBudget(36, 100, () => time);
    time = 1_101;
    expect(() => budget.remainingMs()).toThrow(/deadline/);
  });

  it("records the largest publisher response observed", () => {
    const budget = new DiscoveryBudget(2, 1_000);
    budget.observeResponseBytes(128);
    budget.observeResponseBytes(64);
    budget.observeResponseBytes(512);
    expect(budget.peakResponseBytes).toBe(512);
  });
});
