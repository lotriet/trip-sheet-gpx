import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDayGpx, runGpxParts } from "../src/lib/dayPlan";
import { haversine } from "../src/lib/engine/geo";
import { parseSheet } from "../src/lib/engine/parseSheet";
import { routeSheet } from "../src/lib/engine/route";
import type { LonLat, RawLine } from "../src/lib/engine/types";

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

test("a highway leg longer than 8 km is driven by the road router, not dropped", async () => {
  // Two streets 12 km apart with no map road between them, as on I-40.
  const far = [
    line("Maple Avenue", ["maple ave"], [[-78.71, 35.8], [-78.705, 35.8], [-78.7, 35.8]]),
    line("Elm Street", ["elm st"], [[-78.705, 35.795], [-78.705, 35.8], [-78.705, 35.805]]),
    line("Wade Avenue", ["wade ave"], [[-78.57, 35.8], [-78.565, 35.8], [-78.56, 35.8]]),
  ];
  const sheet = parseSheet(`07:00 AM MAPLE AVE & ELM ST
Proceed On MAPLE AVE
Proceed Onto WADE AVE
07:30 AM WADE AVE @ THE END OF THE ROAD`);
  let asked = 0;
  // Roads through every point it is given, as a real router would.
  const router = async (points: [number, number][]) => {
    asked++;
    return points;
  };
  const result = await routeSheet(sheet, { lines: far, places: [] }, {}, router);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) return;
  assert.ok(asked > 0);
  assert.doesNotMatch(result.warnings.map((w) => w.message).join("\n"), /Couldn't stay on the sheet/);
  assert.ok(result.coords.some(([lon]) => lon > -78.6), "the track reaches Wade Ave");
});

test("a roundabout exit is the way the road goes, not the sheet's 'right turn onto'", async () => {
  const { roundaboutWays } = await import("../src/lib/engine/geo");
  // South into the circle, out to the east: round to the left (3rd exit).
  const south: LonLat[] = [0, 1, 2, 3, 4, 5].map((k) => [-78.8, 35.81 - k * 0.0005]);
  const east: LonLat[] = [1, 2, 3, 4, 5].map((k) => [-78.8 + k * 0.0005, 35.8075]);
  const track = [...south, ...east];
  const marks = roundaboutWays(track, [{ trackIndex: 5, kind: "right", street: "GULL POINT RD", via: "roundabout" }]);
  assert.equal(marks[0].kind, "left");
  // Out to the west it is the first exit, a right; straight on, it says so.
  const west: LonLat[] = [1, 2, 3, 4, 5].map((k) => [-78.8 - k * 0.0005, 35.8075]);
  assert.equal(roundaboutWays([...south, ...west], [{ trackIndex: 5, kind: "left", street: "X", via: "roundabout" }])[0].kind, "right");
  const on: LonLat[] = [6, 7, 8, 9, 10].map((k) => [-78.8, 35.81 - k * 0.0005]);
  assert.equal(roundaboutWays([...south, ...on], [{ trackIndex: 5, kind: "right", street: "X", via: "roundabout" }])[0].kind, "proceed");
});

test("a turn placed where the new street's name starts moves back to the corner", async () => {
  const { turnsAtCorners, haversine: dist } = await import("../src/lib/engine/geo");
  // South on NC 55, right (west) at the corner; the map names the road
  // Green Level West Rd only from 130 m in.
  const south: LonLat[] = [0, 1, 2, 3, 4, 5, 6].map((k) => [-78.871, 35.7905 - k * 0.0005]);
  const west: LonLat[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((k) => [-78.871 - k * 0.0002, 35.7875]);
  const track = [...south, ...west];
  const corner = 6;
  const late = track.findIndex((p) => dist(p, track[corner]) > 125 && p[1] === 35.7875);
  const marks = turnsAtCorners(track, [{ trackIndex: late, kind: "right", street: "GREEN LEVEL WEST RD" }]);
  assert.equal(marks[0].trackIndex, corner);
  // At the corner already, it stays.
  assert.equal(turnsAtCorners(track, [{ trackIndex: corner, kind: "right", street: "X" }])[0].trackIndex, corner);
  // Never back past the cue before it.
  const kept = turnsAtCorners(track, [{ trackIndex: corner + 1, kind: "proceed", street: "Y" }, { trackIndex: late, kind: "right", street: "X" }]);
  assert.equal(kept[1].trackIndex, late);
});

test("a late turn moves back to its corner even with the next corner just after it", async () => {
  const { turnsAtCorners, haversine: dist } = await import("../src/lib/engine/geo");
  // South, right onto the road the map names late, then right again 40 m on (Oakfield Ave).
  const south: LonLat[] = [0, 1, 2, 3, 4, 5, 6].map((k) => [-78.871, 35.7905 - k * 0.0005]);
  const west: LonLat[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => [-78.871 - k * 0.0002, 35.7875]);
  const north: LonLat[] = [1, 2, 3, 4, 5, 6].map((k) => [-78.8728, 35.7875 + k * 0.0003]);
  const track = [...south, ...west, ...north];
  const corner = 6;
  const late = west.findIndex((p) => dist(p, track[corner]) > 120) + south.length;
  const next = south.length + west.length - 1;
  assert.ok(dist(track[late], track[next]) < 60, "the next corner is close after the late cue");
  const marks = turnsAtCorners(track, [
    { trackIndex: late, kind: "right", street: "GREEN LEVEL WEST RD" },
    { trackIndex: next, kind: "right", street: "OAKFIELD AVE" },
  ]);
  assert.equal(marks[0].trackIndex, corner);
  assert.equal(marks[1].trackIndex, next);
});
