import assert from "node:assert/strict";
import { test } from "node:test";
import { expandPlaceQuery, looksLikePlace, placeName } from "../src/lib/engine/names";
import { classifyLocation, parseSheet } from "../src/lib/engine/parseSheet";
import { minDistToTrack } from "../src/lib/engine/geo";
import { routeSheet } from "../src/lib/engine/route";
import type { RawLine } from "../src/lib/engine/types";

// Made-up streets and schools.
test("school stop lines become a school search", async () => {
  assert.equal(placeName("Deadhead - 1 OAK HS 0 0 @AB.012"), "OAK HS");
  assert.equal(expandPlaceQuery("Deadhead - 1 OAK HS 0 0 @AB.012"), "OAK High School");
  assert.equal(expandPlaceQuery("SCHOOL: BIRCH ELEM"), "BIRCH Elementary School");
  assert.equal(looksLikePlace("OAK HighSchool"), true);
});

test("a school start with a street number and DOORSIDE notes are understood", async () => {
  assert.deepEqual(classifyLocation("Deadhead - 1 OAK HS"), { kind: "school", name: "OAK HS" });
  assert.deepEqual(classifyLocation("OAK ST & ELM DR DOORSIDE"), { kind: "intersection", a: "OAK ST", b: "ELM DR" });
  assert.deepEqual(classifyLocation("OAK ST & ELM DR (DOORSIDE)"), { kind: "intersection", a: "OAK ST", b: "ELM DR" });
});

test("footer and confidentiality lines are ignored", async () => {
  const sheet = parseSheet(`Route: DEMO Description: OAK HS 01 Run: 900.101
This document and information are provided in confidence for the sole purpose of transporting
students, and may not be disclosed to any third party or used for any other purpose.
07:00 AM Deadhead - 1 OAK HS 0 0 @AB.012
07:00 AM SCHOOL: OAK HS 0 5 900.000
Proceed On OAK HS
10/05/2026 Report Name: --MASTER - Driver Directions - by Route Page 22
07:05 AM MAPLE AVE & ELM ST 5 0 900.011`);
  assert.deepEqual(sheet.stops.map((s) => s.description), ["Deadhead - 1 OAK HS", "SCHOOL: OAK HS", "MAPLE AVE & ELM ST"]);
});

const line = (name: string, keys: string[], coords: [number, number][]): RawLine => ({ name, keys, coords, kind: "named", oneway: 0 });
const lines = [
  line("Maple Avenue", ["maple ave"], [[-78.71, 35.8], [-78.705, 35.8], [-78.7, 35.8]]),
  line("Elm Street", ["elm st"], [[-78.705, 35.795], [-78.705, 35.8], [-78.705, 35.805]]),
  line("Birch Lane", ["birch ln"], [[-78.7, 35.795], [-78.7, 35.8], [-78.7, 35.805]]),
];

test("a first stop the map can't place doesn't stop the build", async () => {
  const sheet = parseSheet(`07:00 AM Deadhead - ZEBRA CT & QUAIL WAY 0 0 900.010
Proceed On MAPLE AVE
07:03 AM MAPLE AVE & ELM ST 2 2 900.011
Proceed On MAPLE AVE
Left Turn Onto BIRCH LN
07:06 AM BIRCH LN & MAPLE AVE 2 0 900.012`);
  const result = await routeSheet(sheet, { lines, places: [] });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (result.ok) assert.match(result.warnings[0].message, /Couldn't place the first stop/);
});

test("a via point off the printed line bends the track through that tap", async () => {
  const sheet = parseSheet(`07:00 AM MAPLE AVE & ELM ST
Proceed On MAPLE AVE
Left Turn Onto BIRCH LN
07:06 AM BIRCH LN & MAPLE AVE`);
  // North of Maple, far past the old 40 m intersection snap.
  const via = { lat: 35.808, lon: -78.705 };
  const result = await routeSheet(sheet, { lines, places: [] }, { vias: [via] });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) return;
  assert.ok(minDistToTrack([via.lon, via.lat], result.coords) < 5);
  assert.equal(result.viaStreets[0], "Elm Street");
  assert.match(result.warnings.map((w) => w.message).join("\n"), /point you added/);
});
