import { minutesOf } from "./batch";
import { bearing, haversine, minDistToLine, polylineMeters, turnAngle } from "./engine/geo";
import { buildGpx } from "./engine/gpx";
import { resolveTarget } from "./engine/route";
import type { LonLat, PlacedStop, RawLine, RawPlace, RouteSuccess, Sheet, TurnMark, Warning } from "./engine/types";
import type { Fix } from "./recording";

/** A stop counts as passed when the drive comes this close to it. */
const STOP_M = 60;
/** Schools are big: the bus loads anywhere on the grounds, far from the map's marker. */
const SCHOOL_M = 800;
/** Without the map, the drive takes the sheet's turn when it passes this close to the planned one. */
const TURN_M = 35;
/** On a street: this close to its line... */
const ON_STREET_M = 15;
/** ...for this far along it, so crossing it at a corner doesn't count. */
const ALONG_STREET_M = 60;
/** Parked: standing this long between runs. */
const PARKED_S = 5 * 60;
/** How far before the first stop and after the last the drive is looked at. */
const ENDS_MIN = 60;

const localMinute = (t: number) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
};

/** "1:35 PM", the phone's clock, as the sheet prints times. */
const clock = (t: number) => {
  const d = new Date(t);
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
};

const isSchool = (description: string) => /^SCHOOL\b|\b(HS|MS|ES|SCHOOL)\b/i.test(description);
const point = (f: Fix): LonLat => [f.lon, f.lat];
/** The last point before the bus pulls away from where it stood at `k`. */
function pullsAway(fixes: Fix[], k: number): number {
  let j = k;
  while (j + 1 < fixes.length && haversine(point(fixes[k]), point(fixes[j + 1])) < 25) j++;
  return j;
}

/** Seconds the bus stays within 25 m of where it is at `k`, GPS drift and all. */
function standing(fixes: Fix[], k: number): number {
  const j = pullsAway(fixes, k);
  return ((j + 1 < fixes.length ? fixes[j + 1].t : fixes[j].t) - fixes[k].t) / 1000;
}

/** Where on the drive the bus left each stop, in order; -1 where it never came by. */
function stopsOnDrive(stops: PlacedStop[], fixes: Fix[], minuteOf: (t: number) => number): number[] {
  const at: number[] = [];
  let after = 0;
  let delay: number | null = null;
  // Where the bus stood longest near the stop is where it picked up; at a
  // school that's the loading, not a red light on the way out.
  const stoodScore = (k: number, school: boolean) => Math.min(school ? 900 : 60, standing(fixes, k)) / 10;
  for (const [i, stop] of stops.entries()) {
    const minute = minutesOf(stop.time);
    const school = isSchool(stop.description);
    const radius = school ? SCHOOL_M : STOP_M;
    let best: { k: number; score: number } | null = null;
    for (let k = after; k < fixes.length; k++) {
      const f = fixes[k];
      // Until a stop has shown how late the bus runs, give it a wide window.
      const late: number = minute == null ? 0 : Math.abs(minuteOf(f.t) - minute - (delay ?? 0));
      if (late > (delay == null ? 45 : 15)) continue;
      const m = haversine([stop.lon, stop.lat], point(f));
      if (m > radius) continue;
      const score: number = m / 10 + late - stoodScore(k, school);
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
    const school = isSchool(stop.description);
    let best: { k: number; score: number } | null = null;
    fixes.forEach((f, j) => {
      if (Math.abs(minuteOf(f.t) - minute - late) > 10 || at.includes(j)) return;
      const m = haversine([stop.lon, stop.lat], point(f));
      if (m > (school ? SCHOOL_M : STOP_M)) return;
      const score = m / 10 - stoodScore(j, school);
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

/** No gap the phone lost signal across. */
const unbroken = (fixes: Fix[], a: number, b: number) => {
  for (let k = a + 1; k <= b; k++) if (haversine(point(fixes[k - 1]), point(fixes[k])) > 300) return false;
  return true;
};

/** Where the bus set off for its first stop: from where it was parked, or as far back as the drive goes. */
function setsOff(fixes: Fix[], first: number): number {
  const earliest = fixes[first].t - ENDS_MIN * 60000;
  for (let k = first - 1; k >= 0 && fixes[k].t >= earliest; k--) {
    if (haversine(point(fixes[k]), point(fixes[first])) > 300 && standing(fixes, k) >= PARKED_S) return pullsAway(fixes, k);
    if (k > 0 && haversine(point(fixes[k - 1]), point(fixes[k])) > 300) return k;
  }
  let k = first;
  while (k > 0 && fixes[k - 1].t >= earliest) k--;
  return k;
}

/** Where the bus parked after its last stop, or as far on as the drive goes. */
function parksAt(fixes: Fix[], last: number): number {
  const latest = fixes[last].t + ENDS_MIN * 60000;
  let k = last + 1;
  for (; k < fixes.length && fixes[k].t <= latest; k++) {
    if (haversine(point(fixes[k - 1]), point(fixes[k])) > 300) return k - 1;
    if (haversine(point(fixes[k]), point(fixes[last])) > 300 && standing(fixes, k) >= PARKED_S) return k;
  }
  return k - 1;
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

/** The map's lines by street key, each with a box to skip far ones fast. */
function streetIndex(lines: RawLine[]) {
  const byKey = new Map<string, { coords: LonLat[]; box: [number, number, number, number] }[]>();
  for (const line of lines) {
    if (line.kind !== "named" || line.coords.length < 2) continue;
    const lons = line.coords.map((c) => c[0]);
    const lats = line.coords.map((c) => c[1]);
    const entry = { coords: line.coords, box: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] as [number, number, number, number] };
    for (const key of line.keys) byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  return byKey;
}

type StreetLines = ReturnType<typeof streetIndex> extends Map<string, infer V> ? V : never;

function metersFrom(p: LonLat, street: StreetLines): number {
  const pad = 0.0005;
  let best = Infinity;
  for (const s of street) {
    if (p[0] < s.box[0] - pad || p[0] > s.box[2] + pad || p[1] < s.box[1] - pad || p[1] > s.box[3] + pad) continue;
    best = Math.min(best, minDistToLine(p, s.coords).d);
  }
  return best;
}

/** The first point from `from` where the drive gets onto the street and stays on it. */
function joinsStreet(track: LonLat[], from: number, street: StreetLines): number {
  for (let k = from; k < track.length; k++) {
    if (metersFrom(track[k], street) > ON_STREET_M) continue;
    let along = 0;
    let stays = true;
    for (let j = k + 1; j < track.length && along < ALONG_STREET_M; j++) {
      along += haversine(track[j - 1], track[j]);
      if (metersFrom(track[j], street) > ON_STREET_M + 5) {
        stays = false;
        break;
      }
    }
    if (stays) return k;
  }
  return -1;
}

/** The named place (a school, a bus lot) the bus started or parked at. */
export function placeNear(places: RawPlace[], p: LonLat, maxM = 400): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const place of places) {
    const d = haversine(p, [place.lon, place.lat]);
    if (d > maxM) continue;
    // A school bus parks at a public school, not the daycare across the street.
    const score = d - (/\b(middle|elementary|high)\b/i.test(place.name) ? maxM : 0);
    if (!best || score < best.score) best = { name: place.name, score };
  }
  return best?.name;
}

export type DrivenOptions = {
  minuteOf?: (t: number) => number;
  /** The run's map, to find where the drive gets onto each printed street. */
  lines?: RawLine[];
  places?: RawPlace[];
  /** Names for where the drive starts and ends when the bus doesn't start or end at a sheet stop. */
  startName?: string;
  endName?: string;
};

export type DrivenRoute = {
  route: RouteSuccess;
  stopsOnDrive: number[];
  legsDriven: number;
  legs: number;
  turnsKept: number;
  turnsMissed: string[];
  /** Where the drive begins and ends in place of the sheet's first and last stop, to name them. */
  start?: LonLat;
  end?: LonLat;
};

/**
 * The run's route as the bus really drove it, with the sheet's stops and
 * streets on it: each leg between two stops the drive passed is the
 * recording; the sheet's turns and "proceed onto" streets are placed where
 * the drive gets onto those streets. When the bus set off from or parked
 * somewhere other than the sheet's first or last stop, the drive from and to
 * there replaces them. Legs the drive missed stay planned.
 */
export function routeFromDrive(sheet: Sheet, planned: RouteSuccess, fixesIn: Fix[], options: DrivenOptions = {}): DrivenRoute | null {
  const minuteOf = options.minuteOf ?? localMinute;
  const fixes = fixesIn.filter((f, k) => k === 0 || k === fixesIn.length - 1 || haversine(point(fixesIn[k - 1]), point(f)) >= 3);
  const stops = planned.stops;
  if (stops.length < 2 || fixes.length < 2) return null;
  const at = stopsOnDrive(stops, fixes, minuteOf);
  const legs = stops.length - 1;
  // Each stretch of the drive between two stops, from the stop it starts at.
  const blocks = new Map<number, number>();
  for (let p = 0; p < legs; ) {
    const q = blockEnd(at, p);
    if (q > p && unbroken(fixes, at[p], at[q])) {
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
  // The bus set off from somewhere else than the sheet's first stop, or
  // parked somewhere else after the last: the drive there is the route.
  const startAt = at[0] < 0 && at[1] >= 0 ? setsOff(fixes, at[1]) : -1;
  const endAt = at[legs] < 0 && at[legs - 1] >= 0 ? parksAt(fixes, at[legs - 1]) : -1;
  const ownStart = startAt >= 0 && startAt < at[1] && unbroken(fixes, startAt, at[1]);
  const ownEnd = endAt > at[legs - 1] && unbroken(fixes, at[legs - 1], endAt);
  if (ownStart) driven.add(0);
  if (ownEnd) driven.add(legs - 1);
  const onDrive = (i: number) => driven.has(i) || driven.has(i - 1);

  const streets = options.lines ? streetIndex(options.lines) : null;
  const available = streets ? new Set(streets.keys()) : null;
  const streetFor = (name: string) => {
    if (!streets || !available) return null;
    const target = resolveTarget(name, available, options.places ?? []);
    return target.how === "missing" ? null : (streets.get(target.key) ?? null);
  };

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
  const placeStop = (i: number, trackIndex: number, own?: { description: string; t: number }) => {
    const p = coords[trackIndex];
    // Where the bus set off or parked takes the time it did so on the drive.
    const mine = own ? { description: own.description, time: clock(own.t) } : {};
    newStops[i] = { ...stops[i], lat: p[1], lon: p[0], trackIndex, ...mine };
  };

  /** The sheet's directions for leg `i`, placed where the drive (`part`, from `offset`) takes them. */
  const placeDirections = (i: number, part: LonLat[], offset: number) => {
    const sheetStop = sheet.stops[stops[i].index];
    const a = stops[i].trackIndex;
    const b = stops[i + 1].trackIndex;
    const plannedMarks = marksIn(a, b, false);
    let from = 0;
    (sheetStop?.maneuvers ?? []).forEach((m, maneuverIndex) => {
      // Where the planned route turns, when the drive turns there too: the exact corner.
      let k = -1;
      const mark = plannedMarks.find((t) => t.maneuverIndex === maneuverIndex);
      if (mark) {
        const corner = planned.coords[mark.trackIndex];
        const near = nearestFrom(part, corner, from, part.length - 1);
        const sheetWay = mark.kind === "turnaround" ? null : leavingHeading(planned.coords, mark.trackIndex, corner);
        const driveWay = sheetWay != null && near.d <= TURN_M ? leavingHeading(part, near.k, corner) : null;
        const sameWay = sheetWay == null || driveWay == null || Math.abs(turnAngle(sheetWay, driveWay)) <= 50;
        if (near.d <= TURN_M && sameWay) k = near.k;
      }
      // Else where the drive gets onto that street: another ramp than the
      // planned one, or a "proceed onto" the planned route had no point for.
      const street = k < 0 && m.kind !== "turnaround" ? streetFor(m.street) : null;
      if (street) k = joinsStreet(part, from, street);
      if (k < 0) {
        // A turn the planned route made that the drive didn't.
        if (mark && m.kind !== "proceed") turnsMissed.push(m.kind === "turnaround" ? `turnaround on ${m.street}` : `${m.kind} onto ${m.street}`);
        return;
      }
      from = k;
      turnMarks.push({ stopIndex: stops[i].index, maneuverIndex, kind: m.kind, street: m.street, trackIndex: offset + k, confirmed: true });
    });
  };

  // Before the first stop (rarely anything) as planned.
  if (!ownStart && stops[0].trackIndex > 0) plannedPart(0, stops[0].trackIndex, false);
  let i = 0;
  if (ownStart) {
    const part = fixes.slice(startAt, at[1] + 1).map(point);
    push(part);
    placeStop(0, 0, { description: options.startName ?? "Start of the recorded drive", t: fixes[pullsAway(fixes, startAt)].t });
    placeStop(1, coords.length - 1);
    i = 1;
  } else {
    if (!coords.length) push([onDrive(0) && at[0] >= 0 ? point(fixes[at[0]]) : [stops[0].lon, stops[0].lat]]);
    placeStop(0, coords.length - 1);
  }
  while (i < legs) {
    const q = blocks.get(i);
    if (q == null) {
      if (i === legs - 1 && ownEnd) {
        const offset = push(fixes.slice(at[i], endAt + 1).map(point));
        placeStop(i, offset);
        placeStop(legs, coords.length - 1, { description: options.endName ?? "End of the recorded drive", t: fixes[endAt].t });
      } else {
        plannedPart(stops[i].trackIndex, stops[i + 1].trackIndex, false);
        placeStop(i + 1, coords.length - 1);
      }
      i++;
      continue;
    }
    const part = fixes.slice(at[i], at[q] + 1).map(point);
    const offset = push(part);
    for (let k = i; k <= q; k++) placeStop(k, offset + at[k] - at[i]);
    // Driven in another order, the sheet's directions would point the wrong way.
    if (q === i + 1) placeDirections(i, part, offset);
    i = q;
  }
  const lastAt = stops[legs].trackIndex;
  if (!ownEnd && lastAt < planned.coords.length - 1) plannedPart(lastAt, planned.coords.length - 1, true);

  // Warnings about a leg or stop the drive replaced no longer apply.
  const onPlanned = (p: LonLat) => keepPlanned.some(([a, b]) => coords.slice(a, b + 1).some((c) => haversine(c, p) < 60));
  const warnings: Warning[] = planned.warnings.filter((w) => {
    if (w.stopIndex >= 0 && w.maneuverIndex >= 0) return !driven.has(w.stopIndex);
    if (w.stopIndex >= 0) return !onDrive(w.stopIndex);
    return w.location ? onPlanned(w.location) : driven.size < legs;
  });
  const info = (message: string) => warnings.push({ level: "info", stopIndex: -1, maneuverIndex: -1, message });
  info(driven.size === legs
    ? "The route is the drive you recorded, with the sheet's stops and streets on it."
    : `The route is the drive you recorded for ${driven.size} of ${legs} legs; the rest is planned from the sheet.`);
  if (ownStart) info(`The drive starts from ${options.startName ?? "where the recording starts"}, not the sheet's ${stops[0].description}.`);
  if (ownEnd) info(`The drive ends at ${options.endName ?? "where the bus parked"}, not the sheet's ${stops[legs].description}.`);
  if (reordered.size) {
    const nums = [...reordered].map((n) => n + 1);
    info(`You drove stop${nums.length > 1 ? "s" : ""} ${nums.join(", ")} in another order than the sheet. The route follows your order there, without the sheet's turns.`);
  }
  for (const missed of turnsMissed) info(`The recorded drive doesn't take the sheet's ${missed}, so that turn is left out.`);

  const meters = polylineMeters(coords);
  // Stops in the order they come along the track, the driver's order: the
  // run's file and the day file list them so, and GPX Nav follows that order.
  const inDriveOrder = [...newStops].sort((x, y) => x.trackIndex - y.trackIndex);
  turnMarks.sort((x, y) => x.trackIndex - y.trackIndex);
  // The sheet's directions from its first stop don't apply when the bus set off from elsewhere.
  const named = {
    ...sheet,
    description: `${sheet.description} (recorded drive)`.trim(),
    stops: sheet.stops.map((s, n) => (ownStart && n === stops[0].index ? { ...s, maneuvers: [] } : s)),
  };
  return {
    route: {
      ...planned,
      coords,
      meters,
      miles: meters / 1609.344,
      stops: inDriveOrder,
      turnMarks,
      warnings,
      gpx: buildGpx(named, coords, inDriveOrder, turnMarks),
    },
    stopsOnDrive: at,
    legsDriven: driven.size,
    legs,
    turnsKept: turnMarks.length,
    turnsMissed,
    ...(ownStart ? { start: coords[0] } : {}),
    ...(ownEnd ? { end: coords[coords.length - 1] } : {}),
  };
}
