import assert from "node:assert/strict";
import { test } from "node:test";
import { cornerInDirection, fixJoinedCorner } from "../src/lib/joinedCorner";
import { sheetProblems, type Trip } from "../src/lib/batch";
import type { Sheet, Stop } from "../src/lib/engine/types";

const stop = (time: string, description: string, streets: string[]): Stop => ({
  time,
  description,
  stopLoad: null,
  runLoad: null,
  stopId: null,
  maneuvers: streets.map((street) => ({ kind: "right", street })),
});

// Made-up streets; the shape of a real misread: stop 2's location lost, and
// stop 3's corner joined onto the last direction of stop 2.
const joined: Sheet = {
  route: "DEMO",
  description: "OAK MS",
  run: "900.001",
  stops: [
    stop("6:05 AM", "MAPLE AVE & ELM ST", ["FINCH VALLEY LN"]),
    stop("6:09 AM", "", ["LARK RIDGE LN", "GRAND HERON BOULEVARD AND SPARROW LN"]),
  ],
};

test("a direction naming a corner is a joined stop line", () => {
  assert.deepEqual(cornerInDirection("GRAND HERON BOULEVARD AND SPARROW LN"), {
    street: "GRAND HERON BOULEVARD",
    corner: "GRAND HERON BOULEVARD & SPARROW LN",
  });
  assert.deepEqual(cornerInDirection("QUAIL FARM RD @ POOL LOT")?.street, "QUAIL FARM RD");
  assert.equal(cornerInDirection("LARK RIDGE LN"), null);
  assert.equal(cornerInDirection("ROCK AND ROLL"), null, "one word a side is a name, not a corner");
});

test("fix it: the direction keeps its street and the corner becomes the next stop", () => {
  const fix = fixJoinedCorner(joined, 1, 1);
  assert.ok(fix);
  assert.deepEqual(fix.sheet.stops[1].maneuvers.map((m) => m.street), ["LARK RIDGE LN", "GRAND HERON BOULEVARD"]);
  assert.equal(fix.sheet.stops[2].description, "GRAND HERON BOULEVARD & SPARROW LN");
  assert.equal(fix.sheet.stops[2].time, "");
  assert.match(fix.says, /new stop 3\. Add its time/);
  assert.equal(joined.stops.length, 2, "the sheet passed in is not changed");
});

test("fix it: an empty next stop gets the corner; a stop that already has it is left alone", () => {
  const withEmptyNext = { ...joined, stops: [...joined.stops, stop("6:11 AM", "", ["SPARROW LN"])] };
  const a = fixJoinedCorner(withEmptyNext, 1, 1)!;
  assert.equal(a.sheet.stops.length, 3);
  assert.equal(a.sheet.stops[2].description, "GRAND HERON BOULEVARD & SPARROW LN");
  assert.equal(a.sheet.stops[2].time, "6:11 AM");

  const withNext = { ...joined, stops: [...joined.stops, stop("6:11 AM", "SPARROW LN & GRAND HERON BOULEVARD", [])] };
  const b = fixJoinedCorner(withNext, 1, 1)!;
  assert.equal(b.sheet.stops.length, 3);
  assert.match(b.says, /Stop 3 already has/);
});

test("the sheet checks name the joined line and the stop with no location", () => {
  const trip = { run: "900.001", text: "", sheet: joined } as unknown as Trip;
  const problems = sheetProblems([trip]).join("\n");
  assert.match(problems, /stop 2 at 6:09 AM has no name/);
  assert.match(problems, /names two streets/);
});
