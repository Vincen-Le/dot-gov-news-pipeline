import type {
  OperatorErrorResponse,
  OperatorResponse,
} from "@dot-gov-news/contracts";

const responseHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

export class HttpError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    status: number,
    code: string,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export function jsonResponse<T>(
  body: OperatorResponse<T>,
  status = 200,
): Response {
  return Response.json(body, { headers: responseHeaders, status });
}

export function errorResponse(error: unknown): Response {
  const safe =
    error instanceof HttpError
      ? error
      : new HttpError(
          503,
          "provider_unavailable",
          "A required provider is unavailable",
          true,
        );
  const body: OperatorErrorResponse = {
    error: {
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
    },
    meta: { generatedAt: new Date().toISOString() },
  };

  return Response.json(body, { headers: responseHeaders, status: safe.status });
}

export function parseQuery(url: URL): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key)) {
      throw new HttpError(400, "invalid_query", "Duplicate query parameter");
    }
    values[key] = value;
  }

  return values;
}
