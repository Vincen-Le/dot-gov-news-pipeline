/** fp16 decode + similarity/statistics helpers.
 *
 * Embeddings are stored as little-endian IEEE 754 half floats (numpy
 * `float16.tobytes()`); decoded by hand so the console has no typed-array
 * lib dependency. Percentiles use linear interpolation to match numpy's
 * default, so live numbers agree with any Python-side analysis.
 */


function halfToNumber(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const fraction = half & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

export function unpackFp16(raw: Uint8Array): number[] {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: number[] = [];
  for (let offset = 0; offset + 1 < raw.byteLength; offset += 2) {
    out.push(halfToNumber(view.getUint16(offset, true)));
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) * (a[i] ?? 0);
    normB += (b[i] ?? 0) * (b[i] ?? 0);
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function percentiles(values: number[]): Record<string, number> {
  if (values.length === 0) return {};
  const sorted = [...values].sort((left, right) => left - right);
  const at = (q: number): number => {
    const position = (q / 100) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const weight = position - lower;
    return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
  };
  return Object.fromEntries(
    [5, 25, 50, 75, 95].map((q) => [`p${q}`, Number(at(q).toFixed(4))]),
  );
}

export function bucketHistogram(
  values: number[],
  cap: number,
): { bucket: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const value of values) {
    const bucket = Math.min(value, cap);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucket, count]) => ({ bucket, count }));
}
