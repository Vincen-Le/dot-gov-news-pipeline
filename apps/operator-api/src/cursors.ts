import { z } from "zod";

const TimedCursorSchema = z
  .object({
    id: z.string().uuid(),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();

export type TimedCursor = z.infer<typeof TimedCursorSchema>;

export function encodeCursor(value: TimedCursor): string {
  return btoa(JSON.stringify(TimedCursorSchema.parse(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeCursor(value: string): TimedCursor {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);

  try {
    return TimedCursorSchema.parse(JSON.parse(atob(base64 + padding)));
  } catch {
    throw new Error("invalid_cursor");
  }
}
