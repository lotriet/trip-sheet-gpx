import assert from "node:assert/strict";
import { test } from "node:test";
import { findPage, preparePage, rotate, rotationCandidates, type Gray } from "../src/lib/ocr/prep";
import { judgeSheetText, keepLines } from "../src/lib/ocr/quality";
import { EXAMPLE_SHEET_TEXT } from "../src/lib/exampleSheet";

/** A mid-gray textured "car seat" with a white page and some dark "text" bars on it. */
function photo(width: number, height: number, page: { x: number; y: number; w: number; h: number }): Gray {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inPage = x >= page.x && x < page.x + page.w && y >= page.y && y < page.y + page.h;
      let v = inPage ? 235 : 110 + ((x * 7 + y * 13) % 40);
      if (inPage && y % 40 < 8 && x > page.x + 30 && x < page.x + page.w - 30) v = 30;
      data[y * width + x] = v;
    }
  }
  return { data, width, height };
}

test("finds the page on a busy background and blanks the rest", () => {
  const g = photo(600, 800, { x: 100, y: 150, w: 400, h: 520 });
  const found = findPage(g);
  assert.ok(found);
  assert.ok(Math.abs(found.box.x - 100) < 20 && Math.abs(found.box.w - 400) < 40, JSON.stringify(found.box));
  const prepared = preparePage(g);
  assert.equal(prepared.cropped, true);
  assert.equal(prepared.landscape, false);
  assert.equal(prepared.image.width, 2000);
  // The corners are background: they must be plain white after clean-up.
  assert.equal(prepared.image.data[0], 255);
  assert.equal(prepared.image.data[prepared.image.data.length - 1], 255);
});

test("a sideways page is tried at 90 and 270 degrees", () => {
  const g = photo(800, 600, { x: 120, y: 80, w: 560, h: 430 });
  const prepared = preparePage(g);
  assert.equal(prepared.landscape, true);
  assert.deepEqual(rotationCandidates(true), [90, 270]);
  const upright = rotate(prepared.image, 90);
  assert.equal(upright.width, prepared.image.height);
  assert.equal(upright.height, prepared.image.width);
});

test("rotations round-trip", () => {
  const g: Gray = { data: Uint8Array.from([1, 2, 3, 4, 5, 6]), width: 3, height: 2 };
  assert.deepEqual(Array.from(rotate(g, 90).data), [4, 1, 5, 2, 6, 3]);
  assert.deepEqual(Array.from(rotate(rotate(g, 90), 270).data), Array.from(g.data));
  assert.deepEqual(Array.from(rotate(g, 180).data), [6, 5, 4, 3, 2, 1]);
});

test("refuses gibberish and accepts a sheet", () => {
  const junk = "Stes 3 i\nis oe] FY S i=] 5\nES = 5\naE 2 = 2 5\nRH HRS AHA LE SLEALE A FLEE e RAEERURE";
  assert.equal(judgeSheetText(junk).ok, false);
  assert.equal(judgeSheetText(EXAMPLE_SHEET_TEXT).ok, true);
  assert.deepEqual(
    keepLines([
      { text: "Right Turn Onto MAPLE AVE", confidence: 95 },
      { text: "RH HRS AHA LE SLEALE", confidence: 21 },
      { text: "| =", confidence: 80 },
    ]),
    ["Right Turn Onto MAPLE AVE"],
  );
});
