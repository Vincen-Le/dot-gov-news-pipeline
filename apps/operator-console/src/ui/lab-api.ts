import type { z } from "zod";

export class LabApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "LabApiError";
    this.code = code;
    this.status = status;
  }
}

async function parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = body as { error?: { code?: string; message?: string } };
    throw new LabApiError(
      response.status,
      parsed.error?.code ?? "lab_error",
      parsed.error?.message ?? "Lab request failed",
    );
  }
  return schema.parse((body as { data: unknown }).data);
}

export async function fetchLab<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`/api/lab${path}`, {
    headers: { accept: "application/json" },
  });
  return parse(response, schema);
}

export async function postLab<T>(
  path: string,
  payload: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`/api/lab${path}`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return parse(response, schema);
}
