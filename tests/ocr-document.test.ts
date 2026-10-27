import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeStopLine, normalizeSheetOcr, readingRows, repairStopTime } from "../src/lib/ocr/document";
import { parseSheet } from "../src/lib/engine/parseSheet";

test("normalizes trip sheet text while ignoring furniture and repairing wrapped run numbers", () => {
  const text = normalizeSheetOcr(
    "Route: GH1715\nDescription:\nDriver Directions by Route\nRun: 44 1 .009",
    `iption: GREEN HOPE HS 09\nStop Time Description :\nStop Load Run Ld Stop ID\n06:12 AM 1 GREEN HOPE HS\nProceed Onto GREEN HOPE HS\nRight Turn Onto CARPENTER UPCHURCH RD\nIf the directions cannot be run according to TIMS`,
  );
  assert.match(text, /Route: GH1715/);
  assert.match(text, /Description: GREEN HOPE HS 09/);
  assert.match(text, /Run: 441\.009/);
  assert.match(text, /Proceed Onto GREEN HOPE HS/);
  assert.doesNotMatch(text, /Stop Load|Run Ld|TIMS|Driver Directions/);
  const parsed = parseSheet(text);
  assert.equal(parsed.stops.length, 1);
  assert.equal(parsed.stops[0].maneuvers[0].street, "GREEN HOPE HS");
});

test("a clipped page edge's misread hour is repaired", () => {
  assert.equal(repairStopTime("16:18 AM DENMARK MANOR DR & ROUNDABOUT"), "06:18 AM DENMARK MANOR DR & ROUNDABOUT");
  assert.equal(repairStopTime(")6:23 AM MCCRIMMON PKWY"), "06:23 AM MCCRIMMON PKWY");
  assert.equal(repairStopTime("05:42AM 1 ALSTON RIDGE MS"), "05:42 AM 1 ALSTON RIDGE MS");
  assert.equal(repairStopTime("06:15AM ~~ MASON FARM RD @ POOL LOT"), "06:15 AM MASON FARM RD @ POOL LOT");
  assert.equal(repairStopTime("Right Turn Onto RIDGE RD"), "Right Turn Onto RIDGE RD");
});

test("a tilted row's time and description stay one line", () => {
  // The description reads a hair higher than its time, as on a skewed scan.
  const rows = readingRows([
    { text: "Left Turn Onto CHURCH ST 27560", left: 0.08, top: 0.300, height: 0.012 },
    { text: "CHURCH ST ,27560 & JEREMIAH ST (DOORSIDE)", left: 0.16, top: 0.3205, height: 0.013 },
    { text: "05:58 AM", left: 0.02, top: 0.3225, height: 0.013 },
    { text: "Proceed On CHURCH ST 27560", left: 0.08, top: 0.342, height: 0.012 },
  ]);
  assert.deepEqual(rows, [
    "Left Turn Onto CHURCH ST 27560",
    "05:58 AM CHURCH ST ,27560 & JEREMIAH ST (DOORSIDE)",
    "Proceed On CHURCH ST 27560",
  ]);
});

test("a stop line that lost its time is never glued onto a direction", () => {
  const text = normalizeSheetOcr(
    "Route: GL1473 Description: MARTIN MS 07 (GL) Run: 492.007",
    "05:42 AM 1 ALSTON RIDGE MS\nLeft Turn Onto CHURCH ST 27560\nCHURCH ST ,27560 & JEREMIAH ST (DOORSIDE)\nProceed On CHURCH ST 27560\n16:59 AM CHURCH ST ,27560 & HOPEDALE DR (DOORSIDE)",
  );
  assert.doesNotMatch(text, /27560 CHURCH ST/);
  const sheet = parseSheet(text);
  assert.deepEqual(sheet.stops.map((s) => [s.time, s.description]), [
    ["5:42 AM", "1 ALSTON RIDGE MS"],
    ["", "CHURCH ST ,27560 & JEREMIAH ST (DOORSIDE)"],
    ["6:59 AM", "CHURCH ST ,27560 & HOPEDALE DR (DOORSIDE)"],
  ]);
  assert.equal(looksLikeStopLine("GLENDON WAY & NC 55 HWY - DOORSIDE 8 8 502.020"), true);
  assert.equal(looksLikeStopLine("CARPENTER FIRE STATION RD"), false);
});
