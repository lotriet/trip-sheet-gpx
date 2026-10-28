import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSheet } from "../src/lib/engine/parseSheet";
import { cellsFor, linesFromCells, onewayOf, type RoadCell } from "../src/lib/engine/roads";
import { routeSheet } from "../src/lib/engine/route";
import type { RawLine } from "../src/lib/engine/types";

// Made-up streets.
test("a way stored in two cells is read once, with its name, route number and direction", () => {
  const way = { id: 7, h: "primary", n: "Oak Street", r: "NC 55;US 1", o: 1, c: [-78.71, 35.8, -78.69, 35.8] };
  const cells: RoadCell[] = [
    { ways: [way, { id: 8, h: "service", s: "parking_aisle", c: [-78.7, 35.8, -78.7, 35.801] }], schools: [["Oak High School", 35.8, -78.7]] },
    { ways: [way], schools: [] },
  ];
  const { lines, places } = linesFromCells(cells);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].keys, ["oak st", "nc 55", "us 1"]);
  assert.equal(lines[0].oneway, 1);
  assert.deepEqual(lines[0].coords, [[-78.71, 35.8], [-78.69, 35.8]]);
  assert.equal(places[0].level, "high");
});

test("roundabouts and motorways are one way unless tagged otherwise", () => {
  assert.equal(onewayOf({ junction: "roundabout" }), 1);
  assert.equal(onewayOf({ highway: "motorway" }), 1);
  assert.equal(onewayOf({ highway: "residential", oneway: "-1" }), -1);
  assert.equal(onewayOf({ highway: "motorway", oneway: "no" }), 0);
  assert.equal(onewayOf({ highway: "residential" }), 0);
});

test("only an area inside the county reads the road cells", () => {
  assert.deepEqual(cellsFor({ minLon: -78.71, minLat: 35.79, maxLon: -78.69, maxLat: 35.81 }), ["-1575_715", "-1575_716", "-1574_715", "-1574_716"]);
  assert.equal(cellsFor({ minLon: -80, minLat: 35.79, maxLon: -78.69, maxLat: 35.81 }), null);
});

const line = (name: string, key: string, coords: [number, number][]): RawLine => ({ name, keys: [key], coords, kind: "named", oneway: 0 });
const lines = [
  line("Maple Avenue", "maple ave", [[-78.71, 35.8], [-78.705, 35.8], [-78.7, 35.8]]),
  line("Elm Street", "elm st", [[-78.705, 35.795], [-78.705, 35.8], [-78.705, 35.805]]),
  line("Birch Lane", "birch ln", [[-78.7, 35.795], [-78.7, 35.8], [-78.7, 35.8025], [-78.7, 35.805]]),
  line("Pine Street", "pine st", [[-78.705, 35.805], [-78.7, 35.805], [-78.695, 35.805]]),
];
const sheet = parseSheet(`07:00 AM MAPLE AVE & ELM ST 0 0 900.010
Proceed On MAPLE AVE
Left Turn Onto BIRCH LN
07:03 AM 120 BIRCH LN - DOORSIDE 2 2 900.011
Proceed On BIRCH LN
07:06 AM BIRCH LN & PINE ST 2 0 900.012`);

test("a house-number stop sits where the route passes the house", async () => {
  const bare = await routeSheet(sheet, { lines, places: [] });
  assert.ok(bare.ok && bare.warnings.some((w) => /gives only a street name/.test(w.message)));
  const found = await routeSheet(sheet, { lines, places: [], addresses: [{ stop: sheet.stops[1].description, lon: -78.6998, lat: 35.8025 }] });
  assert.ok(found.ok);
  if (!found.ok) return;
  assert.equal(found.warnings.filter((w) => w.level === "warn").length, 0, JSON.stringify(found.warnings));
  assert.ok(Math.abs(found.stops[1].lat - 35.8025) < 0.0003);
});

test("a DOORSIDE house on the bus's left is called out", async () => {
  const r = await routeSheet(sheet, { lines, places: [], addresses: [{ stop: sheet.stops[1].description, lon: -78.7002, lat: 35.8025 }] });
  assert.ok(r.ok && r.warnings.some((w) => /bus's left/.test(w.message)));
});
