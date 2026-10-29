import assert from "node:assert/strict";
import { test } from "node:test";
import { routeFromDrive } from "../src/lib/driven";
import type { LonLat, RouteSuccess, Sheet } from "../src/lib/engine/types";

// Planned: east along a street, a left (north) at the corner, to the next stop.
const corner: LonLat = [-78.79, 35.8];
const east: LonLat[] = [0, 1, 2, 3, 4, 5].map((k) => [-78.8 + k * 0.002, 35.8]);
const north: LonLat[] = [1, 2, 3, 4, 5].map((k) => [-78.79, 35.8 + k * 0.002]);
const planned = {
  ok: true,
  coords: [...east, ...north],
  meters: 0,
  miles: 0,
  stops: [
    { index: 0, time: "6:00 AM", description: "A ST & B ST", stopId: null, stopLoad: null, runLoad: null, lat: 35.8, lon: -78.8, trackIndex: 0 },
    { index: 1, time: "6:05 AM", description: "C ST & D ST", stopId: null, stopLoad: null, runLoad: null, lat: 35.81, lon: -78.79, trackIndex: 10 },
  ],
  warnings: [{ level: "warn", stopIndex: 0, maneuverIndex: 0, message: "Turned onto C ST, but the angle was not a clear left." }],
  turnarounds: [],
  legs: [],
  turnMarks: [{ stopIndex: 0, maneuverIndex: 0, kind: "left", street: "C ST", trackIndex: 5, confirmed: false }],
  gpx: "",
  viaStreets: [],
} as unknown as RouteSuccess;
const sheet = {
  route: "GL1473",
  run: "1.001",
  description: "TEST",
  stops: [
    { time: "6:00 AM", description: "A ST & B ST", maneuvers: [{ kind: "left", street: "C ST" }] },
    { time: "6:05 AM", description: "C ST & D ST", maneuvers: [] },
  ],
} as unknown as Sheet;
const minuteOf = (t: number) => t / 60000;
// The bus stands 30 s at the first stop, drives the same streets, a few meters off the map's line.
const drive = [
  { lat: 35.8, lon: -78.8, t: 360 * 60000 },
  { lat: 35.8, lon: -78.8, t: 360 * 60000 + 30000 },
  ...[1, 2, 3, 4, 5].map((k) => ({ lat: 35.80003, lon: -78.8 + k * 0.002, t: 361 * 60000 + k * 10000 })),
  ...[1, 2, 3, 4, 5].map((k) => ({ lat: 35.8 + k * 0.002, lon: -78.78997, t: 362 * 60000 + k * 10000 })),
];

test("a recorded drive becomes the route, with the sheet's turn where the bus turned", () => {
  const made = routeFromDrive(sheet, planned, drive, { minuteOf });
  assert.ok(made);
  assert.equal(made.legsDriven, 1);
  const { route } = made;
  assert.ok(Math.abs(route.coords[route.coords.length - 1][1] - 35.81) < 1e-9, "ends where the bus did");
  assert.equal(route.turnMarks.length, 1);
  const at = route.coords[route.turnMarks[0].trackIndex];
  assert.ok(Math.abs(at[0] - corner[0]) < 0.0002 && Math.abs(at[1] - corner[1]) < 0.0002);
  assert.ok(!route.warnings.some((w) => w.level === "warn"), "the planned leg's warning no longer applies");
  assert.match(route.gpx, /recorded drive/);
});

test("a drive somewhere else leaves the planned route", () => {
  const elsewhere = drive.map((f) => ({ ...f, lat: f.lat + 0.05 }));
  assert.equal(routeFromDrive(sheet, planned, elsewhere, { minuteOf }), null);
});

// The map under the drive: A Street east, then C Street north from the corner.
const lines = [
  { name: "A Street", keys: ["a st"], coords: east, kind: "named", oneway: 0 },
  { name: "C Street", keys: ["c st"], coords: [corner, ...north], kind: "named", oneway: 0 },
] as const;

test("a stretch the sheet gives no directions for takes its turns from the map", () => {
  const bare = { ...sheet, stops: sheet.stops.map((s) => ({ ...s, maneuvers: [] })) } as unknown as Sheet;
  const unmarked = { ...planned, turnMarks: [] } as unknown as RouteSuccess;
  const made = routeFromDrive(bare, unmarked, drive, { minuteOf, lines: lines.map((l) => ({ ...l, keys: [...l.keys], coords: [...l.coords] })) });
  assert.ok(made);
  assert.deepEqual(made.route.turnMarks.map((t) => [t.kind, t.street]), [["left", "C St"]]);
  assert.match(made.route.gpx, /<name>Left on C St<\/name>/);
});

test("a turn the sheet already names is not cued twice from the map", () => {
  const made = routeFromDrive(sheet, planned, drive, { minuteOf, lines: lines.map((l) => ({ ...l, keys: [...l.keys], coords: [...l.coords] })) });
  assert.ok(made);
  assert.equal(made.route.turnMarks.length, 1);
  assert.equal(made.route.turnMarks[0].street, "C ST");
});

test("roundabout exits and ramps are named so a follower can draw them", async () => {
  const { maneuverPhrase } = await import("../src/lib/engine/gpx");
  const { turnPinsFromGpx } = await import("../src/lib/dayPlan");
  assert.equal(maneuverPhrase("right", "WHITE OAK CHURCH RD", "roundabout"), "Roundabout, right on White Oak Church Rd");
  assert.equal(maneuverPhrase("proceed", "I - 40", "ramp"), "Ramp, proceed on I - 40");
  const pins = turnPinsFromGpx('<trkpt lat="35.8" lon="-78.8"><name>Ramp, right on Wade Ave</name><type>turn</type></trkpt>');
  assert.equal(pins[0].kind, "right");
});
