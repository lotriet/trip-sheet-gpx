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
    ["proceed:FAYETTEVILLE ST", "right:MORGAN ST", "left:BLOUNT ST", "turnaround:BLOUNT ST"],
  );
  assert.equal(sheet.stops[1].stopId, "000.002");
  assert.equal(sheet.stops[1].runLoad, 12);
  assert.equal(sheet.stops[2].maneuvers.length, 0);
  assert.equal(sheet.stops[2].stopId, "000.003");
  assert.equal(classifyLocation(sheet.stops[0].description).kind, "intersection");
  assert.equal(classifyLocation(sheet.stops[1].description).kind, "school");
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
