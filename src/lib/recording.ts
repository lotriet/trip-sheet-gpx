import { minutesOf } from "./batch";
import { haversine } from "./engine/geo";

/** A place the bus stood still on a recorded drive. */
export type Dwell = { lat: number; lon: number; minute: number; seconds: number };

type Fix = { lat: number; lon: number; t: number };

/** Track points with times from a GPX file (GPX Tracker, GPX Nav). */
export function recordedFixes(gpx: string): Fix[] {
  const out: Fix[] = [];
  const re = /<trkpt\b[^>]*?lat="([-\d.]+)"[^>]*?lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  for (const m of gpx.matchAll(re)) {
    const time = m[3].match(/<time>([^<]+)<\/time>/)?.[1];
    const t = time ? Date.parse(time) : NaN;
    if (Number.isFinite(t)) out.push({ lat: Number(m[1]), lon: Number(m[2]), t });
  }
  return out.sort((a, b) => a.t - b.t);
}

const localMinute = (t: number) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
};

/** Where the bus stayed within 15 m for 6 s or more: a quick pickup is short. */
export function dwellsOf(fixes: Fix[], minuteOf: (t: number) => number = localMinute): Dwell[] {
  const out: Dwell[] = [];
  let i = 0;
  while (i < fixes.length) {
    let j = i;
    while (j + 1 < fixes.length && haversine([fixes[i].lon, fixes[i].lat], [fixes[j + 1].lon, fixes[j + 1].lat]) < 15) j++;
    const seconds = (fixes[j].t - fixes[i].t) / 1000;
    if (seconds >= 6) out.push({ lat: fixes[i].lat, lon: fixes[i].lon, minute: minuteOf(fixes[i].t), seconds });
    i = j + 1;
  }
  return out;
}

/**
 * The recorded stop for each sheet stop the route couldn't pin down: the
 * standstill nearest the sheet's time and the stop's current marker, taken
 * in order so two stops printed at the same minute get the two standstills.
 */
export function stopsFromRecording(
  stops: { time: string; lat: number; lon: number }[],
  dwells: Dwell[],
  unsure: Set<number>,
): Record<number, { lat: number; lon: number }> {
  const pins: Record<number, { lat: number; lon: number }> = {};
  let after = -1;
  stops.forEach((stop, index) => {
    const minute = minutesOf(stop.time);
    if (minute == null || index === 0) return;
    let best: { k: number; score: number } | null = null;
    dwells.forEach((d, k) => {
      if (k <= after) return;
      const late = Math.abs(d.minute - minute);
      const meters = haversine([stop.lon, stop.lat], [d.lon, d.lat]);
      // A stop the route placed for sure is where its marker is; a standstill
      // farther off was the bus waiting somewhere else.
      if (late > 4 || meters > (unsure.has(index) ? 1000 : 100)) return;
      const score = late + meters / 100;
      if (!best || score < best.score) best = { k, score };
    });
    if (!best) return;
    const { k } = best as { k: number };
    after = k;
    if (unsure.has(index)) pins[index] = { lat: dwells[k].lat, lon: dwells[k].lon };
  });
  return pins;
}
