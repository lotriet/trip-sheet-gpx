import { minutesOf } from "./batch";
import { bearing, haversine, polylineMeters, turnAngle } from "./engine/geo";
import { buildGpx } from "./engine/gpx";
import type { LonLat, PlacedStop, RouteSuccess, Sheet, TurnMark, Warning } from "./engine/types";
import type { Fix } from "./recording";

/** A stop counts as passed when the drive comes this close to it. */
const STOP_M = 60;
/** Schools are big: the bus loads anywhere on the grounds, far from the map's marker. */
const SCHOOL_M = 800;
/** The drive takes the sheet's turn when it passes this close to it. */
const TURN_M = 35;

const localMinute = (t: number) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
};

const isSchool = (description: string) => /^SCHOOL\b|\b(HS|MS|ES|SCHOOL)\b/i.test(description);

/** The last point before the bus pulls away from where it stood at `k`. */
function pullsAway(fixes: Fix[], k: number): number {
  let j = k;
  while (j + 1 < fixes.length && haversine([fixes[k].lon, fixes[k].lat], [fixes[j + 1].lon, fixes[j + 1].lat]) < 25) j++;
  return j;
}

/** Where on the drive the bus was at each stop, in order; -1 where it never came by. */
function stopsOnDrive(stops: PlacedStop[], fixes: Fix[], minuteOf: (t: number) => number): number[] {
  const at: number[] = [];
  let after = 0;
  let delay: number | null = null;
  for (const [i, stop] of stops.entries()) {
    const minute = minutesOf(stop.time);
    const radius = isSchool(stop.description) ? SCHOOL_M : STOP_M;
    let best: { k: number; score: number } | null = null;
    for (let k = after; k < fixes.length; k++) {
      const f = fixes[k];
      // Until a stop has shown how late the bus runs, give it a wide window.
      const late: number = minute == null ? 0 : Math.abs(minuteOf(f.t) - minute - (delay ?? 0));
      if (late > (delay == null ? 45 : 15)) continue;
      const m = haversine([stop.lon, stop.lat], [f.lon, f.lat]);
      if (m > radius) continue;
      // Where the bus stood longest near the stop is where it picked up.
      const stood = k + 1 < fixes.length ? Math.min(60, (fixes[k + 1].t - f.t) / 1000) : 0;
      const score: number = m / 10 + late - stood / 10;
      if (!best || score < best.score) best = { k, score };
    }
    if (!best) {
      at.push(-1);
      continue;
    }
    const leaves = pullsAway(fixes, best.k);
    at.push(leaves);
    after = leaves;
    // The bus waits at the start for as long as it likes; lateness counts from the first pickup.
    if (minute != null && i > 0) delay = minuteOf(fixes[best.k].t) - minute;
  }
  // A stop the driver took out of the sheet's order: anywhere on the drive
  // around when the bus should have been there.
  stops.forEach((stop, i) => {
    const minute = minutesOf(stop.time);
    if (at[i] >= 0 || minute == null) return;
    let k = i;
    while (k > 1 && at[k] < 0) k--;
    const late = k > 0 && at[k] >= 0 ? minuteOf(fixes[at[k]].t) - (minutesOf(stops[k].time) ?? minute) : 0;
    const radius = isSchool(stop.description) ? SCHOOL_M : STOP_M;
    let best: { k: number; score: number } | null = null;
    fixes.forEach((f, j) => {
      if (Math.abs(minuteOf(f.t) - minute - late) > 10 || at.includes(j)) return;
      const m = haversine([stop.lon, stop.lat], [f.lon, f.lat]);
      if (m > radius) return;
      const stood = j + 1 < fixes.length ? Math.min(60, (fixes[j + 1].t - f.t) / 1000) : 0;
      const score = m / 10 - stood / 10;
      if (!best || score < best.score) best = { k: j, score };
    });
    if (best) at[i] = pullsAway(fixes, (best as { k: number }).k);
  });
  return at;
}

/**
 * The stretch of the drive from stop `p` to the first stop `q` after it that
 * closes off everything between: in order that's the next stop; when the
 * driver took stops in another order it spans all of them.
 */
function blockEnd(at: number[], p: number): number {
  if (at[p] < 0) return -1;
  for (let q = p + 1; q < at.length; q++) {
    if (at[q] < 0) return -1;
    if (at[q] <= at[p]) continue;
    const inside = at.slice(p + 1, q).every((a) => a > at[p] && a < at[q]);
    const after = at.slice(q + 1).every((a) => a < 0 || a > at[q]);
    if (inside && after) return q;
  }
  return -1;
}

/** The first point of the stretch that comes closest to `p`, ties going to the earlier pass. */
function nearestFrom(track: LonLat[], p: LonLat, from: number, to: number): { k: number; d: number } {
  let best = { k: from, d: Infinity };
  for (let k = from; k <= to; k++) {
    const d = haversine(track[k], p);
    if (d < best.d - 10) best = { k, d };
  }
  return best;
}

/** Which way the track heads away from the corner `at`, once past index `k`. */
function leavingHeading(track: LonLat[], k: number, at: LonLat): number | null {
  for (let j = k + 1; j < track.length; j++) if (haversine(at, track[j]) >= 30) return bearing(at, track[j]);
  return null;
}

export type DrivenRoute = { route: RouteSuccess; stopsOnDrive: number[]; legsDriven: number; legs: number; turnsKept: number; turnsMissed: string[] };

/**
 * The run's route along the road the bus really drove, with the sheet's stops
 * and turns on it: each leg between two stops the drive passed is the
 * recording, the rest stays as planned from the sheet.
 */
export function routeFromDrive(
  sheet: Sheet,
  planned: RouteSuccess,
  fixesIn: Fix[],
  minuteOf: (t: number) => number = localMinute,
): DrivenRoute | null {
  const fixes = fixesIn.filter((f, k) => k === 0 || haversine([fixesIn[k - 1].lon, fixesIn[k - 1].lat], [f.lon, f.lat]) >= 3 || k === fixesIn.length - 1);
  const stops = planned.stops;
  if (stops.length < 2 || fixes.length < 2) return null;
  const at = stopsOnDrive(stops, fixes, minuteOf);
  const legs = stops.length - 1;
  // Each stretch of the drive between two stops, from the stop it starts at.
  const blocks = new Map<number, number>();
  for (let p = 0; p < legs; ) {
    const q = blockEnd(at, p);
    if (q > p && fixes.slice(at[p], at[q] + 1).every((f, k, all) => k === 0 || haversine([all[k - 1].lon, all[k - 1].lat], [f.lon, f.lat]) <= 300)) {
      blocks.set(p, q);
      p = q;
    } else p++;
  }
  const driven = new Set<number>();
  const reordered = new Set<number>();
  for (const [p, q] of blocks) {
    for (let i = p; i < q; i++) driven.add(i);
    if (q > p + 1) for (let i = p + 1; i < q; i++) reordered.add(i);
  }
  if (!driven.size) return null;
  const onDrive = (i: number) => driven.has(i) || driven.has(i - 1);

  const coords: LonLat[] = [];
  const newStops: PlacedStop[] = [];
  const turnMarks: TurnMark[] = [];
  const turnsMissed: string[] = [];
  const keepPlanned: [number, number][] = [];
  const marksIn = (a: number, b: number, last: boolean) => planned.turnMarks.filter((t) => t.trackIndex >= a && (last ? t.trackIndex <= b : t.trackIndex < b));
  const push = (points: LonLat[]) => {
    const start = coords.length && points.length && haversine(coords[coords.length - 1], points[0]) < 0.5 ? 1 : 0;
    const offset = coords.length - start;
    for (let k = start; k < points.length; k++) coords.push(points[k]);
    return offset;
  };
  const plannedPart = (a: number, b: number, last: boolean) => {
    const offset = push(planned.coords.slice(a, b + 1));
    keepPlanned.push([offset, coords.length - 1]);
    for (const t of marksIn(a, b, last)) turnMarks.push({ ...t, trackIndex: offset + t.trackIndex - a });
  };
  const placeStop = (i: number, trackIndex: number) => {
    const p = coords[trackIndex];
    newStops[i] = { ...stops[i], lat: p[1], lon: p[0], trackIndex };
  };

  // Before the first stop (rarely anything) as planned.
  if (stops[0].trackIndex > 0) plannedPart(0, stops[0].trackIndex, false);
  if (!coords.length) push([onDrive(0) ? [fixes[at[0]].lon, fixes[at[0]].lat] : [stops[0].lon, stops[0].lat]]);
  placeStop(0, coords.length - 1);
  for (let i = 0; i < legs; ) {
    const q = blocks.get(i);
    const a = stops[i].trackIndex;
    if (q == null) {
      const b = stops[i + 1].trackIndex;
      plannedPart(a, b, false);
      i++;
      placeStop(i, coords.length - 1);
      continue;
    }
    const part = fixes.slice(at[i], at[q] + 1).map((f): LonLat => [f.lon, f.lat]);
    const offset = push(part);
    for (let k = i; k <= q; k++) placeStop(k, offset + at[k] - at[i]);
    // Driven in the sheet's order, the printed turns are where the drive
    // passes them. Driven in another order they'd point the wrong way.
    const b = stops[q].trackIndex;
    let from = 0;
    for (const t of marksIn(a, b, false)) {
      const near = q === i + 1 ? nearestFrom(part, planned.coords[t.trackIndex], from, part.length - 1) : null;
      // Passing the corner isn't taking the turn: the drive must leave it the same way.
      const corner = planned.coords[t.trackIndex];
      const sheetWay = t.kind === "turnaround" ? null : leavingHeading(planned.coords, t.trackIndex, corner);
      const driveWay = near && sheetWay != null ? leavingHeading(part, near.k, corner) : null;
      const sameWay = sheetWay == null || driveWay == null || Math.abs(turnAngle(sheetWay, driveWay)) <= 50;
      if (!near || near.d > TURN_M || !sameWay) {
        if (q === i + 1) turnsMissed.push(t.kind === "turnaround" ? `turnaround on ${t.street}` : `${t.kind} onto ${t.street}`);
        continue;
      }
      from = near.k;
      turnMarks.push({ ...t, trackIndex: offset + near.k, confirmed: true });
    }
    i = q;
  }
  const lastAt = stops[legs].trackIndex;
  if (lastAt < planned.coords.length - 1) plannedPart(lastAt, planned.coords.length - 1, true);

  // Warnings about a leg or stop the drive replaced no longer apply.
  const onPlanned = (p: LonLat) => keepPlanned.some(([a, b]) => coords.slice(a, b + 1).some((c) => haversine(c, p) < 60));
  const warnings: Warning[] = planned.warnings.filter((w) => {
    if (w.stopIndex >= 0 && w.maneuverIndex >= 0) return !driven.has(w.stopIndex);
    if (w.stopIndex >= 0) return !onDrive(w.stopIndex);
    return w.location ? onPlanned(w.location) : driven.size < legs;
  });
  warnings.push({
    level: "info",
    stopIndex: -1,
    maneuverIndex: -1,
    message: driven.size === legs
      ? "The route follows the drive you recorded, with the sheet's stops and turns on it."
      : `The route follows the drive you recorded for ${driven.size} of ${legs} legs; the rest is planned from the sheet.`,
  });
  if (reordered.size) {
    const nums = [...reordered].map((i) => i + 1);
    warnings.push({
      level: "info",
      stopIndex: -1,
      maneuverIndex: -1,
      message: `You drove stop${nums.length > 1 ? "s" : ""} ${nums.join(", ")} in another order than the sheet. The route follows your order there, without the sheet's turns.`,
    });
  }
  for (const missed of turnsMissed) {
    warnings.push({ level: "info", stopIndex: -1, maneuverIndex: -1, message: `The recorded drive doesn't take the sheet's ${missed}, so that turn is left out.` });
  }
  const meters = polylineMeters(coords);
  turnMarks.sort((x, y) => x.trackIndex - y.trackIndex);
  return {
    route: {
      ...planned,
      coords,
      meters,
      miles: meters / 1609.344,
      stops: newStops,
      turnMarks,
      warnings,
      // Stops in the order they come along the track, the driver's order.
      gpx: buildGpx({ ...sheet, description: `${sheet.description} (recorded drive)`.trim() }, coords, [...newStops].sort((x, y) => x.trackIndex - y.trackIndex), turnMarks),
    },
    stopsOnDrive: at,
    legsDriven: driven.size,
    legs,
    turnsKept: turnMarks.length,
    turnsMissed,
  };
}
