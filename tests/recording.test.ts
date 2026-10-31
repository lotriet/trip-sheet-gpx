import assert from "node:assert/strict";
import { test } from "node:test";
import { dwellsOf, recordedFixes, stopsFromRecording } from "../src/lib/recording";

// Made-up drive: still for 20 s at A, moving, still for 8 s at B, moving, still at C.
const at = (lat: number, lon: number, s: number) => `<trkpt lat="${lat}" lon="${lon}"><time>${new Date(Date.UTC(2026, 0, 5, 11, 0, s)).toISOString()}</time></trkpt>`;
const gpx = `<gpx><trk><trkseg>${[
  at(35.8, -78.8, 0), at(35.8, -78.8, 20),
  at(35.801, -78.8, 40), at(35.802, -78.8, 60),
  at(35.803, -78.8, 120), at(35.803, -78.8, 128),
  at(35.805, -78.8, 160), at(35.806, -78.8, 200), at(35.806, -78.8, 230),
].join("")}</trkseg></trk></gpx>`;
const minuteOf = (t: number) => (t - Date.UTC(2026, 0, 5, 11)) / 60000 + 360; // 11:00 UTC as 6:00

test("standstills of 6 s or more are found, with their time of day", () => {
  const dwells = dwellsOf(recordedFixes(gpx), minuteOf);
  assert.deepEqual(dwells.map((d) => [d.lat, Math.round(d.minute * 10) / 10]), [[35.8, 360], [35.803, 362], [35.806, 363.3]]);
});

test("only unsure stops are moved, each to its own standstill in order", () => {
  const dwells = dwellsOf(recordedFixes(gpx), minuteOf);
  const stops = [
    { time: "5:50 AM", lat: 35.79, lon: -78.8 },
    { time: "6:00 AM", lat: 35.8, lon: -78.8 },
    // Placed on the previous stop's corner by mistake; the drive shows where it is.
    { time: "6:02 AM", lat: 35.8, lon: -78.8 },
    { time: "6:03 AM", lat: 35.806, lon: -78.8 },
  ];
  assert.deepEqual(stopsFromRecording(stops, dwells, new Set([2])), { 2: { lat: 35.803, lon: -78.8 } });
});

test("a gap in the track that ends a few meters on is a standstill", () => {
  // The recorder logs nothing for 17 s while the bus stands, then it creeps off.
  const gappy = `<gpx><trk><trkseg>${[at(35.8, -78.8, 0), at(35.8, -78.8002, 17), at(35.801, -78.8, 40)].join("")}</trkseg></trk></gpx>`;
  const dwells = dwellsOf(recordedFixes(gappy), minuteOf);
  assert.deepEqual(dwells.map((d) => [d.lat, d.seconds]), [[35.8, 17]]);
});

test("a bus running late still has its unsure stops matched", () => {
  const dwells = dwellsOf(recordedFixes(gpx), minuteOf);
  // The same drive as printed ten minutes earlier on the sheet.
  const stops = [
    { time: "5:40 AM", lat: 35.79, lon: -78.8 },
    { time: "5:50 AM", lat: 35.8, lon: -78.8 },
    { time: "5:52 AM", lat: 35.8, lon: -78.8 },
    { time: "5:53 AM", lat: 35.806, lon: -78.8 },
  ];
  assert.deepEqual(stopsFromRecording(stops, dwells, new Set([2])), { 2: { lat: 35.803, lon: -78.8 } });
});

test("a street-address stop goes where the bus stood, even first in a run", async () => {
  const { isAddressStop } = await import("../src/lib/recording");
  assert.equal(isAddressStop("100 GREEN LEVEL WEST RD - DOORSIDE"), true);
  assert.equal(isAddressStop("Deadhead - 100 GREEN LEVEL WEST RD - DOORSIDE"), true);
  assert.equal(isAddressStop("1 OAK RIDGE MS"), false);
  assert.equal(isAddressStop("CHURCH ST & ROBIN ST"), false);
  // Run 3 starts at 4:03 at an address the map put 450 m off; the bus stood
  // there 10 minutes late, as it was at White Oak ES next.
  const stops = [
    { time: "4:03 PM", lat: 35.77266, lon: -78.92738, description: "Deadhead - 100 GREEN LEVEL WEST RD" },
    { time: "4:07 PM", lat: 35.78022, lon: -78.9213, description: "SCHOOL: WHITE OAK ES" },
  ];
  const dwells = [
    { lat: 35.77287, lon: -78.92737, minute: 16 * 60 + 5, seconds: 13 }, // a light near the wrong pin, on time
    { lat: 35.77398, lon: -78.92266, minute: 16 * 60 + 13, seconds: 25 }, // the real stop, 10 min late
    { lat: 35.78022, lon: -78.9213, minute: 16 * 60 + 17, seconds: 134 }, // White Oak ES
  ];
  const pins = stopsFromRecording(stops, dwells, new Set());
  assert.deepEqual(pins[0], { lat: 35.77398, lon: -78.92266 });
});
