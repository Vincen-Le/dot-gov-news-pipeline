import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { repositoryRoot } from "./config";
import { renderCheatsheet } from "./recipes";

export const cheatsheetPath = resolve(
  repositoryRoot,
  "docs/operations/cli-cheatsheet.md",
);

export async function generateCheatsheet(): Promise<void> {
  await mkdir(resolve(repositoryRoot, "docs/operations"), { recursive: true });
  await writeFile(cheatsheetPath, renderCheatsheet(), "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await generateCheatsheet();
  process.stdout.write(`${cheatsheetPath}\n`);
}
