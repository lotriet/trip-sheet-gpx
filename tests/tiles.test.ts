import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeTiles } from "../src/lib/engine/tiles";

// OpenFreeMap tile 14/4600/6445: The Woodlands at Green Level Crossing, Cary.
const bytes = new Uint8Array(readFileSync(new URL("./fixtures/tile_14_4600_6445.pbf", import.meta.url)));

test("a residential street named Trail is read as a street", async () => {
  const { lines } = await decodeTiles([{ z: 14, x: 4600, y: 6445, bytes }]);
  const names = new Set(lines.map((l) => l.name));
  assert.ok(names.has("Whisper Rock Trail"));
  assert.ok(names.has("Piney Gap Drive"));
});
