import { readFile } from "node:fs/promises";
import type { RoadReader } from "./mapfetch";

/** The road cells in public/roads, read from disk. Node only. */
export const diskRoads: RoadReader = async (name) => {
  try {
    return await readFile(new URL(`../../public/roads/${name}.json`, import.meta.url), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};
