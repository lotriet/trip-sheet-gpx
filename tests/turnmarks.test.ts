import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDayGpx, runGpxParts } from "../src/lib/dayPlan";
import { haversine } from "../src/lib/engine/geo";
import { parseSheet } from "../src/lib/engine/parseSheet";
import { routeSheet } from "../src/lib/engine/route";
import type { RawLine } from "../src/lib/engine/types";

// Made-up streets on a grid.
const line = (name: string, keys: string[], coords: [number, number][]): RawLine => ({ name, keys, coords, kind: "named", oneway: 0 });
const lines = [
  line("Maple Avenue", ["maple ave"], [[-78.71, 35.8], [-78.705, 35.8], [-78.7, 35.8]]),
  line("Elm Street", ["elm st"], [[-78.705, 35.795], [-78.705, 35.8], [-78.705, 35.805]]),
  line("Birch Lane", ["birch ln"], [[-78.7, 35.795], [-78.7, 35.8], [-78.7, 35.805]]),
];
const sheet = parseSheet(`07:00 AM MAPLE AVE & ELM ST
Proceed On MAPLE AVE
Left Turn Onto BIRCH LN
07:06 AM BIRCH LN & MAPLE AVE`);

test("a printed turn is marked on the track point where the router turned", async () => {
  const result = await routeSheet(sheet, { lines, places: [] });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) return;
  assert.equal(result.turnMarks.length, 1);
  const mark = result.turnMarks[0];
  assert.equal(mark.kind, "left");
  assert.equal(mark.confirmed, true);
  // Maple Ave meets Birch Ln at -78.7, 35.8.
  assert.ok(haversine(result.coords[mark.trackIndex], [-78.7, 35.8]) < 5);
  assert.match(result.gpx, /<trkpt lat="35\.800000" lon="-78\.700000"><name>Left on Birch Ln<\/name><type>turn<\/type><\/trkpt>/);
});

test("a via detour keeps the turn mark on the same intersection", async () => {
  const result = await routeSheet(sheet, { lines, places: [] }, { vias: [{ lat: 35.808, lon: -78.705 }] });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) return;
  const mark = result.turnMarks[0];
  assert.ok(haversine(result.coords[mark.trackIndex], [-78.7, 35.8]) < 5);
});

test("the day file keeps each run's directions and turn points", async () => {
  const result = await routeSheet(sheet, { lines, places: [] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const run = {
    route: "DEMO",
    description: "OAK HS",
    run: "900.101",
    firstTime: "7:00 AM",
    coords: result.coords,
    stops: result.stops.map((s) => ({ time: s.time, description: s.description, lat: s.lat, lon: s.lon })),
    gpx: result.gpx,
  };
  const day = buildDayGpx([run, run], [{ coords: [], routed: false }]);
  assert.equal(runGpxParts(day).turns.size, 2);
  assert.match(day, /<desc>DEMO run 900\.101\. [^<]*Left on Birch Ln\.<\/desc>/);
});

test("a run saved before turn points is flagged for a rebuild", async () => {
  const { lacksTurnPoints } = await import("../src/lib/dayPlan");
  const result = await routeSheet(sheet, { lines, places: [] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(lacksTurnPoints(result.gpx), false);
  assert.equal(lacksTurnPoints(result.gpx.replace(/<trkpt ([^>]*)><name>[^<]*<\/name><type>[^<]*<\/type><\/trkpt>/g, "<trkpt $1/>")), true);
});

test("a roundabout line is driven through, not searched for as a street", async () => {
  const withRoundabout = parseSheet(`07:00 AM MAPLE AVE & ELM ST
Proceed On MAPLE AVE
Proceed Onto ROUNDABOUT
Proceed Onto MAPLE AVE
Left Turn Onto BIRCH LN
07:06 AM BIRCH LN & MAPLE AVE`);
  const result = await routeSheet(withRoundabout, { lines, places: [] });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) return;
  assert.doesNotMatch(result.warnings.map((w) => w.message).join("\n"), /ROUNDABOUT/);
  assert.equal(result.turnMarks.length, 1);
  assert.ok(haversine(result.coords[result.turnMarks[0].trackIndex], [-78.7, 35.8]) < 5);
});

test("entering and going around a roundabout, then its exit, follow the sheet", async () => {
  // The wording on a real sheet: enter with a right, go around with a left,
  // then the street to leave on. None of these names a road called ROUNDABOUT.
  const sheet = parseSheet(`07:00 AM MAPLE AVE & ELM ST
Proceed On MAPLE AVE
Right Turn Onto ROUNDABOUT
Left Turn On ROUNDABOUT
Left Turn Onto BIRCH LN
07:06 AM BIRCH LN & MAPLE AVE ROUNDABOUT`);
  const result = await routeSheet(sheet, { lines, places: [] });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) return;
  const messages = result.warnings.map((w) => w.message).join("\n");
  assert.doesNotMatch(messages, /ROUNDABOUT|angle|almost straight|approximate/);
  const exit = result.turnMarks.find((m) => m.street === "BIRCH LN");
  assert.ok(exit, "the exit is marked where the bus joins Birch Ln");
  assert.equal(exit.kind, "left");
  assert.ok(haversine(result.coords[exit.trackIndex], [-78.7, 35.8]) < 5);
});

test("a saved run's GPX gives back its turn pins for the map", async () => {
  const { turnPinsFromGpx } = await import("../src/lib/dayPlan");
  const result = await routeSheet(sheet, { lines, places: [] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(turnPinsFromGpx(result.gpx), [{ lat: 35.8, lon: -78.7, label: "Left on Birch Ln", kind: "left", confirmed: true }]);
});
