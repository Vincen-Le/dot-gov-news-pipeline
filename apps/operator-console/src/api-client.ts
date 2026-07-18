import {
  CapabilitiesDataSchema,
  GovernmentSiteListDataSchema,
  HealthDataSchema,
  InventoryRunListDataSchema,
  InventorySummaryDataSchema,
  OperatorErrorResponseSchema,
  OverviewDataSchema,
  PipelineEventListDataSchema,
  QueueListDataSchema,
  SiteInspectorDataSchema,
  operatorResponseSchema,
  type OperatorMeta,
} from "@dot-gov-news/contracts";
import type { z } from "zod";

import type { RequiredOperatorConsoleConfig } from "./config";

export class OperatorApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    status: number,
    code: string,
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.name = "OperatorApiError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function appendQuery(
  path: string,
  query: Record<string, boolean | number | string | undefined> = {},
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded.length === 0 ? path : `${path}?${encoded}`;
}

export class OperatorApiClient {
  readonly #config: RequiredOperatorConsoleConfig;

  constructor(config: RequiredOperatorConsoleConfig) {
    this.#config = config;
  }

  async raw(path: string): Promise<Response> {
    const url = new URL(path, `${this.#config.apiUrl.replace(/\/$/u, "")}/`);
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.#config.apiToken}`,
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const parsed = OperatorErrorResponseSchema.safeParse(
        await response.json(),
      );
      if (parsed.success) {
        throw new OperatorApiError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.retryable,
        );
      }
      throw new OperatorApiError(
        response.status,
        "invalid_error_response",
        "Operator API returned an invalid error response",
        false,
      );
    }
    return response;
  }

  async request<T>(
    path: string,
    dataSchema: z.ZodType<T>,
  ): Promise<{ data: T; meta: OperatorMeta }> {
    const response = await this.raw(path);
    return operatorResponseSchema(dataSchema).parse(await response.json());
  }

  capabilities() {
    return this.request("/ops/v1/capabilities", CapabilitiesDataSchema);
  }

  overview() {
    return this.request("/ops/v1/overview", OverviewDataSchema);
  }

  health(depth: "shallow" | "deep" = "shallow") {
    return this.request(
      appendQuery("/ops/v1/system/health", { depth }),
      HealthDataSchema,
    );
  }

  queues() {
    return this.request("/ops/v1/queues", QueueListDataSchema);
  }

  inventorySummary() {
    return this.request(
      "/ops/v1/inventory/summary",
      InventorySummaryDataSchema,
    );
  }

  inventoryRuns(
    query: {
      cursor?: string;
      limit?: number;
      status?: string;
    } = {},
  ) {
    return this.request(
      appendQuery("/ops/v1/inventory/runs", query),
      InventoryRunListDataSchema,
    );
  }

  inventorySites(
    query: {
      active?: boolean;
      agency?: string;
      all?: boolean;
      cursor?: string;
      hostname?: string;
      limit?: number;
    } = {},
  ) {
    return this.request(
      appendQuery("/ops/v1/inventory/sites", query),
      GovernmentSiteListDataSchema,
    );
  }

  events(
    query: {
      cursor?: string;
      entity?: string;
      limit?: number;
      since?: string;
      type?: string;
    } = {},
  ) {
    return this.request(
      appendQuery("/ops/v1/events", query),
      PipelineEventListDataSchema,
    );
  }

  site(hostname: string) {
    return this.request(
      `/ops/v1/sites/${encodeURIComponent(hostname)}`,
      SiteInspectorDataSchema,
    );
  }
}
