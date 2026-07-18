export function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code: string) => {
      const value = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    })
    .replace(
      /&([a-z]+);/gi,
      (match, name: string) => named[name.toLowerCase()] ?? match,
    );
}

export function stripMarkup(input: string): string {
  return decodeEntities(
    input
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function blocks(input: string, tag: string): string[] {
  const expression = new RegExp(
    `<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "gi",
  );
  return [...input.matchAll(expression)].map((match) => match[1] ?? "");
}

export function tagText(input: string, names: string[]): string | null {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(
      `<(?:[a-z0-9_-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z0-9_-]+:)?${escaped}>`,
      "i",
    ).exec(input);
    if (match?.[1] !== undefined) {
      const value = stripMarkup(match[1]);
      if (value !== "") return value;
    }
  }
  return null;
}

export function tagAttribute(
  input: string,
  tag: string,
  attribute: string,
): string | null {
  const tagMatch = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(input)?.[0];
  if (tagMatch === undefined) return null;
  return attributeValue(tagMatch, attribute);
}

export function attributeValue(tag: string, attribute: string): string | null {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, "i").exec(
    tag,
  );
  return match?.[1] === undefined ? null : decodeEntities(match[1]);
}

export function htmlLinks(
  input: string,
  baseUrl: string,
): Array<{ text: string; url: string }> {
  const links: Array<{ text: string; url: string }> = [];
  for (const match of input.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attributeValue(match[1] ?? "", "href");
    if (href === null) continue;
    try {
      links.push({
        text: stripMarkup(match[2] ?? ""),
        url: new URL(href, baseUrl).href,
      });
    } catch {
      // Ignore malformed publisher links.
    }
  }
  return links;
}

export function metaContent(input: string, key: string): string | null {
  for (const match of input.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const identifier =
      attributeValue(tag, "property") ??
      attributeValue(tag, "name") ??
      attributeValue(tag, "itemprop");
    if (identifier?.toLowerCase() === key.toLowerCase()) {
      return attributeValue(tag, "content");
    }
  }
  return null;
}

export function linkHref(input: string, relationship: string): string | null {
  for (const match of input.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (
      attributeValue(tag, "rel")?.toLowerCase() === relationship.toLowerCase()
    ) {
      return attributeValue(tag, "href");
    }
  }
  return null;
}
