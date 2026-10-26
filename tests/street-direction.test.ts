import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalKey } from "../src/lib/engine/names";
import { parseSheet } from "../src/lib/engine/parseSheet";
import { routeSheet } from "../src/lib/engine/route";
import type { RawLine } from "../src/lib/engine/types";

// Made-up streets.
test("a direction written out or abbreviated is the same street", () => {
  assert.equal(canonicalKey("Southeast Maple Road"), canonicalKey("SE MAPLE RD"));
  assert.equal(canonicalKey("North Oak Street"), canonicalKey("N OAK ST"));
  assert.equal(canonicalKey("Maple Road Southeast"), canonicalKey("MAPLE RD SE"));
  assert.equal(canonicalKey("East Street"), "e st");
  assert.equal(canonicalKey("NC 55 HWY"), "nc 55");
});

const line = (name: string, keys: string[], coords: [number, number][]): RawLine => ({ name, keys, coords, kind: "named", oneway: 0 });

test("a sheet that drops or abbreviates the map's direction still routes", async () => {
  const lines = [
    line("Southeast Maple Road", [canonicalKey("Southeast Maple Road")], [[-78.71, 35.8], [-78.705, 35.8], [-78.7, 35.8]]),
    line("Elm Street", ["elm st"], [[-78.705, 35.795], [-78.705, 35.8], [-78.705, 35.805]]),
    line("Birch Lane", ["birch ln"], [[-78.7, 35.795], [-78.7, 35.8], [-78.7, 35.805]]),
  ];
  for (const written of ["SE MAPLE RD", "MAPLE RD"]) {
    const sheet = parseSheet(`07:00 AM ${written} & ELM ST\nProceed On ${written}\nLeft Turn Onto BIRCH LN\n07:06 AM BIRCH LN & ${written}`);
    const result = await routeSheet(sheet, { lines, places: [] });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) continue;
    assert.doesNotMatch(result.warnings.map((w) => w.message).join("\n"), /Couldn't (find|place)/, written);
  }
});

test("a bare name shared by an east and a west street is not guessed", async () => {
  const { checkStreet, buildStreetIndex } = await import("../src/lib/streetCheck");
  const index = buildStreetIndex([
    line("East Chatham Street", [canonicalKey("East Chatham Street")], [[-78.7, 35.8], [-78.69, 35.8]]),
    line("West Chatham Street", [canonicalKey("West Chatham Street")], [[-78.71, 35.8], [-78.7, 35.8]]),
  ], []);
  assert.equal(checkStreet(index, "E CHATHAM ST"), "found");
  assert.equal(checkStreet(index, "CHATHAM ST"), "missing");
});

test("a dropped direction is matched before a street with another suffix", async () => {
  const { checkStreet, buildStreetIndex, looseName } = await import("../src/lib/streetCheck");
  const index = buildStreetIndex([
    line("Southeast Maple Parkway", [canonicalKey("Southeast Maple Parkway")], [[-78.7, 35.8], [-78.69, 35.8]]),
    line("Maple Street", [canonicalKey("Maple Street")], [[-78.71, 35.81], [-78.7, 35.81]]),
  ], []);
  assert.equal(looseName(index, "MAPLE PKWY"), "SOUTHEAST MAPLE PKWY");
  assert.equal(checkStreet(index, "MAPLE PKWY"), "found");
});
