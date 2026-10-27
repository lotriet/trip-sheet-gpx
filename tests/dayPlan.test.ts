import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDayGpx, filePlace, fileTime, runFileName } from "../src/lib/dayPlan";
import { zipStore } from "../src/lib/zipStore";
import { bboxFromPoints, tilesForPoints, tilesInBbox } from "../src/lib/mapfetch";

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

test("a deadhead across town loads both ends of the drive", () => {
  // Morrisville stops, the Cary start, and a school 16 km away in Raleigh.
  const points = [
    { lon: -78.8308, lat: 35.8271 },
    { lon: -78.8534, lat: 35.8622 },
    { lon: -78.849, lat: 35.8562 },
    { lon: -78.8536, lat: 35.8352 },
    { lon: -78.8617, lat: 35.8225 },
    { lon: -78.8704, lat: 35.817 },
    { lon: -78.9036, lat: 35.8539 },
    { lon: -78.7298, lat: 35.8116 },
    { lon: -78.6855, lat: 35.8122 },
  ];
  const tiles = tilesForPoints(points);
  const has = (lon: number, lat: number) => {
    const [t] = tilesInBbox({ minLon: lon, maxLon: lon, minLat: lat, maxLat: lat });
    return tiles.some((u) => u.x === t.x && u.y === t.y);
  };
  for (const p of points) assert.ok(has(p.lon, p.lat), `${p.lon},${p.lat} is on the map`);
  // A point between the stops, inside the box, is not trimmed off either.
  assert.ok(has(-78.79, 35.84));
  assert.ok(tiles.length <= 200);
});
