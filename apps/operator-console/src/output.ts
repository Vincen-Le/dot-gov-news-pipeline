export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printRows(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    process.stdout.write("No records found.\n");
    return;
  }
  console.table(rows);
}

export function formatAge(timestamp: string | null): string {
  if (timestamp === null) {
    return "—";
  }
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(timestamp)) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function sinceTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d+)(s|m|h|d)$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("Duration must use a suffix such as 30m, 2h, or 7d");
  }
  const amount = Number(match[1]);
  const multiplier = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[
    match[2] as "d" | "h" | "m" | "s"
  ];
  return new Date(Date.now() - amount * multiplier).toISOString();
}
