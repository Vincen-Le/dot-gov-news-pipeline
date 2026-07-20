const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const repository = "/Users/vincent.le/Developer/dot-gov-news-pipeline";
const run = path.join(
  repository,
  ".data/golden-enrichment/generated-images-collage-20260720",
);
const manifest = path.join(
  repository,
  ".data/golden-enrichment/export-20260720-overviews-refresh/cards",
);
const output =
  "/Users/vincent.le/.codex/visualizations/2026/07/20/019f7e89-6185-7783-8aa6-9071011c8e0d";
const proofIds = new Set([
  "17472de3-2177-4300-bad7-999e0384a57f",
  "2852766f-02fd-4540-854b-598990a0240d",
]);

const tasks = new Map();
for (const filename of fs.readdirSync(manifest)) {
  if (!filename.endsWith(".jsonl")) continue;
  const lines = fs
    .readFileSync(path.join(manifest, filename), "utf8")
    .trim()
    .split("\n");
  for (const line of lines) {
    const task = JSON.parse(line);
    tasks.set(task.eventCardId, task);
  }
}

const selections = [];
for (const eventCardId of fs.readdirSync(run).sort()) {
  const directory = path.join(run, eventCardId);
  if (!fs.statSync(directory).isDirectory()) continue;
  const metadataName = proofIds.has(eventCardId)
    ? "image-generation-v2.json"
    : "image-generation.json";
  const metadataPath = path.join(directory, metadataName);
  if (!fs.existsSync(metadataPath)) continue;
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const task = tasks.get(eventCardId);
  const masterPath = path.join(
    directory,
    metadata.masterPath || "storyline-master.png",
  );
  if (
    task &&
    metadata.inputHash === task.inputHash &&
    fs.existsSync(masterPath)
  ) {
    selections.push({ eventCardId, masterPath, metadataName });
  }
}

function escapeXml(value) {
  return value.replace(/[&<>]/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[character];
  });
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const pageCount = Math.ceil(selections.length / 20);
  for (let page = 0; page < pageCount; page += 1) {
    const composites = [];
    const batch = selections.slice(page * 20, page * 20 + 20);
    for (let index = 0; index < batch.length; index += 1) {
      const selection = batch[index];
      const crop = await sharp(selection.masterPath)
        .extract({ left: 168, top: 272, width: 1200, height: 480 })
        .resize(360, 144)
        .png()
        .toBuffer();
      const label = Buffer.from(
        `<svg width="360" height="36"><rect width="360" height="36" fill="#f3ead7"/><text x="10" y="23" font-family="monospace" font-size="15" fill="#171614">${escapeXml(selection.eventCardId.slice(0, 8))} · ${escapeXml(selection.metadataName.replace("image-generation", "meta"))}</text></svg>`,
      );
      const cell = await sharp({
        create: {
          width: 360,
          height: 180,
          channels: 3,
          background: "#f3ead7",
        },
      })
        .composite([
          { input: crop, left: 0, top: 0 },
          { input: label, left: 0, top: 144 },
        ])
        .png()
        .toBuffer();
      composites.push({
        input: cell,
        left: (index % 4) * 360,
        top: Math.floor(index / 4) * 180,
      });
    }
    const name = `collage-current-review-${page + 1}-of-${pageCount}.png`;
    await sharp({
      create: {
        width: 1440,
        height: 900,
        channels: 3,
        background: "#11100f",
      },
    })
      .composite(composites)
      .png()
      .toFile(path.join(output, name));
    process.stdout.write(`${path.join(output, name)}\n`);
  }
  process.stdout.write(
    `${JSON.stringify({ selections: selections.length })}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
