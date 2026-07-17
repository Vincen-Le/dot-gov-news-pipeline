export type DiscoveryBudgetErrorCode =
  "deadline_exceeded" | "request_budget_exhausted";

export class DiscoveryBudgetError extends Error {
  readonly code: DiscoveryBudgetErrorCode;

  constructor(code: DiscoveryBudgetErrorCode) {
    super(
      code === "deadline_exceeded"
        ? "Discovery deadline exceeded"
        : "Publisher request budget exhausted",
    );
    this.name = "DiscoveryBudgetError";
    this.code = code;
  }
}

export class DiscoveryBudget {
  readonly deadlineAt: number;
  readonly maxRequests: number;
  #peakResponseBytes = 0;
  #requestCount = 0;
  readonly #now: () => number;

  constructor(
    maxRequests: number,
    deadlineMs: number,
    now: () => number = Date.now,
  ) {
    if (
      !Number.isSafeInteger(maxRequests) ||
      maxRequests < 1 ||
      maxRequests > 36
    ) {
      throw new Error("maxRequests must be between 1 and 36");
    }
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
      throw new Error("deadlineMs must be a positive integer");
    }
    this.maxRequests = maxRequests;
    this.#now = now;
    this.deadlineAt = now() + deadlineMs;
  }

  get requestCount(): number {
    return this.#requestCount;
  }

  get peakResponseBytes(): number {
    return this.#peakResponseBytes;
  }

  observeResponseBytes(bytes: number): void {
    if (Number.isSafeInteger(bytes) && bytes >= 0) {
      this.#peakResponseBytes = Math.max(this.#peakResponseBytes, bytes);
    }
  }

  remainingMs(): number {
    const remaining = this.deadlineAt - this.#now();
    if (remaining <= 0) throw new DiscoveryBudgetError("deadline_exceeded");
    return remaining;
  }

  consumeRequest(): void {
    this.remainingMs();
    if (this.#requestCount >= this.maxRequests) {
      throw new DiscoveryBudgetError("request_budget_exhausted");
    }
    this.#requestCount += 1;
  }
}
