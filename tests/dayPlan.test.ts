import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDayGpx, filePlace, fileTime, runFileName } from "../src/lib/dayPlan";
import { zipStore } from "../src/lib/zipStore";
import { bboxFromPoints, tilesInBbox } from "../src/lib/mapfetch";

test("names a run file the way OsmAnd sorts tracks", () => {
  assert.equal(fileTime("2:38 PM"), "0238PM");
  assert.equal(fileTime("7:05 AM"), "0705AM");
  assert.equal(filePlace("OAK ACADEMY 2"), "OakAcademy");
  assert.equal(
    runFileName(0, { run: "SAMPLE", description: "OAK ACADEMY 2", firstTime: "3:15 PM" }),
    "01_SAMPLE_OakAcademy_0315PM.gpx",
  );
  assert.equal(
    runFileName(4, { run: "SAMPLE2", description: "OAK ACADEMY 2", firstTime: "5:10 PM" }),
    "05_SAMPLE2_OakAcademy_0510PM.gpx",
  );
});

test("joins runs into one track with a marked deadhead and no route element", () => {
  const gpx = buildDayGpx(
    [
      {
        route: "DEMO",
        description: "FAKE EXAMPLE OAK ACADEMY",
        run: "SAMPLE",
        firstTime: "3:15 PM",
        coords: [
          [-78.64, 35.77],
          [-78.63, 35.78],
        ],
        stops: [{ time: "3:15 PM", description: "FAYETTEVILLE ST & HARGETT ST", lat: 35.77, lon: -78.64 }],
      },
      {
        route: "DEMO",
        description: "FAKE EXAMPLE OAK ACADEMY",
        run: "SAMPLE2",
        firstTime: "5:10 PM",
        coords: [
          [-78.64, 35.78],
          [-78.63, 35.79],
        ],
        stops: [{ time: "5:10 PM", description: "SCHOOL: OAK ACADEMY", lat: 35.78, lon: -78.64 }],
      },
    ],
    [{ coords: [[-78.63, 35.78], [-78.64, 35.78]], routed: true }],
  );
  assert.equal(gpx.match(/<trk>/g)?.length, 1);
  assert.equal(gpx.includes("<rte"), false);
  assert.equal(gpx.includes("Run 1 3:15 PM"), true);
  assert.equal(gpx.includes("Run 2 5:10 PM"), true);
  assert.equal(gpx.includes("DEADHEAD to run 2"), true);
  assert.equal(gpx.match(/<trkpt /g)?.length, 4);
});

test("an unrouted deadhead splits the track instead of drawing a straight road", () => {
  const gpx = buildDayGpx(
    [
      { route: "DEMO", description: "OAK", run: "ONE", firstTime: "3:15 PM", coords: [[-78.64, 35.77], [-78.63, 35.78]], stops: [] },
      { route: "DEMO", description: "OAK", run: "TWO", firstTime: "5:10 PM", coords: [[-78.60, 35.80], [-78.59, 35.81]], stops: [] },
    ],
    [{ coords: [[-78.63, 35.78], [-78.60, 35.80]], routed: false }],
  );
  assert.equal(gpx.match(/<trkseg>/g)?.length, 2);
  assert.equal(gpx.match(/<trkpt /g)?.length, 4);
  assert.match(gpx, /separate segment/);
  assert.doesNotMatch(gpx, /normal street drive, not a line/);
});

test("zip stores the gpx names in order", () => {
  const bytes = zipStore([
    { name: "01_SAMPLE_OakAcademy_0315PM.gpx", text: "<gpx></gpx>" },
    { name: "02_SAMPLE2_OakAcademy_0510PM.gpx", text: "<gpx></gpx>" },
  ]);
  const text = Buffer.from(bytes).toString("latin1");
  const a = text.indexOf("01_SAMPLE_OakAcademy_0315PM.gpx");
  const b = text.indexOf("02_SAMPLE2_OakAcademy_0510PM.gpx");
  assert.ok(a > 0 && b > a);
});

test("drops a geocoder hit that is miles from the rest of the sheet", () => {
  const box = bboxFromPoints([
    { lon: -78.86, lat: 35.8 },
    { lon: -78.84, lat: 35.81 },
    { lon: 133.9, lat: 34.6 },
  ]);
  assert.ok(box);
  assert.ok(box!.maxLon < -78);
  assert.ok(box!.minLon > -79);
});

test("caps the number of map tiles", () => {
  const tiles = tilesInBbox({ minLon: -79.2, minLat: 35.4, maxLon: -78.2, maxLat: 36.2 }, 14, 48);
  assert.ok(tiles.length <= 48);
  assert.ok(tiles.length > 0);
});
