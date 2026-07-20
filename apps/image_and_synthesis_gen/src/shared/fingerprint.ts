import { createHash } from "node:crypto";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** JSON with recursively sorted object keys and stable array order. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const fields = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${fields.join(",")}}`;
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprint(value: JsonValue): string {
  return sha256(canonicalJson(value));
}

export function partitionFor(hash: string, partitionCount: number): number {
  if (!/^[0-9a-f]{64}$/u.test(hash)) {
    throw new Error("partition hash must be lowercase sha256 hex");
  }
  if (!Number.isInteger(partitionCount) || partitionCount < 1) {
    throw new Error("partition count must be a positive integer");
  }
  return Number(BigInt(`0x${hash}`) % BigInt(partitionCount));
}
