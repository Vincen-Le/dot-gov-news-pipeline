import { z } from "zod";

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

/** No pipeline selected → the env-only default mount (today's behavior,
 * unchanged); a selected pipeline routes to its own registered connection
 * (src/server.ts mounts one router per config/pipelines.json entry). */
export function labBasePath(pipeline?: string): string {
  return pipeline === undefined
    ? "/api/lab"
    : `/api/lab/p/${encodeURIComponent(pipeline)}`;
}

export async function fetchLab<T>(
  path: string,
  schema: z.ZodType<T>,
  pipeline?: string,
): Promise<T> {
  const response = await fetch(`${labBasePath(pipeline)}${path}`, {
    headers: { accept: "application/json" },
  });
  return parse(response, schema);
}

export async function postLab<T>(
  path: string,
  payload: unknown,
  schema: z.ZodType<T>,
  pipeline?: string,
): Promise<T> {
  const response = await fetch(`${labBasePath(pipeline)}${path}`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return parse(response, schema);
}

const PipelineInfoSchema = z.object({ engine: z.string(), name: z.string() });
const PipelineListSchema = z.object({ pipelines: PipelineInfoSchema.array() });
export type PipelineInfo = z.infer<typeof PipelineInfoSchema>;

export async function fetchPipelines(): Promise<PipelineInfo[]> {
  const response = await fetch("/api/pipelines", {
    headers: { accept: "application/json" },
  });
  const data = await parse(response, PipelineListSchema);
  return data.pipelines;
}
