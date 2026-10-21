import assert from "node:assert/strict";
import { test } from "node:test";
import { EXAMPLE_SHEET_TEXT } from "../src/lib/exampleSheet";
import { classifyLocation, parseSheet } from "../src/lib/engine/parseSheet";

test("parses the made-up example sheet", () => {
  const sheet = parseSheet(EXAMPLE_SHEET_TEXT);
  assert.equal(sheet.route, "DEMO");
  assert.equal(sheet.description, "FAKE EXAMPLE OAK ACADEMY");
  assert.equal(sheet.run, "999.001");
  assert.equal(sheet.stops.length, 3);
  assert.equal(sheet.stops[0].time, "3:15 PM");
  assert.equal(sheet.stops[0].stopId, "000.001");
  assert.equal(sheet.stops[0].stopLoad, 0);
  assert.equal(sheet.stops[0].runLoad, 0);
  assert.deepEqual(
    sheet.stops[0].maneuvers.map((m) => `${m.kind}:${m.street}`),
    ["proceed:FAYETTEVILLE ST", "right:MORGAN ST", "right:BLOUNT ST"],
  );
  assert.equal(sheet.stops[1].stopId, "000.002");
  assert.equal(sheet.stops[1].runLoad, 12);
  assert.equal(sheet.stops[2].maneuvers.length, 0);
  assert.equal(sheet.stops[2].stopId, "000.003");
  assert.equal(classifyLocation(sheet.stops[0].description).kind, "intersection");
  assert.equal(classifyLocation(sheet.stops[1].description).kind, "intersection");
  assert.equal(classifyLocation(sheet.stops[2].description).kind, "intersection");
});

test("parses OCR-ish text with wrapped loads and a misspelled turn", () => {
  const sheet = parseSheet(`Route: DEMO Description: FAKE EXAMPLE OAK ACADEMY
Run: 999.001
Driver Directions by Route
3:15 PM Deadhead - FAYETTEVILLE ST & HARGETT ST 0 0 000.001
Proceed On FAYETTEVILLE ST
Right Tum Onto MORGAN ST
Left Turn On BLOUNT ST
`);
  assert.equal(sheet.stops.length, 1);
  assert.equal(sheet.stops[0].stopId, "000.001");
  assert.equal(sheet.stops[0].maneuvers[1].kind, "right");
  assert.equal(sheet.stops[0].maneuvers[1].street, "MORGAN ST");
  assert.equal(sheet.stops[0].maneuvers[2].kind, "left");
  assert.equal(sheet.description, "FAKE EXAMPLE OAK ACADEMY");
});

test("ignores stray OCR marks around lines from a phone photo", () => {
  // Made-up streets; the shape mimics real OCR output from a photo.
  const sheet = parseSheet(`__ Route: DEMO Description: FAKE EXAMPLE OAK ACADEMY Run: 999.001
i private streets, etc..) make a note on this sheet
| Stop Time Description Stop Load Run Ld Stop ID
02:28 PM Deadhead - 1 OAK ACADEMY 0 0 @AB.012
: 02:30 PM SCHOOL: OAK ACADEMY 0 36 999.000
Proceed On OAK ACADEMY
Tum Around On OAK ACADEMY
Right Turn Onto MAPLE AVE L
i 02:36 PM ELM DR & MAPLE AVE 9 16 999.043
; Proceed On MAPLE AVE -
Left Tun Onto CEDAR LN i
Right Turn Onto BIRCH RD 5
02:40PM CEDAR LN & BIRCH RD H 0 999041
02:44PM PINE CT & BIRCH RD - 0 0 999.X01
DOORSIDE
=
Seba
`);
  assert.equal(sheet.route, "DEMO");
  assert.equal(sheet.run, "999.001");
  assert.deepEqual(
    sheet.stops.map((s) => [s.time, s.description, s.stopId]),
    [
      ["2:28 PM", "Deadhead - 1 OAK ACADEMY", "@AB.012"],
      ["2:30 PM", "SCHOOL: OAK ACADEMY", "999.000"],
      ["2:36 PM", "ELM DR & MAPLE AVE", "999.043"],
      ["2:40 PM", "CEDAR LN & BIRCH RD", "999.041"],
      ["2:44 PM", "PINE CT & BIRCH RD DOORSIDE", "999.X01"],
    ],
  );
  assert.deepEqual(
    sheet.stops[1].maneuvers.map((m) => `${m.kind}:${m.street}`),
    ["proceed:OAK ACADEMY", "turnaround:OAK ACADEMY", "right:MAPLE AVE"],
  );
  assert.deepEqual(
    sheet.stops[2].maneuvers.map((m) => `${m.kind}:${m.street}`),
    ["proceed:MAPLE AVE", "left:CEDAR LN", "right:BIRCH RD"],
  );
  assert.equal(sheet.stops[2].stopLoad, 9);
  assert.equal(sheet.stops[2].runLoad, 16);
});
