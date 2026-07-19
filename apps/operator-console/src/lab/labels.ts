import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Corpus-level ground-truth labels (docs/eval/labels.csv).
 *
 * Same CSV contract the pipeline eval harness will consume via --labels:
 * header entry_a,entry_b,same_event with y/n verdicts. Labels describe entry
 * pairs, so they survive experiment resets and apply to every run.
 */
/** Human rank preferences (docs/eval/rank-labels.csv).
 *
 * Row contract consumed by `pipeline rank fit --labels`: header
 * run_id,storyline_a,storyline_b,preferred with a/b verdicts. Keys are
 * run-scoped because snapshot and audit rows persist per run even after
 * clustering resets.
 */
export class RankLabelStore {
  readonly labelsPath: string;

  constructor(rootDir: string) {
    this.labelsPath = join(rootDir, "rank-labels.csv");
  }

  async appendLabel(row: {
    preferred: "a" | "b";
    runId: string;
    storylineA: string;
    storylineB: string;
  }): Promise<void> {
    let needsHeader = false;
    try {
      await readFile(this.labelsPath, "utf8");
    } catch {
      needsHeader = true;
    }
    const line = `${row.runId},${row.storylineA},${row.storylineB},${row.preferred}\n`;
    await appendFile(
      this.labelsPath,
      needsHeader
        ? `run_id,storyline_a,storyline_b,preferred\n${line}`
        : line,
    );
  }
}

export class LabelStore {
  readonly labelsPath: string;

  constructor(rootDir: string) {
    this.labelsPath = join(rootDir, "labels.csv");
  }

  async appendLabel(row: {
    entryA: string;
    entryB: string;
    sameEvent: boolean;
  }): Promise<void> {
    let needsHeader = false;
    try {
      await readFile(this.labelsPath, "utf8");
    } catch {
      needsHeader = true;
    }
    const line = `${row.entryA},${row.entryB},${row.sameEvent ? "y" : "n"}\n`;
    await appendFile(
      this.labelsPath,
      needsHeader ? `entry_a,entry_b,same_event\n${line}` : line,
    );
  }

  async readLabels(): Promise<
    { entryA: string; entryB: string; sameEvent: boolean }[]
  > {
    try {
      const raw = await readFile(this.labelsPath, "utf8");
      return raw
        .trim()
        .split("\n")
        .slice(1)
        .filter((line) => line.length > 0)
        .map((line) => {
          const parts = line.split(",");
          const entryA = parts[0] ?? "";
          const entryB = parts[1] ?? "";
          const sameEvent = (parts[2] ?? "") === "y";
          return { entryA, entryB, sameEvent };
        });
    } catch {
      return [];
    }
  }
}
