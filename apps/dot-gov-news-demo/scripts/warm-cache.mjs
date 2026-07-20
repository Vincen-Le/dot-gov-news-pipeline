const configuredOrigin = (
  process.argv[2] ??
  process.env.DOT_GOV_DEMO_URL ??
  ""
).trim();

if (configuredOrigin === "") {
  throw new Error(
    "Pass the deployed origin or set DOT_GOV_DEMO_URL before warming the cache.",
  );
}

const origin = new URL(configuredOrigin);
const bootstrapUrl = new URL("/api/lab/bootstrap?limit=500&sort=rank", origin);
const bootstrapResponse = await fetch(bootstrapUrl, {
  headers: { accept: "application/json" },
});
if (!bootstrapResponse.ok) {
  throw new Error(
    `Bootstrap warm failed (${bootstrapResponse.status} ${bootstrapResponse.statusText}).`,
  );
}

const envelope = await bootstrapResponse.json();
const data = envelope?.data;
if (
  data === null ||
  typeof data !== "object" ||
  !Array.isArray(data.previews) ||
  !Array.isArray(data.storylines?.items)
) {
  throw new Error("Bootstrap warm returned an invalid payload.");
}

const previewByStoryline = new Map(
  data.previews.map((preview) => [preview.storylineId, preview]),
);
const thumbnailUrls = data.storylines.items
  .slice(0, 18)
  .flatMap((storyline) => {
    const cards = previewByStoryline.get(storyline.id)?.overviewCards;
    if (!Array.isArray(cards)) return [];
    const card = cards.find(
      (candidate) => typeof candidate?.thumbnail?.cardUrl === "string",
    );
    return card === undefined
      ? []
      : [new URL(card.thumbnail.cardUrl, origin).toString()];
  });

const imageResults = await Promise.all(
  thumbnailUrls.map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Thumbnail warm failed for ${url} (${response.status} ${response.statusText}).`,
      );
    }
    await response.arrayBuffer();
    return {
      cache: response.headers.get("x-vercel-cache"),
      url,
    };
  }),
);

process.stdout.write(
  `${JSON.stringify({
    bootstrapCache: bootstrapResponse.headers.get("x-vercel-cache"),
    bootstrapUrl: bootstrapUrl.toString(),
    thumbnails: imageResults,
  })}\n`,
);
