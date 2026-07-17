import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function isPublicIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(hostname: string): boolean {
  const address = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (address === "::" || address === "::1") return false;
  const mapped = address.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1] !== undefined) return isPublicIpv4(mapped[1]);

  const firstGroupText = address.split(":")[0];
  const firstGroup = Number.parseInt(firstGroupText ?? "", 16);
  if (
    !Number.isFinite(firstGroup) ||
    firstGroup < 0x2000 ||
    firstGroup > 0x3fff
  ) {
    return false;
  }
  if (address.startsWith("2001:db8:") || address === "2001:db8::") return false;
  if (address.startsWith("2001:2:") || address === "2001:2::") return false;
  return true;
}

export function isWithinBaseDomain(
  hostname: string,
  baseDomain: string,
): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const base = baseDomain.toLowerCase().replace(/\.$/, "");
  return host === base || host.endsWith(`.${base}`);
}

export function validatePublisherUrl(
  input: string | URL,
  base?: string | URL,
): URL {
  const raw = String(input);
  if (raw.length > 2_048) throw new UnsafeUrlError("URL is too long");

  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    throw new UnsafeUrlError("URL is malformed");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("URL scheme is not allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError("URL credentials are not allowed");
  }
  if (url.port !== "")
    throw new UnsafeUrlError("Non-default URL ports are not allowed");

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    hostname === "metadata.goog"
  ) {
    throw new UnsafeUrlError("Local or metadata hostnames are not allowed");
  }

  const ipVersion = isIP(hostname.replace(/^\[|\]$/g, ""));
  if (
    (ipVersion === 4 && !isPublicIpv4(hostname)) ||
    (ipVersion === 6 && !isPublicIpv6(hostname))
  ) {
    throw new UnsafeUrlError("Non-public IP literals are not allowed");
  }
  if (hostname.length < 1 || hostname.length > 253) {
    throw new UnsafeUrlError("Hostname is invalid");
  }

  url.hostname = hostname;
  url.hash = "";
  if (url.href.length > 2_048) throw new UnsafeUrlError("URL is too long");
  return url;
}
