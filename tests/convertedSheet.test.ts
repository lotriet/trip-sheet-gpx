import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { autoGroup, buildTrips, describePage, sheetProblems, splitRuns } from "../src/lib/batch";
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

test("a converted sheet with numbered directions passes the checks", () => {
  const converted = readFileSync(new URL("./fixtures/gl1473_am_converted.md", import.meta.url), "utf8");
  const pages = splitRuns(converted).map((t) => describePage({ photo: -1, name: "am.md", text: t }));
  const trips = buildTrips(pages, autoGroup(pages));
  assert.deepEqual(trips.map((t) => [t.run, t.sheet.stops.length]), [
    ["492.007", 16],
    ["502.001", 7],
    ["501.002", 7],
  ]);
  assert.equal(trips.reduce((n, t) => n + t.sheet.stops.reduce((m, s) => m + s.maneuvers.length, 0), 0), 126);
  assert.deepEqual(sheetProblems(trips), []);
});

test("the checks catch a missing time, a time going back, and a broken chain", () => {
  const broken = `Run 900.101 – OAK HS 01

06:10 AM – 1 OAK HS
1. Proceed On OAK HS
2. Right Turn Onto ELM ST

06:05 AM – ELM ST & BIRCH LN
1. Proceed On ELM ST

06:20 AM – SCHOOL: OAK HS

---

Run 900.102 – PINE MS 02

07:00 AM – Deadhead - SCHOOL: PINE MS
1. Proceed On PINE MS

07:10 AM – CEDAR CT @ THE END OF SIDEWALK`;
  const pages = splitRuns(broken).map((t) => describePage({ photo: -1, name: "x.md", text: t }));
  const problems = sheetProblems(buildTrips(pages, autoGroup(pages)));
  assert.ok(problems.some((p) => /stop 2 at 6:05 AM is earlier/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /starts at SCHOOL: PINE MS, but the run before ends at SCHOOL: OAK HS/.test(p)), problems.join("\n"));
});
