import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSameSchool } from "../src/lib/batch";
import { schoolSig } from "../src/lib/engine/names";
import { parseSheet } from "../src/lib/engine/parseSheet";
import { matchPlace, routeSheet } from "../src/lib/engine/route";
import type { RawLine, RawPlace } from "../src/lib/engine/types";

// Made-up streets and schools only.
const place = (name: string, lat: number, lon: number): RawPlace => ({ name, lat, lon, ...schoolSig(name) });

test("school names match whatever way the sheet or the driver writes them", () => {
  const places = [place("Birchwood High School", 35.8, -78.7), place("Birchwood Elementary School", 35.81, -78.7)];
  for (const raw of ["Birchwood HIGH SCHOOL", "SCHOOL: BIRCHWOOD HS", "BIRCHWOOD HS 16 (DB)", "birchwood hs"]) {
    assert.equal(matchPlace(raw.replace(/^SCHOOL:\s*/, ""), places)?.name, "Birchwood High School", raw);
  }
  // One letter misread in a long name still matches, at the same level only.
  assert.equal(matchPlace("BIRCHWOOO HS", places)?.name, "Birchwood High School");
  assert.equal(matchPlace("BIRCHWOOD ES", places)?.name, "Birchwood Elementary School");
  assert.equal(matchPlace("OAKWOOD HS", places), null);
});

test("two cards for the same school at the same time become one", () => {
  const stops = [
    { time: "2:28 PM", description: "Deadhead - BIRCHWOOD HS 16 (DB)", maneuvers: [{ kind: "proceed" as const, street: "OAK ST" }] },
    { time: "2:28 PM", description: "SCHOOL: BIRCHWOOD HS", maneuvers: [{ kind: "left" as const, street: "ELM DR" }] },
    { time: "2:40 PM", description: "OAK ST & ELM DR", maneuvers: [] },
  ];
  const out = mergeSameSchool(stops as never);
  assert.equal(out.length, 2);
  assert.equal(out[0].description, "SCHOOL: BIRCHWOOD HS");
  assert.deepEqual(out[0].maneuvers.map((m) => m.street), ["OAK ST", "ELM DR"]);
});

test("misread route numbers are fixed", () => {
  const sheet = parseSheet(`07:00 AM Deadhead - OAK ST & ELM DR 0 0 900.010
Proceed On OAK ST
Right Turn Onto NC SS HWY
07:05 AM NC SS HWY & ELM DR 2 0 900.011`);
  assert.equal(sheet.stops[0].maneuvers[1].street, "NC 55 HWY");
});

const line = (name: string, keys: string[], coords: [number, number][]): RawLine => ({ name, keys, coords, kind: "named", oneway: 0 });

test("a street name with a stray space still routes, like the green mark says", async () => {
  const lines = [
    line("Maple Avenue", ["maple ave"], [[-78.71, 35.8], [-78.705, 35.8], [-78.7, 35.8]]),
    line("Elmwood Street", ["elmwood st"], [[-78.705, 35.795], [-78.705, 35.8], [-78.705, 35.805]]),
    line("Birch Lane", ["birch ln"], [[-78.7, 35.795], [-78.7, 35.8], [-78.7, 35.805]]),
  ];
  const sheet = parseSheet(`07:00 AM Deadhead - MAPLE AVE & ELMWOO D ST 0 0 900.010
Proceed On MAPLE AVE
Left Turn Onto BIRCH LN
07:03 AM BIRCH LN & MAPLE AVE 2 0 900.011`);
  const r = await routeSheet(sheet, { lines, places: [] });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (r.ok) assert.ok(!r.warnings.some((w) => w.level === "warn"), JSON.stringify(r.warnings));
});

test("streets that don't connect on the map are joined by the router, or drawn straight with a note", async () => {
  const lines = [
    line("Maple Avenue", ["maple ave"], [[-78.72, 35.8], [-78.71, 35.8]]),
    line("Birch Lane", ["birch ln"], [[-78.70, 35.79], [-78.70, 35.81]]),
  ];
  const sheet = parseSheet(`07:00 AM Deadhead - MAPLE AVE 0 0 900.010
Proceed On MAPLE AVE
Left Turn Onto BIRCH LN
07:05 AM BIRCH LN 2 0 900.011`);
  const plain = await routeSheet(sheet, { lines, places: [] });
  assert.equal(plain.ok, true);
  if (plain.ok) assert.ok(plain.warnings.some((w) => /Couldn't connect/.test(w.message)));
  const router = async (pts: [number, number][]) => [pts[0], [-78.705, 35.8] as [number, number], pts[pts.length - 1]];
  const routed = await routeSheet(sheet, { lines, places: [] }, {}, router);
  assert.equal(routed.ok, true);
  if (routed.ok) assert.ok(!routed.warnings.some((w) => w.level === "warn" && /Couldn't connect/.test(w.message)), JSON.stringify(routed.warnings));
});

test("garbled load and stop-id columns are dropped from the stop name", () => {
  const sheet = parseSheet(`07:00 AM Deadhead - OAK ST & ELM WAY 12 3 39112
Proceed On OAK ST
07:05 AM SCHOOL: BIRCHWOOD HS Sa 64 - 44L000= EE
07:09 AM MAPLE AVE & ELM WAY 5 20 44306 4
07:12 AM NC 55 HWY & OAK ST 2 0 900.011`);
  assert.deepEqual(sheet.stops.map((s) => s.description), ["Deadhead - OAK ST & ELM WAY", "SCHOOL: BIRCHWOOD HS", "MAPLE AVE & ELM WAY", "NC 55 HWY & OAK ST"]);
});

test("street names the sheet cut short in a stop line are filled in from the directions", () => {
  const sheet = parseSheet(`07:00 AM Deadhead - OAK ST & ELM WAY 0 0 900.010
Proceed On OAK ST
Right Turn Onto LAKE OF THE PINES
Left Turn Onto MAPLEWOOD MEADOW RD
07:05 AM LAKE OF T & MAPLEWOOD ME RD 2 0 900.011
Proceed On MAPLEWOOD MEADOW RD
07:09 AM OAK ST & ELM WAY 1 0 900.012`);
  assert.equal(sheet.stops[1].description, "LAKE OF THE PINES & MAPLEWOOD MEADOW RD");
  assert.equal(sheet.stops[2].description, "OAK ST & ELM WAY");
  assert.equal(sheet.stops[0].description, "Deadhead - OAK ST & ELM WAY");
});

test("the street check accepts what the route builder accepts, and names it", async () => {
  const { buildStreetIndex, checkStreet, looseName } = await import("../src/lib/streetCheck");
  const idx = buildStreetIndex([line("Quailridge Drive", ["quailridge dr"], [[-78.7, 35.8], [-78.69, 35.8]])]);
  assert.equal(checkStreet(idx, "QUAILRIDGE RD"), "found");
  assert.equal(looseName(idx, "QUAILRIDGE RD"), "QUAILRIDGE DR");
  assert.equal(checkStreet(idx, "QUAILRID GE DR"), "found");
  assert.equal(looseName(idx, "QUAILRIDGE DR"), null);
  assert.equal(checkStreet(idx, "QUAILRUN DR"), "missing");
});
