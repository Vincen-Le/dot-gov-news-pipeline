import { validatePublisherUrl } from "./url-safety";

export function canonicalizeFeedUrl(input: string | URL): string {
  const url = validatePublisherUrl(input);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  return url.href;
}
