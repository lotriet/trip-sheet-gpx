import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSheet } from "../src/lib/engine/parseSheet";
import { ROUTER_CHECK_METERS, routeSheet } from "../src/lib/engine/route";
import type { LonLat, RawLine } from "../src/lib/engine/types";

// Made-up streets only. Where the map has a gap, the road router crosses it
// by the quickest roads, which may not be the printed ones. A long crossing
// is a warning the driver sees; a short hop stays a note (audit, 15 Nov
// 2026: a 1.9 mi crossing showed only as a hidden note).

const line = (name: string, keys: string[], coords: LonLat[]): RawLine => ({ name, keys, coords, kind: "named", oneway: 0 });
const sheet = parseSheet(`07:00 AM Deadhead - MAPLE AVE 0 0 900.010
Proceed On MAPLE AVE
Left Turn Onto BIRCH LN
07:05 AM BIRCH LN 2 0 900.011`);
const router = async (pts: LonLat[]) => [pts[0], [(pts[0][0] + pts.at(-1)![0]) / 2, 35.8] as LonLat, pts.at(-1)!];

async function crossing(mapleFrom: number, mapleTo: number) {
  const lines = [
    line("Maple Avenue", ["maple ave"], [[mapleFrom, 35.8], [mapleTo, 35.8]]),
    line("Birch Lane", ["birch ln"], [[-78.7, 35.79], [-78.7, 35.8], [-78.7, 35.81]]),
  ];
  const r = await routeSheet(sheet, { lines, places: [] }, {}, router);
  assert.equal(r.ok, true);
  return r.ok ? r.warnings : [];
}

test("a long way chosen by the road router is a warning, with how far", async () => {
  // Over a kilometre from Maple Avenue to Birch Lane.
  const warnings = await crossing(-78.72, -78.71);
  const gap = warnings.find((w) => /gap before BIRCH LN/.test(w.message));
  assert.ok(gap, JSON.stringify(warnings));
  assert.equal(gap.level, "warn");
  assert.match(gap.message, /chose the way for \d+\.\d mi\. Check it follows the printed streets\./);
});

test("a short hop over a gap stays a note", async () => {
  // A short Maple Avenue about 300 m from Birch Lane: under the check
  // distance.
  assert.ok(300 < ROUTER_CHECK_METERS);
  const warnings = await crossing(-78.7034, -78.7024);
  const gap = warnings.find((w) => /gap before BIRCH LN/.test(w.message));
  assert.ok(gap, JSON.stringify(warnings));
  assert.equal(gap.level, "info");
  assert.match(gap.message, /the road router joined it\./);
});
