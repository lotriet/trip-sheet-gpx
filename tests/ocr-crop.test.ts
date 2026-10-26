import assert from "node:assert/strict";
import { test } from "node:test";
import { readGray } from "../src/lib/ocr";
import { normalizeSheetOcr } from "../src/lib/ocr/document";
import { preparePage, type Gray } from "../src/lib/ocr/prep";

// Made-up streets.
test("misread turn words and a time read on its own line are kept", () => {
  const text = normalizeSheetOcr(
    "Route: DEMO42\nRun: 900.101",
    "06:40 AM\nDeadhead - SCHOOL: OAK HS\nProceed On OAK HS\nLett Turn Onto MAPLE AVE\nRignt Turn Onto ELM ST",
  );
  assert.match(text, /^06:40 AM Deadhead - SCHOOL: OAK HS$/m);
  assert.match(text, /^Left Turn Onto MAPLE AVE$/m);
  assert.match(text, /^Right Turn Onto ELM ST$/m);
});

/** A sheet on a dark desk whose lower half is in shadow below a fold. */
function foldedSheet(): Gray {
  const width = 600;
  const height = 900;
  const data = new Uint8Array(width * height).fill(60);
  for (let y = 60; y < 860; y++) {
    for (let x = 60; x < 540; x++) data[y * width + x] = y < 420 ? 235 : 120;
  }
  return { data, width, height };
}

test("a fold that hides the lower page is detected and the whole photo is read", async () => {
  const photo = foldedSheet();
  // The page finder stops at the fold: this is the crop that lost stops.
  const cropped = preparePage(photo);
  assert.ok(cropped.cropped);
  assert.ok(cropped.image.height < cropped.image.width * 1.1, "the crop should be cut at the fold");

  const top = "06:10 AM 1 OAK HS\nProceed On OAK HS\nRight Turn Onto MAPLE AVE\nLeft Turn Onto ELM ST\nRight Turn Onto ASH ST\nLeft Turn Onto FIR ST\nRight Turn Onto YEW ST";
  const bottom = "06:20 AM ELM ST & BIRCH LN\nProceed On ELM ST\nRight Turn Onto CEDAR CT\n06:30 AM SCHOOL: OAK HS\nReport Name: --MASTER - Driver Directions - by Route";
  const reads: number[] = [];
  // A tall image is the whole sheet, so it includes the bottom and its footer.
  const worker = {
    setParameters: async () => ({}),
    recognize: async (image: Uint8Array) => {
      const [w, h] = new TextDecoder().decode(image.subarray(0, 32)).split("\n")[1].split(" ").map(Number);
      reads.push(h / w);
      return { data: { text: h > w * 1.2 ? `${top}\n${bottom}` : top } };
    },
  };
  const result = await readGray(worker as never, photo, { AUTO: 3, SINGLE_BLOCK: 6 } as never);
  assert.ok(result);
  assert.match(result.text, /06:20 AM ELM ST & BIRCH LN/);
  assert.match(result.text, /06:30 AM SCHOOL: OAK HS/);
});

test("a misread route on one page takes the route the other pages print", async () => {
  const { autoGroup, buildTrips, describePage } = await import("../src/lib/batch");
  const page = (text: string) => describePage({ photo: 0, name: "", text });
  const pages = [
    page("Route: DEMO42\nDescription: OAK HS 01 Run\nRun: 900.101\n06:10 AM 1 OAK HS\nProceed On OAK HS\nRight Turn Onto MAPLE AVE"),
    page("Route: DEMy42\nDescription: OAK HS 02\nRun: 900.102\n06:40 AM Deadhead - SCHOOL: OAK HS\nProceed On OAK HS"),
    page("Route: DEMO42\nDescription: PINE MS 03\nRun: 900.203\n07:20 AM Deadhead - SCHOOL: OAK HS\nProceed On OAK HS"),
  ];
  const trips = buildTrips(pages, autoGroup(pages));
  assert.deepEqual(trips.map((t) => t.sheet.route), ["DEMO42", "DEMO42", "DEMO42"]);
  assert.equal(normalizeSheetOcr("Description: OAK HS 01 Run", "06:10 AM 1 OAK HS").split("\n")[0], "Description: OAK HS 01");
});
