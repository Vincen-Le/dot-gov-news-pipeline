import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { InventorySnapshotStore } from "./r2-snapshot-store";

export function createLocalSnapshotStore(
  directory: string,
): InventorySnapshotStore {
  return {
    async archive(input) {
      await mkdir(directory, { recursive: true });
      const filename = `${input.sha256}.csv`;
      const destination = join(directory, filename);

      try {
        await copyFile(input.filePath, destination, constants.COPYFILE_EXCL);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          Reflect.get(error, "code") !== "EEXIST"
        ) {
          throw error;
        }
      }

      return `inventory/gsa/${filename}`;
    },
  };
}
