import { minutesOf } from "./batch";
import { haversine } from "./engine/geo";

/** A place the bus stood still on a recorded drive. */
export type Dwell = { lat: number; lon: number; minute: number; seconds: number };

export type Fix = { lat: number; lon: number; t: number };

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

const meters = (a: Fix, b: Fix) => haversine([a.lon, a.lat], [b.lon, b.lat]);

/**
 * Where the bus stayed within 15 m for 6 s or more: a quick pickup is short.
 * Recorders log nothing while the phone stands still, so a gap in the track
 * that ends less than 30 m on counts as standing until the bus moved off.
 */
export function dwellsOf(fixes: Fix[], minuteOf: (t: number) => number = localMinute): Dwell[] {
  const out: Dwell[] = [];
  let i = 0;
  while (i < fixes.length) {
    let j = i;
    while (j + 1 < fixes.length && meters(fixes[i], fixes[j + 1]) < 15) j++;
    const next = fixes[j + 1];
    const end = next && next.t - fixes[j].t >= 6000 && meters(fixes[j], next) < 30 ? next.t : fixes[j].t;
    const seconds = (end - fixes[i].t) / 1000;
    if (seconds >= 6) out.push({ lat: fixes[i].lat, lon: fixes[i].lon, minute: minuteOf(fixes[i].t), seconds });
    i = j + 1;
  }
  return out;
}

/**
 * The recorded stop for each sheet stop the route couldn't pin down. Stops
 * the route placed for sure are matched first, in order, to the standstill
 * at their marker; that tells how late the bus was running. An unsure stop
 * then takes the free standstill nearest its marker around the time the bus
 * should have been there, even when the driver ran the stops in another order.
 */
export function stopsFromRecording(
  stops: { time: string; lat: number; lon: number }[],
  dwells: Dwell[],
  unsure: Set<number>,
): Record<number, { lat: number; lon: number }> {
  const pins: Record<number, { lat: number; lon: number }> = {};
  const used = new Set<number>();
  const lateBy: number[] = [];
  let after = -1;
  let delay = 0;
  const pick = (stop: { lat: number; lon: number }, minute: number, sure: boolean) => {
    let best: { k: number; score: number } | null = null;
    dwells.forEach((d, k) => {
      if (used.has(k) || (sure && k <= after)) return;
      const late = Math.abs(d.minute - minute - delay);
      const m = haversine([stop.lon, stop.lat], [d.lon, d.lat]);
      // A stop the route placed for sure is where its marker is; a standstill
      // farther off was the bus waiting somewhere else.
      if (late > (sure ? 15 : 8) || m > (sure ? 100 : 1000)) return;
      const score = late + m / 40;
      if (!best || score < best.score) best = { k, score };
    });
    return best as { k: number } | null;
  };
  stops.forEach((stop, index) => {
    const minute = minutesOf(stop.time);
    if (minute == null || index === 0 || unsure.has(index)) return;
    const best = pick(stop, minute, true);
    if (!best) return;
    used.add(best.k);
    after = best.k;
    delay = dwells[best.k].minute - minute;
    lateBy[index] = delay;
  });
  stops.forEach((stop, index) => {
    const minute = minutesOf(stop.time);
    if (minute == null || !unsure.has(index)) return;
    // How late the bus was at the nearest stop before this one it was sure of.
    let k = index;
    while (k > 0 && lateBy[k] == null) k--;
    delay = lateBy[k] ?? 0;
    const best = pick(stop, minute, false);
    if (!best) return;
    used.add(best.k);
    pins[index] = { lat: dwells[best.k].lat, lon: dwells[best.k].lon };
  });
  return pins;
}
