import type { OperatorEnv } from "./env";

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

function fixedLengthEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}

export async function hasValidOperatorToken(
  request: Request,
  env: Pick<OperatorEnv, "OPS_API_TOKEN">,
): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const configured = env.OPS_API_TOKEN ?? "";
  const [presentedDigest, configuredDigest] = await Promise.all([
    digest(presented),
    digest(configured),
  ]);

  return (
    configured.length >= 32 &&
    presented.length > 0 &&
    fixedLengthEqual(presentedDigest, configuredDigest)
  );
}
