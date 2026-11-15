import assert from "node:assert/strict";
import { test } from "node:test";
import { haversine } from "../src/lib/engine/geo";
import { parseSheet } from "../src/lib/engine/parseSheet";
import { routeSheet } from "../src/lib/engine/route";
import type { LonLat, RawLine } from "../src/lib/engine/types";

// Made-up streets. The bus comes south on Maple Rd into a roundabout that the
// map names Maple Rd too, stops where Birch Dr meets the ring, and leaves on
// Maple Rd. The exit was marked where the bus already was, before the ring,
// and the stop sat at the turn in (a real roundabout, 15 Nov 2026).
const C: LonLat = [-78.7, 35.8];
const R = { lon: 15 / 90280, lat: 15 / 110540 };
const onRing = (deg: number): LonLat => [C[0] + R.lon * Math.cos((deg * Math.PI) / 180), C[1] + R.lat * Math.sin((deg * Math.PI) / 180)];
const ring: LonLat[] = [];
for (let deg = 90; deg <= 450; deg += 30) ring.push(onRing(deg)); // counterclockwise, closed
const north = onRing(90);
const west = onRing(180);
const south = onRing(270);
const line = (key: string, coords: LonLat[], oneway = 0): RawLine => ({ name: key, keys: [key], coords, kind: "named", oneway });
const lines = [
  line("maple rd", [[-78.7, 35.805], [-78.7, 35.803], north]),
  line("maple rd", ring, 1),
  line("maple rd", [south, [-78.7, 35.797], [-78.7, 35.795]]),
  line("elm st", [[-78.702, 35.803], [-78.7, 35.803], [-78.698, 35.803]]),
  line("birch dr", [west, [-78.703, 35.8]]),
  line("oak st", [[-78.702, 35.797], [-78.7, 35.797], [-78.699, 35.797], [-78.698, 35.797]]),
  line("ash ct", [[-78.699, 35.796], [-78.699, 35.797], [-78.699, 35.798]]),
];
const sheet = parseSheet(`07:00 AM MAPLE RD & ELM ST 0 0 900.010
Proceed On MAPLE RD
Right Turn Onto ROUNDABOUT
07:02 AM BIRCH DR & ROUNDABOUT 1 1 900.011
Proceed On ROUNDABOUT
Right Turn Onto MAPLE RD
Left Turn Onto OAK ST
07:05 AM OAK ST & ASH CT 1 0 900.012`);

test("a roundabout exit on the street the bus came in on is marked where it leaves the ring", async () => {
  const r = await routeSheet(sheet, { lines, places: [] });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  const exit = r.turnMarks.find((t) => t.via === "roundabout");
  assert.ok(exit, JSON.stringify(r.turnMarks));
  assert.ok(haversine(r.coords[exit.trackIndex], south) < 3, `exit at ${r.coords[exit.trackIndex]}`);
});

test("a stop at a street and a roundabout sits on the ring where the street meets it", async () => {
  const r = await routeSheet(sheet, { lines, places: [] });
  assert.ok(r.ok);
  if (!r.ok) return;
  const stop = r.stops[1];
  assert.ok(haversine([stop.lon, stop.lat], west) < 5, `stop at ${stop.lat},${stop.lon}`);
  assert.ok(!r.warnings.some((w) => w.stopIndex === 1 && /gives only a street name/.test(w.message)));
});
