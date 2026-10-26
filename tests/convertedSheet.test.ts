import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { autoGroup, buildTrips, describePage, splitRuns } from "../src/lib/batch";
import { classifyLocation } from "../src/lib/engine/parseSheet";

// Made-up streets in the layout of a converted photo/scan: "Run 900.101 – ..." headings, en dashes.
const text = readFileSync(new URL("./fixtures/converted_sheet_example.txt", import.meta.url), "utf8");

test("a converted multi-run sheet becomes one trip per run", () => {
  const pages = splitRuns(text).map((t) => describePage({ photo: -1, name: "Pasted text", text: t }));
  const trips = buildTrips(pages, autoGroup(pages));
  assert.deepEqual(
    trips.map((t) => [t.run, t.sheet.route, t.sheet.description, t.stops, t.turns]),
    [
      ["900.101", "DEMO42", "OAK HS 01", 4, 10],
      ["900.102", "DEMO42", "OAK HS 02 (DB)", 4, 11],
      ["900.203", "DEMO42", "PINE MS 03", 3, 6],
    ],
  );
});

test("dashes and start/end notes are not part of a stop's streets", () => {
  const [first, second] = splitRuns(text).map((t) => describePage({ photo: -1, name: "", text: t }));
  const trips = buildTrips([first, second], autoGroup([first, second]));
  const stops = trips[0].sheet.stops;
  assert.deepEqual(classifyLocation(stops[0].description), { kind: "school", name: "OAK HS" });
  assert.deepEqual(classifyLocation(stops[1].description), { kind: "intersection", a: "ELM ST", b: "BIRCH LN" });
  assert.deepEqual(classifyLocation(stops[2].description), { kind: "end", street: "CEDAR CT" });
  assert.deepEqual(stops[1].maneuvers.map((m) => m.kind), ["proceed", "right", "turnaround"]);
  const deadhead = trips[1].sheet.stops[0];
  assert.equal(deadhead.time, "6:35 AM");
  assert.deepEqual(classifyLocation(deadhead.description), { kind: "school", name: "OAK HS" });
});
