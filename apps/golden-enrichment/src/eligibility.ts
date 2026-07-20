export interface GoldenEligibilityRow {
  contentHash: string;
  contentHashAtReview: string;
  publishedAt: string | null;
  reviewStatus: string;
}

export function isReviewedHashMatch(row: GoldenEligibilityRow): boolean {
  return (
    row.reviewStatus === "reviewed" &&
    row.contentHash === row.contentHashAtReview
  );
}

export function isFullyReviewedAtCutoff(
  rows: readonly GoldenEligibilityRow[],
  cutoff: string,
): boolean {
  const cutoffTime = Date.parse(cutoff);
  if (!Number.isFinite(cutoffTime)) throw new Error("invalid card cutoff");
  const visibleRows = rows.filter((row) => {
    if (row.publishedAt === null) return false;
    return Date.parse(row.publishedAt) <= cutoffTime;
  });
  return (
    visibleRows.length > 0 &&
    visibleRows.every((row) => isReviewedHashMatch(row))
  );
}

export function visibleAtCutoff<T extends GoldenEligibilityRow>(
  rows: readonly T[],
  cutoff: string,
): T[] {
  const cutoffTime = Date.parse(cutoff);
  return rows
    .filter(
      (row) =>
        row.publishedAt !== null && Date.parse(row.publishedAt) <= cutoffTime,
    )
    .sort(
      (left, right) =>
        Date.parse(left.publishedAt ?? "") -
        Date.parse(right.publishedAt ?? ""),
    );
}
