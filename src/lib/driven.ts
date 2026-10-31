import { minutesOf } from "./batch";
import { bearing, haversine, minDistToLine, polylineMeters, projectPoint, roundaboutWays, turnAngle, turnsAtCorners } from "./engine/geo";
import { buildGpx } from "./engine/gpx";
import { isPassThrough } from "./engine/names";
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
  // A school's pin can sit hundreds of meters from where buses load, so
  // there the standstill decides, not how close the bus came to the pin.
  const farScore = (m: number, school: boolean) => m / (school ? 40 : 10);
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
      const score: number = farScore(m, school) + late - stoodScore(k, school);
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
      const score = farScore(m, school) - stoodScore(j, school);
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

const GRID = 0.002;

type MapStreet = { keys: string[]; label: string };

/** How a sheet would print a map street: I-40 for the interstate, Wade Ave for its expressway. */
function streetLabel(line: RawLine): string {
  const ref = line.keys.find((k) => /^i \d+$/.test(k)) ?? line.keys.find((k) => /^us \d+$/.test(k));
  if (ref) return ref.replace(/^(i|us) (\d+)$/, (_, kind: string, n: string) => `${kind.toUpperCase()}-${n}`);
  const street =
    line.keys.find((k) => /\b(rd|st|ave|dr|ln|blvd|pkwy|hwy|ct|cir|pl|trl|ter|way|loop|run|xing|pass)$/.test(k) && !/^(state road|nc \d{4})/.test(k)) ??
    line.keys[0];
  if (!street) return line.name;
  return street
    .split(" ")
    .map((w) => (/^(n|s|e|w|nw|ne|sw|se|nc|us)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** The map's named streets cut into segments on a grid, to find the street under a point fast. */
function segmentGrid(lines: RawLine[]) {
  const grid = new Map<string, { street: MapStreet; a: LonLat; b: LonLat }[]>();
  for (const line of lines) {
    if (line.kind !== "named" || !line.keys.length) continue;
    const street = { keys: line.keys, label: streetLabel(line) };
    for (let i = 1; i < line.coords.length; i++) {
      const a = line.coords[i - 1];
      const b = line.coords[i];
      for (let x = Math.floor(Math.min(a[0], b[0]) / GRID); x <= Math.floor(Math.max(a[0], b[0]) / GRID); x++)
        for (let y = Math.floor(Math.min(a[1], b[1]) / GRID); y <= Math.floor(Math.max(a[1], b[1]) / GRID); y++) {
          const key = `${x},${y}`;
          const cell = grid.get(key);
          if (cell) cell.push({ street, a, b });
          else grid.set(key, [{ street, a, b }]);
        }
    }
  }
  return grid;
}

function streetAt(grid: ReturnType<typeof segmentGrid>, p: LonLat): MapStreet | null {
  let best: { street: MapStreet; d: number } | null = null;
  const x = Math.floor(p[0] / GRID);
  const y = Math.floor(p[1] / GRID);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (const s of grid.get(`${x + dx},${y + dy}`) ?? []) {
        const d = minDistToLine(p, [s.a, s.b]).d;
        if (d <= ON_STREET_M && (!best || d < best.d)) best = { street: s.street, d };
      }
  return best?.street ?? null;
}

/** An interstate, US route or freeway: roads you get on and off by ramp. */
const isHighway = (street: MapStreet | null) => !!street && street.keys.some((k) => /^(i|us) \d+/.test(k) || /\b(freeway|expressway)\b/.test(k));

/** One road under two map names: the Dan K. Moore Freeway is I-40. */
const sameRoad = (a: MapStreet, b: MapStreet) => a.keys.some((k) => b.keys.includes(k));

/**
 * Where the drive moves onto another named street, by the map: the turns a
 * stretch the sheet gives no directions for (from where the bus set off, or
 * back to where it parked) still needs. A street counts once the drive stays
 * on it for a while, so GPS drift past a side street is not a turn.
 */
function mapTurns(track: LonLat[], under: (MapStreet | null)[]): { k: number; kind: "left" | "right" | "proceed"; street: string }[] {
  const holds = (k: number, street: MapStreet) => {
    let along = 0;
    for (let j = k + 1; j < track.length && along < ALONG_STREET_M; j++) {
      along += haversine(track[j - 1], track[j]);
      const there = under[j];
      if (there && !sameRoad(there, street)) return false;
    }
    return along >= ALONG_STREET_M;
  };
  const back = (k: number) => {
    for (let j = k - 1; j >= 0; j--) if (haversine(track[j], track[k]) >= 40) return j;
    return 0;
  };
  const ahead = (k: number) => {
    for (let j = k + 1; j < track.length; j++) if (haversine(track[j], track[k]) >= 40) return j;
    return track.length - 1;
  };
  const out: { k: number; kind: "left" | "right" | "proceed"; street: string; from: MapStreet | null }[] = [];
  let on: MapStreet | null = null;
  for (let k = 0; k < track.length; k++) {
    const street = under[k];
    if (!street || (on && sameRoad(on, street)) || !holds(k, street)) continue;
    // Out of the school lot (no named street) onto the first road is a turn too.
    const outOfLot = !on && !under[0] && haversine(track[0], track[k]) >= 30;
    if (on || outOfLot) {
      const angle = turnAngle(bearing(track[back(k)], track[k]), bearing(track[k], track[ahead(k)]));
      const kind = Math.abs(angle) < 35 ? "proceed" : angle > 0 ? "right" : "left";
      // Drifting onto a road beside the highway and back is no turn at all.
      const prior = out.at(-1);
      if (prior && prior.kind === "proceed" && kind === "proceed" && prior.from && sameRoad(street, prior.from)) {
        out.pop();
        on = street;
        continue;
      }
      out.push({ k, kind, street: street.label, from: on });
    }
    on = street;
  }
  return out.map(({ k, kind, street }) => ({ k, kind, street }));
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

/** A street name for comparing: "NC 55 Hwy" and "nc 55" match. */
const plainStreet = (street: string) => street.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(hwy|highway)$/, "");

/**
 * "Deadhead - 100 GREEN LEVEL WEST RD" right after a run that ended at
 * 100 GREEN LEVEL WEST RD: the next run starts where the last one ended,
 * not where a map guesses the address is.
 */
export function startsWhereLastEnded(
  first: { description: string } | undefined,
  lastOfPrevious: { description: string; lat: number; lon: number } | undefined,
): { lat: number; lon: number } | null {
  if (!first || !lastOfPrevious) return null;
  const plain = (d: string) => d.replace(/^\s*deadhead\s*[-–:]\s*/i, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^\s*deadhead\b/i.test(first.description) || plain(first.description) !== plain(lastOfPrevious.description)) return null;
  return { lat: lastOfPrevious.lat, lon: lastOfPrevious.lon };
}

export type DrivenOptions = {
  minuteOf?: (t: number) => number;
  /** The run's map, to find where the drive gets onto each printed street. */
  lines?: RawLine[];
  places?: RawPlace[];
  /**
   * Where the run's first stop really is, when the map's guess is off: the
   * previous run ended there (see startsWhereLastEnded). It is found on the
   * drive there; the router keeps a run's first stop where the map put it.
   */
  firstStopAt?: { lat: number; lon: number };
  /**
   * When the run before ended on the same recording (ms since epoch): this
   * run can't start earlier, even where the bus passed its start before.
   */
  after?: number;
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
  /** Legs, by their first stop, driven another way than the sheet prints: planned instead. */
  offSheet: number[];
  /** When the bus left the run's last stop on the drive (ms since epoch), if it came by. */
  endsAt?: number;
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
  const later = options.after == null ? fixesIn : fixesIn.filter((f) => f.t >= options.after!);
  const fixes = later.filter((f, k) => k === 0 || k === later.length - 1 || haversine(point(later[k - 1]), point(f)) >= 3);
  const stops = planned.stops;
  if (stops.length < 2 || fixes.length < 2) return null;
  const firstPin = options.firstStopAt;
  const at = stopsOnDrive(
    firstPin ? [{ ...stops[0], lat: firstPin.lat, lon: firstPin.lon }, ...stops.slice(1)] : stops,
    fixes,
    minuteOf,
  );
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
  const offSheet: { stop: number; missed: string[] }[] = [];
  const keepPlanned: [number, number][] = [];
  const marksIn = (a: number, b: number, last: boolean) => planned.turnMarks.filter((t) => t.trackIndex >= a && (last ? t.trackIndex <= b : t.trackIndex < b));
  const push = (points: LonLat[]) => {
    const start = coords.length && points.length && haversine(coords[coords.length - 1], points[0]) < 0.5 ? 1 : 0;
    const offset = coords.length - start;
    for (let k = start; k < points.length; k++) coords.push(points[k]);
    return offset;
  };
  const plannedPart = (a: number, b: number, last: boolean) => {
    // Join where the line already is: onto the planned road at the point
    // nearest the bus, not back at its stop pin a few meters behind.
    let from = a;
    let head: LonLat[] = [];
    if (coords.length) {
      const end = coords[coords.length - 1];
      let best = { d: haversine(end, planned.coords[a]), seg: -1, point: planned.coords[a] };
      let run = 0;
      for (let k = a; k < b && run <= 120; k++) {
        const near = projectPoint(end, planned.coords[k], planned.coords[k + 1]);
        if (near.d < best.d - 0.5) best = { d: near.d, seg: k, point: near.point };
        run += haversine(planned.coords[k], planned.coords[k + 1]);
      }
      if (best.seg >= 0 && best.d < 40) {
        from = best.seg + 1;
        head = [best.point];
      }
    }
    const offset = push([...head, ...planned.coords.slice(from, b + 1)]);
    keepPlanned.push([offset, coords.length - 1]);
    for (const t of marksIn(a, b, last)) {
      turnMarks.push({ ...t, trackIndex: t.trackIndex < from ? offset : offset + head.length + t.trackIndex - from });
    }
  };
  /**
   * Before a recorded stretch that starts where a planned one ends: the
   * planned road's last meters past where the bus picks up come off, so the
   * line doesn't run on and turn back.
   */
  const trimPlannedTo = (p: LonLat) => {
    const range = keepPlanned[keepPlanned.length - 1];
    if (!range || range[1] !== coords.length - 1) return;
    let best = { d: haversine(coords[coords.length - 1], p), seg: -1, point: p };
    let run = 0;
    for (let k = coords.length - 2; k >= range[0] && run <= 150; k--) {
      const near = projectPoint(p, coords[k], coords[k + 1]);
      if (near.d < best.d - 0.5) best = { d: near.d, seg: k, point: near.point };
      run += haversine(coords[k], coords[k + 1]);
    }
    if (best.seg < 0 || best.d >= 40) return;
    coords.length = best.seg + 1;
    coords.push(best.point);
    range[1] = coords.length - 1;
    for (const t of turnMarks) if (t.trackIndex > range[1]) t.trackIndex = range[1];
  };
  const endsPlanned = () => keepPlanned.length > 0 && keepPlanned[keepPlanned.length - 1][1] === coords.length - 1;
  const placeStop = (i: number, trackIndex: number, own?: { description: string; t: number }) => {
    const p = coords[trackIndex];
    // Where the bus set off or parked takes the time it did so on the drive.
    const mine = own ? { description: own.description, time: clock(own.t) } : {};
    newStops[i] = { ...stops[i], lat: p[1], lon: p[0], trackIndex, ...mine };
  };

  /**
   * The sheet's directions for leg `i`, placed where the drive (`part`)
   * takes them, by index into `part`; and the printed turns it doesn't take.
   */
  const placeDirections = (i: number, part: LonLat[]) => {
    const marks: TurnMark[] = [];
    const missed: string[] = [];
    const sheetStop = sheet.stops[stops[i].index];
    const a = stops[i].trackIndex;
    const b = stops[i + 1].trackIndex;
    const plannedMarks = marksIn(a, b, false);
    let from = 0;
    let roundabout = false;
    (sheetStop?.maneuvers ?? []).forEach((m, maneuverIndex) => {
      // "Right Turn Onto ROUNDABOUT, Left Turn On ROUNDABOUT, Right Turn Onto X": the right is the exit.
      const exitsRoundabout = roundabout && (m.kind === "left" || m.kind === "right");
      roundabout = isPassThrough(m.street) ? /round|circle|rotary/i.test(m.street) : false;
      // Out of a roundabout back onto the street the bus is already on: straight
      // through, no turn. Placing it would land on the turn onto that street.
      const prior = (sheetStop?.maneuvers ?? []).slice(0, maneuverIndex).filter((p) => !isPassThrough(p.street)).at(-1);
      if (exitsRoundabout && prior && plainStreet(prior.street) === plainStreet(m.street)) return;
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
        // Only a street the map knows can be checked: a school's driveway has no name there.
        if (mark && m.kind !== "proceed" && m.kind !== "turnaround" && streetFor(m.street)) missed.push(`${m.kind} onto ${m.street}`);
        return;
      }
      from = k;
      marks.push({
        stopIndex: stops[i].index,
        maneuverIndex,
        kind: m.kind,
        street: m.street,
        trackIndex: k,
        confirmed: true,
        ...(exitsRoundabout || mark?.via === "roundabout" ? { via: "roundabout" as const } : {}),
      });
    });
    return { marks, missed };
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
        const home = fixes.slice(at[i], endAt + 1).map(point);
        trimPlannedTo(home[0]);
        const offset = push(home);
        placeStop(i, offset);
        placeStop(legs, coords.length - 1, { description: options.endName ?? "End of the recorded drive", t: fixes[endAt].t });
      } else {
        plannedPart(stops[i].trackIndex, stops[i + 1].trackIndex, false);
        placeStop(i + 1, coords.length - 1);
      }
      i++;
      continue;
    }
    if (q > i + 1) {
      // Driven in another order than the sheet: the trip sheet comes first,
      // so these stops keep the sheet's order and its planned road.
      for (let k = i; k < q; k++) {
        driven.delete(k);
        reordered.add(k);
        plannedPart(stops[k].trackIndex, stops[k + 1].trackIndex, false);
        placeStop(k + 1, coords.length - 1);
      }
      i = q;
      continue;
    }
    const part = fixes.slice(at[i], at[q] + 1).map(point);
    const directions = placeDirections(i, part);
    // A few meters driven between two stops at one spot, after a planned leg:
    // planned too, or the line would step back to where the bus stood.
    const hop = endsPlanned() && polylineMeters(part) < 80;
    if (hop || directions.missed.length) {
      // The trip sheet comes first: a leg driven another way than its
      // printed turns is planned from the sheet instead.
      if (directions.missed.length) offSheet.push({ stop: i, missed: directions.missed });
      driven.delete(i);
      plannedPart(stops[i].trackIndex, stops[i + 1].trackIndex, false);
      placeStop(i + 1, coords.length - 1);
      i++;
      continue;
    }
    trimPlannedTo(part[0]);
    const offset = push(part);
    for (let k = i; k <= q; k++) placeStop(k, offset + at[k] - at[i]);
    for (const t of directions.marks) turnMarks.push({ ...t, trackIndex: offset + t.trackIndex });
    i = q;
  }
  const lastAt = stops[legs].trackIndex;
  if (!ownEnd && lastAt < planned.coords.length - 1) plannedPart(lastAt, planned.coords.length - 1, true);

  // A planned leg that runs out and back the same way, with no stop or
  // printed turnaround on it: the router reaching a turn from the wrong side.
  // The spur goes, and a cue on it moves to the corner where it began.
  {
    const placed = new Set(newStops.filter(Boolean).map((st) => st.trackIndex));
    const turnaroundAt = new Set(turnMarks.filter((t) => t.kind === "turnaround").map((t) => t.trackIndex));
    const drop = new Set<number>();
    const moveTo = new Map<number, number>();
    for (const [a, b] of keepPlanned) {
      for (let i = a; i < b; i++) {
        let far = i;
        let run = 0;
        for (let j = i + 1; j <= b && run <= 300; j++) {
          run += haversine(coords[j - 1], coords[j]);
          if (haversine(coords[i], coords[j]) > haversine(coords[i], coords[far])) far = j;
          const out = haversine(coords[i], coords[far]);
          if (j <= far + 0 || out < 20 || out > 150 || haversine(coords[i], coords[j]) > 8) continue;
          // Back along the way it came, not round a block.
          let same = true;
          for (let k = far + 1; k < j && same; k++) same = minDistToLine(coords[k], coords.slice(i, far + 1)).d <= 12;
          let clear = true;
          for (let k = i + 1; k <= j && clear; k++) clear = !placed.has(k) && !turnaroundAt.has(k);
          if (same && clear) {
            for (let k = i + 1; k <= j; k++) {
              drop.add(k);
              moveTo.set(k, i);
            }
            i = j;
          }
          break;
        }
      }
    }
    if (drop.size) {
      const newIndex: number[] = [];
      const kept: LonLat[] = [];
      coords.forEach((p, k) => {
        if (!drop.has(k)) kept.push(p);
        newIndex[k] = kept.length - 1;
      });
      const remap = (k: number) => newIndex[moveTo.get(k) ?? k];
      for (const t of turnMarks) t.trackIndex = remap(t.trackIndex);
      for (const st of newStops) if (st) st.trackIndex = remap(st.trackIndex);
      for (const range of keepPlanned) {
        range[0] = remap(range[0]);
        range[1] = remap(range[1]);
      }
      coords.length = 0;
      coords.push(...kept);
    }
  }

  // Where the drive changes street with no sheet direction near: from where
  // the bus set off, back to where it parked, or a way the sheet doesn't print.
  if (options.lines) {
    const along = [0];
    for (let k = 1; k < coords.length; k++) along.push(along[k - 1] + haversine(coords[k - 1], coords[k]));
    const grid = segmentGrid(options.lines);
    const under = coords.map((p) => streetAt(grid, p));
    const sheetMarks = [...turnMarks];
    const plain = plainStreet;
    for (const turn of mapTurns(coords, under)) {
      if (keepPlanned.some(([a, b]) => turn.k >= a && turn.k <= b)) continue;
      const here = along[turn.k];
      // The sheet names this street close by: one cue, where the drive really got onto it.
      const same = sheetMarks.find((t) => plain(t.street) === plain(turn.street) && Math.abs(along[t.trackIndex] - here) < 1000);
      if (same) {
        // Matched farther on, the sheet's turn is where the bus already drove along that street.
        if (along[same.trackIndex] - here > 120 && !sheetMarks.some((t) => t !== same && t.trackIndex > turn.k && t.trackIndex < same.trackIndex)) {
          same.trackIndex = turn.k;
          if (same.kind !== "turnaround") same.kind = turn.kind;
        } else if (same.kind === "proceed" && turn.kind !== "proceed") {
          // "Proceed onto" where the drive plainly turned: say which way.
          same.kind = turn.kind;
        }
        continue;
      }
      if (sheetMarks.some((t) => Math.abs(along[t.trackIndex] - here) < 120)) continue;
      turnMarks.push({ stopIndex: -1, maneuverIndex: -1, kind: turn.kind, street: turn.street, trackIndex: turn.k, confirmed: true });
    }

    // Two cues onto the same street a few meters apart (a left onto it, then
    // a roundabout's exit back onto it): the later one is how the bus leaves.
    // A plain "proceed on" it after a printed turn onto it says nothing new:
    // the turn stays.
    turnMarks.sort((x, y) => x.trackIndex - y.trackIndex);
    for (let n = turnMarks.length - 2; n >= 0; n--) {
      const a = turnMarks[n];
      const b = turnMarks[n + 1];
      if (plain(a.street) !== plain(b.street) || along[b.trackIndex] - along[a.trackIndex] >= 40) continue;
      turnMarks.splice(b.kind === "proceed" && !b.via && a.kind !== "proceed" ? n + 1 : n, 1);
    }

    // On and off a highway: the map has no ramps, so a ramp is where the
    // drive leaves a named road for no road at all. The cue goes where the
    // ramp starts, on the side it leaves, not where it joins the next road.
    const sideAt = (s: number, k: number): "left" | "right" | "proceed" => {
      let b = s;
      while (b > 0 && along[s] - along[b] < 80) b--;
      let f = s;
      while (f < k && along[f] - along[s] < 120) f++;
      const angle = turnAngle(bearing(coords[b], coords[s]), bearing(coords[s], coords[f]));
      return angle > 4 ? "right" : angle < -4 ? "left" : "proceed";
    };
    for (const mark of [...turnMarks]) {
      const k = mark.trackIndex;
      if (mark.via || keepPlanned.some(([a, b]) => k >= a && k <= b)) continue;
      let j = k - 1;
      while (j > 0 && !under[j]) j--;
      const start = j + 1;
      if (start >= k || along[k] - along[start] < 80) continue;
      const before = under[j];
      const after = under[k];
      if (!(isHighway(before) || isHighway(after)) || (before && after && sameRoad(before, after))) continue;
      const side = sideAt(start, k);
      if (mark.kind === "proceed") {
        // Merging on, or an exit that becomes the next road: one cue, at the ramp.
        Object.assign(mark, { trackIndex: start, kind: side, via: "ramp" as const });
      } else if (!turnMarks.some((t) => Math.abs(along[t.trackIndex] - along[start]) < 30)) {
        // An exit ending at a light: take the ramp here, then the turn at its end.
        turnMarks.push({ stopIndex: mark.stopIndex, maneuverIndex: -1, kind: side, street: mark.street, trackIndex: start, confirmed: true, via: "ramp" });
      }
    }
  }

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
    info(`You drove stop${nums.length > 1 ? "s" : ""} ${nums.join(", ")} in another order than the sheet. The route keeps the sheet's order and turns there.`);
  }
  for (const missed of turnsMissed) info(`The recorded drive doesn't take the sheet's ${missed}, so that turn is left out.`);
  for (const leg of offSheet) {
    const from = sheet.stops[stops[leg.stop].index]?.description ?? `stop ${leg.stop + 1}`;
    info(`After ${from} the recorded drive skips the sheet's ${leg.missed.join(", ")}; that leg follows the trip sheet instead.`);
  }

  const meters = polylineMeters(coords);
  // Stops in the order they come along the track, the driver's order: the
  // run's file and the day file list them so, and GPX Nav follows that order.
  const inDriveOrder = [...newStops].sort((x, y) => x.trackIndex - y.trackIndex);
  turnMarks.sort((x, y) => x.trackIndex - y.trackIndex);
  roundaboutWays(coords, turnMarks);
  turnsAtCorners(coords, turnMarks);
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
    offSheet: offSheet.map((leg) => leg.stop),
    ...(at[legs] >= 0 ? { endsAt: fixes[at[legs]].t } : {}),
    ...(ownStart ? { start: coords[0] } : {}),
    ...(ownEnd ? { end: coords[coords.length - 1] } : {}),
  };
}
