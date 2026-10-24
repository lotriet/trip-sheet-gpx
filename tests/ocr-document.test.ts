import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSheetOcr } from "../src/lib/ocr/document";
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
