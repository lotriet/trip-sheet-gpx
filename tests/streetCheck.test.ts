import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStreetIndex, checkStreet, sheetStyle, suggestStreets } from "../src/lib/streetCheck";
import type { RawLine } from "../src/lib/engine/types";

// Made-up streets.
const line = (name: string, keys: string[] = []): RawLine => ({ name, keys, coords: [], kind: "named", oneway: 0 });
const index = buildStreetIndex([
  line("Maplewood Mill Road"),
  line("Maple Avenue"),
  line("Birch Hollow Lane"),
  line("Cedar Run Drive"),
  line("", ["nc 99"]),
]);

test("finds printed names in map spelling", () => {
  assert.equal(checkStreet(index, "MAPLEWOOD MILL RD"), "found");
  assert.equal(checkStreet(index, "MAPLE AVE"), "found");
  assert.equal(checkStreet(index, "NC 99 HWY"), "found");
  assert.equal(checkStreet(index, "MAPLEWOODMILL RD"), "found");
  assert.equal(checkStreet(index, "OAK ACADEMY HS"), "place");
  assert.equal(checkStreet(index, ""), "empty");
});

test("flags a misread name and suggests the real one first", () => {
  assert.equal(checkStreet(index, "MAPLEW OOD MlLL RD"), "missing");
  assert.equal(suggestStreets(index, "MAPLEW OOD MlLL RD")[0], "MAPLEWOOD MILL RD");
  assert.equal(suggestStreets(index, "BIRCH HOLL0W LN")[0], "BIRCH HOLLOW LN");
  assert.deepEqual(suggestStreets(index, "ZEBRA PATH"), []);
});

test("writes suggestions the way the sheet prints them", () => {
  assert.equal(sheetStyle("Cedar Run Drive"), "CEDAR RUN DR");
  assert.equal(sheetStyle("Oak Street"), "OAK ST");
});
