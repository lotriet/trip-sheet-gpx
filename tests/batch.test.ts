import assert from "node:assert/strict";
import { test } from "node:test";
import { autoGroup, buildTrips, describePage, gpxFileName, mergeIntoDay, minutesOf, newTripKey, runNumberOf, sortStopsByTime, splitRuns } from "../src/lib/batch";
import { buildGpx } from "../src/lib/engine/gpx";
import { classifyLocation, parseSheet } from "../src/lib/engine/parseSheet";

// Made-up runs on made-up streets.
const head = (run: string, school: string) => `Route: DEMO Description: ${school} Run: ${run}\nDriver Directions by Route`;

const A1 = `${head("900.101", "OAK ACADEMY 01")}
07:10 AM Deadhead - MAPLE AVE & ELM DR 0 0 900.010
Proceed On MAPLE AVE
Right Turn Onto BIRCH RD
07:15 AM BIRCH RD & CEDAR LN 4 4 900.011
Proceed On BIRCH RD
Left Turn Onto PINE CT`;
const A2 = `${head("900.101", "OAK ACADEMY 01")}
Right Turn Onto WILLOW WAY
07:22 AM WILLOW WAY & ASH ST 3 7 900.012
Proceed On WILLOW WAY
07:30 AM SCHOOL: OAK ACADEMY 7 0 900.000`;
const B = `${head("900.202", "PINE MIDDLE 02")}
06:40 AM Deadhead - ASH ST & ELM DR 0 0 900.020
Proceed On ASH ST
Left Turn Onto SPRUCE LN
06:50 AM SCHOOL: PINE MIDDLE 5 0 900.000`;
const C = `${head("900.303", "ELM HIGH 03")}
08:05 AM Deadhead - CEDAR LN & ASH ST 0 0 900.030
Proceed On CEDAR LN
Turn Around On CEDAR LN
08:12 AM SCHOOL: ELM HIGH 9 0 900.000`;

test("reads run numbers and times, forgiving OCR slips", () => {
  assert.equal(runNumberOf("Route: X Description: Y Run: 900.101"), "900.101");
  assert.equal(runNumberOf("Run; 9OO.1l0"), "900.110");
  assert.equal(runNumberOf("no header here"), null);
  assert.equal(minutesOf("2:28 PM"), 14 * 60 + 28);
  assert.equal(minutesOf("12:05 PM"), 12 * 60 + 5);
  assert.equal(minutesOf("12:05 AM"), 5);
  assert.equal(minutesOf(""), null);
});

test("splits a shuffled pile of photos into trips in driving order", () => {
  // Photo order as taken: second page first, a different run in between.
  const pages = [A2, C, B, A1].map((text, photo) => describePage({ photo, name: `p${photo}`, text }));
  const keys = autoGroup(pages);
  const trips = buildTrips(pages, keys);
  assert.deepEqual(trips.map((t) => t.run), ["900.202", "900.101", "900.303"]);
  const a = trips[1];
  assert.deepEqual(a.pages.map((p) => p.photo), [3, 0], "first page before the continuation page");
  assert.equal(a.firstTime, "7:10 AM");
  assert.equal(a.stops, 4);
  // The continuation page's first direction joins the last stop of page one.
  assert.deepEqual(a.sheet.stops[1].maneuvers.map((m) => m.street), ["BIRCH RD", "PINE CT", "WILLOW WAY"]);
  assert.equal(a.turns, 6);
});

test("a page without a readable run number joins the previous photo's trip", () => {
  const noHeader = A2.replace(/Route:.*\n/, "");
  const pages = [A1, noHeader, B].map((text, photo) => describePage({ photo, name: "", text }));
  assert.equal(pages[1].run, null);
  const keys = autoGroup(pages);
  assert.deepEqual(keys, ["900.101", "900.101", "900.202"]);
});

test("a misread run number snaps onto the matching trip", () => {
  const slip = A2.replace("Run: 900.101", "Run: 900.191");
  const pages = [A1, slip, B].map((text, photo) => describePage({ photo, name: "", text }));
  const trips = buildTrips(pages, autoGroup(pages));
  assert.equal(trips.length, 2);
  assert.equal(trips.find((t) => t.run === "900.101")?.pages.length, 2);
});

test("two first pages with run numbers one digit apart stay separate trips", () => {
  const other = A1.replace("Run: 900.101", "Run: 900.102");
  const pages = [A1, other].map((text, photo) => describePage({ photo, name: "", text }));
  assert.equal(buildTrips(pages, autoGroup(pages)).length, 2);
});

test("moving a photo to a new trip makes a new row", () => {
  const pages = [A1, A2].map((text, photo) => describePage({ photo, name: "", text }));
  const keys = autoGroup(pages);
  assert.equal(buildTrips(pages, keys).length, 1);
  const moved = [keys[0], newTripKey(keys)];
  assert.equal(moved[1], "trip-1");
  assert.equal(buildTrips(pages, moved).length, 2);
});

test("names one GPX per run", () => {
  const used = new Set<string>();
  assert.equal(gpxFileName("900.101", 0, used), "run_900101.gpx");
  assert.equal(gpxFileName("900.101", 1, used), "run_900101_2.gpx");
  assert.equal(gpxFileName("", 2, used), "run_03.gpx");
});

test("new runs slot into the day list by start time and replace the same run", () => {
  const day = [
    { run: "900.202", firstTime: "6:40 AM", v: "old" },
    { run: "900.303", firstTime: "8:05 AM", v: "old" },
  ];
  const merged = mergeIntoDay(day, [
    { run: "900.101", firstTime: "7:10 AM", v: "new" },
    { run: "900.303", firstTime: "8:05 AM", v: "new" },
  ]);
  assert.deepEqual(merged.map((r) => `${r.run}:${r.v}`), ["900.202:old", "900.101:new", "900.303:new"]);
});

test("each run's GPX is a track with stop waypoints and no route element", () => {
  const sheet = parseSheet(B);
  const gpx = buildGpx(
    sheet,
    [[-78.7, 35.8], [-78.71, 35.81]],
    sheet.stops.map((s, index) => ({ ...s, index, lat: 35.8 + index / 100, lon: -78.7 })) as never,
  );
  assert.match(gpx, /<trk>[\s\S]*<trkseg>[\s\S]*<trkpt [\s\S]*<\/trkseg><\/trk>/);
  assert.equal((gpx.match(/<wpt /g) ?? []).length, 2);
  assert.doesNotMatch(gpx, /<rte/);
});

/** The same pipeline the app runs on photos or pasted text. */
function tripsFrom(texts: string[]) {
  const pages = texts
    .flatMap((text, photo) => splitRuns(text).map((chunk) => ({ photo, name: "", text: chunk })))
    .map(describePage);
  return buildTrips(pages, autoGroup(pages));
}

// A made-up afternoon run printed on two pages.
const P1 = `${head("900.404", "BIRCH ELEMENTARY 04")}
03:48 PM Deadhead - SPRUCE LN & MAPLE AVE 0 0 900.040
Proceed On MAPLE AVE
Left Turn Onto BIRCH ELEMENTARY
03:55 PM SCHOOL: BIRCH ELEMENTARY 0 20 900.000
Proceed On BIRCH ELEMENTARY
Right Turn Onto OAK ST
04:01 PM OAK ST & ELM DR 10 10 900.041
Left Turn Onto ELM DR`;
const P2 = `${head("900.404", "BIRCH ELEMENTARY 04")}
Right Turn Onto CEDAR LN
04:12 PM CEDAR LN & ASH ST 10 0 900.042
Proceed On CEDAR LN
Turn Around On CEDAR LN
04:22 PM 1 OAK ACADEMY 0 0 @AB.012`;

test("pages pasted out of order come out in time order with their directions", () => {
  // The reported bug: second page first, so a 4:22 PM arrival was followed by the 3:48 PM Deadhead.
  const trips = tripsFrom([`${P2}\n${P1}`]);
  assert.equal(trips.length, 1);
  const stops = trips[0].sheet.stops;
  assert.deepEqual(stops.map((s) => s.time), ["3:48 PM", "3:55 PM", "4:01 PM", "4:12 PM", "4:22 PM"]);
  assert.match(stops[0].description, /^Deadhead/);
  // Page two's leading direction belongs to the last stop on page one.
  assert.deepEqual(stops[2].maneuvers.map((m) => `${m.kind}:${m.street}`), ["left:ELM DR", "right:CEDAR LN"]);
  assert.deepEqual(stops[3].maneuvers.map((m) => m.kind), ["proceed", "turnaround"]);
});

test("sorts stops by time, keeping directions attached, across noon", () => {
  const sheet = sortStopsByTime({
    route: "",
    description: "",
    run: "",
    stops: [
      { time: "1:05 PM", description: "B", stopLoad: null, runLoad: null, stopId: null, maneuvers: [{ kind: "left", street: "ASH ST" }] },
      { time: "", description: "B2", stopLoad: null, runLoad: null, stopId: null, maneuvers: [] },
      { time: "11:50 AM", description: "A", stopLoad: null, runLoad: null, stopId: null, maneuvers: [{ kind: "right", street: "OAK ST" }] },
      { time: "12:10 PM", description: "M", stopLoad: null, runLoad: null, stopId: null, maneuvers: [] },
    ],
  });
  assert.deepEqual(sheet.stops.map((s) => s.description), ["A", "M", "B", "B2"]);
  assert.equal(sheet.stops[0].maneuvers[0].street, "OAK ST");
});

test("without run numbers, a Deadhead after a school arrival starts a new trip", () => {
  const noRun = (t: string) => t.replace(/Route:.*\n/, "");
  // One photo holding the end of one run and the start of the next, times jumping back.
  const trips = tripsFrom([`${noRun(P1)}\n${noRun(B)}`]);
  assert.equal(trips.length, 2);
  assert.deepEqual(trips.map((t) => t.firstTime), ["6:40 AM", "3:48 PM"]);
  assert.match(trips[1].sheet.stops[0].description, /^Deadhead/);
  assert.equal(trips[1].stops, 3);
});

test("without run numbers, a continuation page joins the photo before it", () => {
  const noRun = (t: string) => t.replace(/Route:.*\n/, "");
  const trips = tripsFrom([noRun(P1), noRun(P2), noRun(C)]);
  assert.equal(trips.length, 2);
  assert.deepEqual(trips.map((t) => t.firstTime), ["8:05 AM", "3:48 PM"]);
  assert.equal(trips[1].stops, 5);
  assert.equal(trips[1].pages.length, 2);
});

test("splitRuns moves the page header with the run it belongs to", () => {
  const chunks = splitRuns(`${C}\n10/05/2026 Report Name: --MASTER\n${B}`);
  assert.equal(chunks.length, 2);
  assert.match(chunks[1], /^10\/05\/2026[\s\S]*Run: 900\.202/);
  assert.doesNotMatch(chunks[0], /900\.202/);
});

test("a whole shuffled text, parsed as one sheet, is put back in order", () => {
  // No page split at all: the continuation page's opening direction is an empty card.
  const parsed = parseSheet(`${P2}\n${P1}`);
  assert.equal(parsed.stops[0].time, "");
  assert.equal(parsed.stops[0].description, "");
  const sheet = sortStopsByTime(parsed);
  assert.deepEqual(sheet.stops.map((s) => s.time), ["3:48 PM", "3:55 PM", "4:01 PM", "4:12 PM", "4:22 PM"]);
  assert.deepEqual(sheet.stops[2].maneuvers.map((m) => m.street), ["ELM DR", "CEDAR LN"]);
});

test("opening directions with no stop above them go to the run's start", () => {
  // The Deadhead line was printed (or read) after its directions.
  const sheet = sortStopsByTime(
    parseSheet(`${head("900.505", "ASH ACADEMY 05")}
Proceed On SPRUCE LN
Right Turn Onto ASH ST
07:00 AM Deadhead - SPRUCE LN & OAK ST 0 0 900.050
07:06 AM ASH ST & PINE CT 2 2 900.051
Left Turn Onto PINE CT`),
  );
  assert.equal(sheet.stops.length, 2);
  assert.match(sheet.stops[0].description, /^Deadhead/);
  assert.deepEqual(sheet.stops[0].maneuvers.map((m) => m.street), ["SPRUCE LN", "ASH ST"]);
});

test("DOORSIDE and a campus street number don't spoil a stop's place", () => {
  assert.deepEqual(classifyLocation("Deadhead - OAK ST & ELM DR - DOORSIDE"), { kind: "intersection", a: "OAK ST", b: "ELM DR" });
  assert.deepEqual(classifyLocation("OAK ST & ELM DR DOORSIDE"), { kind: "intersection", a: "OAK ST", b: "ELM DR" });
  assert.deepEqual(classifyLocation("OAK ST & ELM DR (DOORSIDE)"), { kind: "intersection", a: "OAK ST", b: "ELM DR" });
  assert.deepEqual(classifyLocation("Deadhead - 1 OAK HS"), { kind: "school", name: "OAK HS" });
});

test("reads a run number with a lost dot and a bracket for a 1", () => {
  assert.equal(runNumberOf("Run: 900 10]"), "900.101");
});
