import {
  OperatorErrorResponseSchema,
  operatorResponseSchema,
  type OperatorMeta,
} from "@dot-gov-news/contracts";
import type { z } from "zod";

export class BrowserApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BrowserApiError";
    this.code = code;
    this.status = status;
  }
}

export async function fetchOperator<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<{ data: T; meta: OperatorMeta }> {
  const response = await fetch(`/api${path}`, {
    headers: { accept: "application/json" },
    method: "GET",
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = OperatorErrorResponseSchema.safeParse(body);
    throw new BrowserApiError(
      response.status,
      parsed.success ? parsed.data.error.code : "invalid_error_response",
      parsed.success
        ? parsed.data.error.message
        : "The local operator proxy returned an invalid response",
    );
  }
  return operatorResponseSchema(schema).parse(body);
}
