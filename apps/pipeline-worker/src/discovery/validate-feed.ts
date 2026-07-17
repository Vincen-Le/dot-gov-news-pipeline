import { XMLParser, XMLValidator } from "fast-xml-parser";

import type { FeedType } from "../clients/site-discovery-repository";

export interface ValidatedFeed {
  feedType: FeedType;
  homePageUrl: string | null;
  title: string | null;
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length === 0 ? null : text.slice(0, maximum);
  }
  if (typeof value === "number") return String(value).slice(0, maximum);
  return null;
}

function xmlText(value: unknown, maximum: number): string | null {
  const direct = boundedText(value, maximum);
  if (direct !== null) return direct;
  return boundedText(record(value)?.["#text"], maximum);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function xmlChild(object: Record<string, unknown>, suffix: string): unknown {
  const entry = Object.entries(object).find(
    ([key]) => key.toLowerCase().split(":").at(-1) === suffix,
  );
  return entry?.[1];
}

function linkValue(value: unknown): string | null {
  if (typeof value === "string") return boundedText(value, 2_048);
  const object = record(Array.isArray(value) ? value[0] : value);
  return (
    boundedText(object?.["@_href"], 2_048) ??
    boundedText(object?.["#text"], 2_048)
  );
}

function atomHomePageLink(value: unknown): string | null {
  const links = (Array.isArray(value) ? value : [value])
    .map(record)
    .filter((link): link is Record<string, unknown> => link !== null);
  const alternate = links.find(
    (link) => boundedText(link["@_rel"], 64)?.toLowerCase() === "alternate",
  );
  const implicitAlternate = links.find(
    (link) => boundedText(link["@_rel"], 64) === null,
  );
  return linkValue(alternate ?? implicitAlternate);
}

function validateJsonFeed(text: string): ValidatedFeed | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const feed = record(value);
  const title = boundedText(feed?.title, 512);
  if (
    feed === null ||
    ![
      "https://jsonfeed.org/version/1",
      "https://jsonfeed.org/version/1.1",
    ].includes(String(feed.version)) ||
    title === null ||
    !Array.isArray(feed.items)
  ) {
    return null;
  }
  return {
    feedType: "json_feed",
    homePageUrl: boundedText(feed.home_page_url, 2_048),
    title,
  };
}

export function validateFeed(body: Uint8Array): ValidatedFeed | null {
  const text = new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: false,
  })
    .decode(body)
    .trim();
  if (text.length === 0) return null;
  if (text.startsWith("{") || text.startsWith("["))
    return validateJsonFeed(text);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null;
  if (XMLValidator.validate(text, { allowBooleanAttributes: false }) !== true)
    return null;

  let parsed: unknown;
  try {
    parsed = new XMLParser({
      allowBooleanAttributes: false,
      ignoreAttributes: false,
      parseTagValue: false,
      processEntities: false,
      trimValues: true,
    }).parse(text);
  } catch {
    return null;
  }
  const document = record(parsed);
  if (document === null) return null;
  const rootEntry = Object.entries(document).find(([key]) =>
    ["rss", "feed", "rdf"].includes(key.toLowerCase().split(":").at(-1) ?? ""),
  );
  if (rootEntry === undefined) return null;
  const rootName = rootEntry[0].toLowerCase().split(":").at(-1);
  const root = record(rootEntry[1]);
  if (root === null) return null;

  if (rootName === "feed") {
    const title = xmlText(xmlChild(root, "title"), 512);
    const id = xmlText(xmlChild(root, "id"), 2_048);
    const updated = xmlText(xmlChild(root, "updated"), 128);
    if (
      title === null ||
      id === null ||
      updated === null ||
      !Number.isFinite(Date.parse(updated))
    )
      return null;
    return {
      feedType: "atom",
      homePageUrl: atomHomePageLink(xmlChild(root, "link")),
      title,
    };
  }

  const channel = record(xmlChild(root, "channel"));
  if (channel === null) return null;
  const title = xmlText(xmlChild(channel, "title"), 512);
  const link = linkValue(xmlChild(channel, "link"));
  const description = xmlText(xmlChild(channel, "description"), 2_048);
  if (title === null || link === null || description === null) return null;
  return {
    feedType: "rss",
    homePageUrl: link,
    title,
  };
}
