import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { repositoryRoot } from "../src/config";
import { operatorRecipes, renderCheatsheet } from "../src/recipes";

describe("operator recipe catalog", () => {
  it("keeps commands and views unique", () => {
    expect(new Set(operatorRecipes.map((recipe) => recipe.id)).size).toBe(
      operatorRecipes.length,
    );
    expect(
      operatorRecipes.every((recipe) => recipe.cli.startsWith("pnpm ops ")),
    ).toBe(true);
  });

  it("keeps the checked-in cheatsheet generated from the catalog", async () => {
    const checkedIn = await readFile(
      `${repositoryRoot}/docs/operations/cli-cheatsheet.md`,
      "utf8",
    );
    expect(checkedIn).toBe(renderCheatsheet());
  });

  it("includes clustering lab recipes with dashboard views", () => {
    const ids = operatorRecipes.map((recipe) => recipe.id);
    for (const id of [
      "lab-corpus",
      "lab-chains",
      "lab-run-stub",
      "lab-experiments",
      "lab-label-queue",
    ]) {
      expect(ids).toContain(id);
    }
    const chains = operatorRecipes.find((recipe) => recipe.id === "lab-chains");
    expect(chains?.cli).toBe("pnpm ops lab storylines --min-episodes 2");
    expect(chains?.view).toBe("/storylines?minEpisodes=2");
  });
});
