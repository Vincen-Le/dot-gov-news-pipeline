import { describe, expect, it } from "vitest";

import { validateFeed } from "../src/discovery/validate-feed";

const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Agency News</title><link>https://agency.gov/news</link><description>Official updates</description></channel></rss>`;
const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel rdf:about="https://agency.gov/feed"><title>Agency RDF</title><link>https://agency.gov/news</link><description>Official updates</description></channel></rdf:RDF>`;
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Agency Atom</title><link href="https://agency.gov/news"/><id>https://agency.gov/feed.atom</id><updated>2026-07-17T00:00:00Z</updated></feed>`;
const jsonFeed = `{"version":"https://jsonfeed.org/version/1.1","title":"Agency JSON Feed","home_page_url":"https://agency.gov/news","items":[]}`;
const encode = (value: string) => new TextEncoder().encode(value);

describe("feed validation", () => {
  it("validates RSS, Atom, and empty JSON Feed documents", () => {
    expect(validateFeed(encode(rss))).toMatchObject({
      feedType: "rss",
      title: "Agency News",
    });
    expect(validateFeed(encode(atom))).toMatchObject({
      feedType: "atom",
      title: "Agency Atom",
    });
    expect(validateFeed(encode(jsonFeed))).toMatchObject({
      feedType: "json_feed",
      title: "Agency JSON Feed",
    });
    expect(validateFeed(encode(rdf))).toMatchObject({
      feedType: "rss",
      title: "Agency RDF",
    });
  });

  it("rejects malformed XML, arbitrary JSON, and DTD/entity input", () => {
    expect(validateFeed(encode("<rss><channel></rss>"))).toBeNull();
    expect(
      validateFeed(encode("<rss><channel><foo/></channel></rss>")),
    ).toBeNull();
    expect(validateFeed(encode("<feed><foo/></feed>"))).toBeNull();
    expect(validateFeed(encode('{"items":[]}'))).toBeNull();
    expect(
      validateFeed(
        encode(
          '{"version":"https://jsonfeed.org/version/garbage","title":"x","items":[]}',
        ),
      ),
    ).toBeNull();
    expect(
      validateFeed(
        encode('{"version":"https://jsonfeed.org/version/1.1","items":[]}'),
      ),
    ).toBeNull();
    expect(
      validateFeed(
        encode(
          '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><title>&xxe;</title></channel></rss>',
        ),
      ),
    ).toBeNull();
  });

  it("prefers Atom alternate links over self links", () => {
    const document = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Agency</title><link rel="self" href="https://agency.gov/feed.atom"/><link rel="alternate" href="https://agency.gov/news"/><id>agency</id><updated>2026-07-17T00:00:00Z</updated></feed>`;
    expect(validateFeed(encode(document))).toMatchObject({
      homePageUrl: "https://agency.gov/news",
    });
  });
});
