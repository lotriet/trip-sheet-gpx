import assert from "node:assert/strict";
import { test } from "node:test";
import { autoGroup, buildTrips, describePage, dropDuplicatePages } from "../src/lib/batch";

// Made-up runs on made-up streets.
const head = (run: string) => `Route: DEMO Description: MADE UP Run: ${run}\nDriver Directions by Route`;
const R1 = `${head("700.116")}
02:28 PM Deadhead - 1 OAK HS 0 0 700.X01
Proceed On OAK HS
Right Turn Onto BIRCH RD
02:35 PM BIRCH RD & CEDAR LN 4 4 700.011
Proceed On BIRCH RD
02:37 PM BIRCH RD & PINE CT 2 6 700.012`;
const R2a = `${head("700.108")}
03:05 PM Deadhead - MAPLE AVE & ELM DR 0 0 700.X02
Proceed On MAPLE AVE
Left Turn Onto WILLOW WAY
03:20 PM WILLOW WAY & ASH ST 3 3 700.021
Right Turn Onto ASH ST
03:27 PM ASH ST & FIR LN 2 5 700.022`;
const R2b = `${head("700.108")}
Right Turn Onto FIR LN
03:28 PM FIR LN & ELM DR 5 0 700.023
Proceed On ELM DR
03:29 PM ELM DR & MAPLE AVE 0 0 700.X03`;
const R3a = `${head("700.101")}
03:48 PM Deadhead - SPRUCE LN & ELM DR 0 0 700.X04
Proceed On SPRUCE LN
Left Turn Onto ALDER DR
04:10 PM ALDER DR & YEW CT 9 9 700.031`;
const R3b = `${head("700.101")}
Left Turn Onto YEW CT
04:12 PM YEW CT & HOLLY LN 5 4 700.032
Right Turn Onto HOLLY LN
04:22 PM 1 OAK HS 0 0 700.X05`;

const all = [R1, R2a, R2b, R3a, R3b];
const shuffles = [
  [0, 1, 2, 3, 4],
  [4, 2, 0, 3, 1],
  [2, 4, 1, 0, 3],
  [3, 1, 4, 2, 0],
  [1, 0, 4, 3, 2],
];

function group(order: number[], edit: (t: string, i: number) => string = (t) => t) {
  const pages = order.map((i, photo) => describePage({ photo, name: `p${photo}`, text: edit(all[i], i) }));
  return buildTrips(pages, autoGroup(pages)).map((t) => `${t.run}:${t.pages.length}:${t.stops}`);
}

test("grouping does not depend on the photo order", () => {
  for (const order of shuffles) {
    assert.deepEqual(group(order), ["700.116:1:3", "700.108:2:5", "700.101:2:4"], `order ${order}`);
  }
});

test("a continuation page with an unreadable run number joins the run its times continue", () => {
  const blank = (t: string, i: number) => (i === 2 || i === 4 ? t.replace(/Run: \S+/, "Run: ") : t);
  for (const order of shuffles) {
    assert.deepEqual(group(order, blank), ["700.116:1:3", "700.108:2:5", "700.101:2:4"], `order ${order}`);
  }
});

test("a page is never attached to a run whose times it doesn't continue", () => {
  // The 4:12 PM continuation page misread as run 700.116, which ended at 2:37 PM.
  const wrong = (t: string, i: number) => (i === 4 ? t.replace("Run: 700.101", "Run: 700.116") : t);
  for (const order of shuffles) {
    const trips = group(order, wrong);
    assert.equal(trips[0], "700.116:1:3", `order ${order}`);
    assert.ok(trips.includes("700.101:2:4"), `order ${order}: ${trips}`);
  }
});

test("the same page photographed twice is used once", () => {
  const pages = [R1, R2a, R1].map((text, photo) => describePage({ photo, name: `p${photo}`, text }));
  const { pages: kept, dropped } = dropDuplicatePages(pages);
  assert.deepEqual(dropped.map((p) => p.photo), [2]);
  const trips = buildTrips(kept, autoGroup(kept));
  assert.deepEqual(trips.map((t) => `${t.run}:${t.pages.length}:${t.stops}`), ["700.116:1:3", "700.108:1:3"]);
});
