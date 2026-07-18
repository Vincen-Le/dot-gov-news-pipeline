import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LabelStore } from "../src/lab/labels";

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { force: true, recursive: true });
  root = undefined;
});

describe("LabelStore", () => {
  it("appends labels in the eval CSV contract", async () => {
    root = await mkdtemp(join(tmpdir(), "lab-"));
    const store = new LabelStore(root);
    await store.appendLabel({ entryA: "a", entryB: "b", sameEvent: true });
    await store.appendLabel({ entryA: "c", entryB: "d", sameEvent: false });
    const csv = await readFile(store.labelsPath, "utf8");
    expect(csv).toBe("entry_a,entry_b,same_event\na,b,y\nc,d,n\n");
    expect(await store.readLabels()).toEqual([
      { entryA: "a", entryB: "b", sameEvent: true },
      { entryA: "c", entryB: "d", sameEvent: false },
    ]);
  });

  it("reads empty when no labels exist", async () => {
    root = await mkdtemp(join(tmpdir(), "lab-"));
    expect(await new LabelStore(root).readLabels()).toEqual([]);
  });
});
