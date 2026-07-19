export function backfillRunKey(input: {
  cohortId: string;
  extractorVersion: number;
  manifestSha256: string;
  windowEnd: string;
  windowStart: string;
}): string {
  return `${input.cohortId}-${input.windowStart.slice(0, 10)}-${input.windowEnd.slice(0, 10)}-${input.manifestSha256.slice(0, 12)}-extractor-v${input.extractorVersion}`;
}
