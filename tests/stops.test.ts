import assert from "node:assert/strict";
import { test } from "node:test";
import { expandPlaceQuery, placeName } from "../src/lib/engine/names";
import { parseSheet } from "../src/lib/engine/parseSheet";
import { routeSheet } from "../src/lib/engine/route";
import type { RawLine, RawPlace } from "../src/lib/engine/types";
import { buildStreetIndex, checkStop, suggestFor } from "../src/lib/streetCheck";

// Made-up streets and schools.
test("school stop lines become a school search", async () => {
  assert.equal(placeName("Deadhead - 1 OAK HS 0 0 @AB.012"), "OAK HS");
  assert.equal(placeName("SCHOOL: OAK HS"), "OAK HS");
  assert.equal(expandPlaceQuery("Deadhead - 1 OAK HS 0 0 @AB.012"), "OAK High School");
  assert.equal(expandPlaceQuery("SCHOOL: BIRCH ELEM"), "BIRCH Elementary School");
  assert.equal(expandPlaceQuery("SCHOOL: PINE DR ES"), "PINE DR Elementary School");
});

test("footer and confidentiality lines are not read as stops or directions", async () => {
  const sheet = parseSheet(`Route: DEMO Description: OAK HS 01 Run: 900.101
If the directions cannot be run according to TIMS (medians in the roadway, one way streets,
private streets, etc..) make a note on this sheet and turn it in to your district office.
This document and information are provided in confidence for the sole purpose of transporting
students, and may not be disclosed to any third party or used for any other purpose.
Stop Time Description Stop Load Run Ld Stop ID
07:00 AM Deadhead - 1 OAK HS 0 0 @AB.012
07:00 AM SCHOOL: OAK HS 0 5 900.000
Proceed On OAK HS
10/05/2026 Report Name: --MASTER - Driver Directions - by Route Page 22
07:05 AM MAPLE AVE & ELM ST 5 0 900.011`);
  assert.deepEqual(sheet.stops.map((s) => s.description), ["Deadhead - 1 OAK HS", "SCHOOL: OAK HS", "MAPLE AVE & ELM ST"]);
  assert.deepEqual(sheet.stops[1].maneuvers.map((m) => m.street), ["OAK HS"]);
  assert.equal(sheet.stops[1].stopId, "900.000");
});

const line = (name: string, coords: [number, number][]): RawLine => ({
  name,
  keys: [name.toLowerCase().replace(" street", " st").replace(" avenue", " ave").replace(" lane", " ln")],
  coords,
  kind: "named",
  oneway: 0,
});
const places: RawPlace[] = [{ name: "Oak High School", lat: 35.8, lon: -78.7, tokens: "oak", level: "high" }];
const lines = [
  line("Maple Avenue", [[-78.71, 35.8], [-78.705, 35.8], [-78.7, 35.8]]),
  line("Elm Street", [[-78.705, 35.795], [-78.705, 35.8], [-78.705, 35.805]]),
  line("Birch Lane", [[-78.7, 35.795], [-78.7, 35.8], [-78.7, 35.805]]),
];

test("each stop says whether the map knows its streets or school", async () => {
  const index = buildStreetIndex(lines, places);
  assert.deepEqual(checkStop(index, "MAPLE AVE & ELM ST"), { status: "found", missing: [] });
  assert.deepEqual(checkStop(index, "MAPLE AVE & ELN ST"), { status: "missing", missing: ["ELN ST"] });
  assert.equal(suggestFor(index, "ELN ST")[0], "ELM ST");
  assert.equal(checkStop(index, "SCHOOL: OAK HS").status, "found");
  assert.equal(checkStop(index, "Deadhead - 1 OAK HS").status, "found");
  assert.equal(checkStop(index, "SCHOOL: OAKK HS").status, "missing");
  assert.equal(suggestFor(index, "OAKK HS")[0], "OAK HIGH SCHOOL");
});

test("a first stop the map can't place doesn't stop the build", async () => {
  const sheet = parseSheet(`07:00 AM Deadhead - ZEBRA CT & QUAIL WAY 0 0 900.010
Proceed On MAPLE AVE
07:03 AM MAPLE AVE & ELM ST 2 2 900.011
Proceed On MAPLE AVE
Left Turn Onto BIRCH LN
07:06 AM BIRCH LN & MAPLE AVE 2 0 900.012`);
  const result = await routeSheet(sheet, { lines, places: [] });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (result.ok) {
    assert.match(result.warnings[0].message, /Couldn't place the first stop/);
    assert.equal(result.warnings[0].stopIndex, 0);
  }
});
