import { canonicalKey, routeKeyFromRef, schoolSig } from "./names";
import { WAKE_BBOX } from "./schools";
import type { LonLat, RawLine, RawPlace } from "./types";

/**
 * Wake County's roads straight from OpenStreetMap, cut into square cells and
 * served with the app (`public/roads`). Unlike map tiles, a way is stored
 * whole in every cell it touches, with its exact node positions, so streets
 * that meet share a point and nothing is cut at a cell edge.
 */
export const ROAD_CELL_DEG = 0.05;
export const ROAD_AREA = WAKE_BBOX;

/** One OSM way as stored in a cell file. Coordinates are flat: lon, lat, lon, lat… */
export type RoadWay = {
  id: number;
  h: string;
  c: number[];
  n?: string;
  r?: string;
  o?: number;
  s?: string;
  a?: string;
  /** 1 for a ramp or slip road (OSM *_link). */
  l?: number;
  /** Other names the road goes by (alt_name, name_1, old_name, official_name). */
  an?: string[];
};

/** A school as stored in a cell file: name, lat, lon. */
export type RoadSchool = [string, number, number];

export type RoadCell = { ways: RoadWay[]; schools: RoadSchool[] };

export type Box = { minLon: number; minLat: number; maxLon: number; maxLat: number };

export function cellName(cx: number, cy: number): string {
  return `${cx}_${cy}`;
}

/** The cells a box touches, or null when part of it is outside the road data. */
export function cellsFor(box: Box): string[] | null {
  if (box.minLon < ROAD_AREA.minLon || box.maxLon > ROAD_AREA.maxLon) return null;
  if (box.minLat < ROAD_AREA.minLat || box.maxLat > ROAD_AREA.maxLat) return null;
  const out: string[] = [];
  const x0 = Math.floor(box.minLon / ROAD_CELL_DEG);
  const x1 = Math.floor(box.maxLon / ROAD_CELL_DEG);
  const y0 = Math.floor(box.minLat / ROAD_CELL_DEG);
  const y1 = Math.floor(box.maxLat / ROAD_CELL_DEG);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(cellName(x, y));
  return out;
}

/** OSM's one-way tag as the engine reads it: 1 with the way, -1 against, 0 both. */
export function onewayOf(tags: Record<string, string | undefined>): number {
  const v = (tags.oneway ?? "").toLowerCase();
  if (v === "-1" || v === "reverse") return -1;
  if (v === "yes" || v === "1" || v === "true") return 1;
  if (v === "no" || v === "false" || v === "0") return 0;
  if (tags.junction === "roundabout" || tags.junction === "circular") return 1;
  if (tags.highway === "motorway" || tags.highway === "motorway_link") return 1;
  return 0;
}

/** "I 40;I 440" → ["i 40", "i 440"]; "NC 55" → ["nc 55"]. */
function refKeys(ref: string): string[] {
  const out: string[] = [];
  for (const part of ref.split(";")) {
    const m = part.trim().match(/^(I|US|NC|SR)\b/i);
    if (!m) continue;
    const network = { I: "US:I", US: "US:US", NC: "US:NC", SR: "US:SR" }[m[1].toUpperCase()] ?? "";
    const key = routeKeyFromRef(part.trim(), network);
    if (key) out.push(key);
  }
  return out;
}

const SKIP_SERVICE = new Set(["driveway", "parking_aisle", "emergency_access", "drive-through"]);

/** The cells' ways as the lines the route builder reads, each way once. */
export function linesFromCells(cells: RoadCell[]): { lines: RawLine[]; places: RawPlace[] } {
  const lines: RawLine[] = [];
  const seen = new Set<number>();
  const places = new Map<string, RawPlace>();
  const unnamed: { coords: LonLat[]; oneway: number }[] = [];
  for (const cell of cells) {
    for (const way of cell.ways) {
      if (seen.has(way.id)) continue;
      seen.add(way.id);
      const coords: LonLat[] = [];
      for (let i = 0; i + 1 < way.c.length; i += 2) coords.push([way.c[i], way.c[i + 1]]);
      if (coords.length < 2) continue;
      const oneway = way.o ?? 0;
      const name = (way.n ?? "").trim();
      if (way.h === "service") {
        if (SKIP_SERVICE.has(way.s ?? "") || way.a === "no") continue;
        lines.push({ name: "service road", keys: [], coords, kind: "service", oneway, onewayKnown: true });
      }
      if (/\b(greenway|sidewalk|footway|cycleway)\b/i.test(name)) continue;
      const keys: string[] = [];
      if (name) {
        keys.push(canonicalKey(name));
        // Sheets print "HARGETT ST" for OSM's "East Hargett Street".
        const bare = name.replace(/^(?:north|south|east|west|n|s|e|w)\.?\s+(?=\S+\s+\S)/i, "");
        if (bare !== name) keys.push(canonicalKey(bare));
      }
      for (const other of way.an ?? []) keys.push(canonicalKey(other));
      if (way.r) keys.push(...refKeys(way.r));
      const uniq = [...new Set(keys)].filter(Boolean);
      if (!uniq.length) {
        // Ramps stay unnamed: named after every road they touch, they pull
        // routes off the highway and back.
        if (way.h !== "service" && !way.l) unnamed.push({ coords, oneway });
        continue;
      }
      lines.push({ name: name || uniq[0], keys: uniq, coords, kind: "named", oneway, onewayKnown: true });
    }
    for (const [name, lat, lon] of cell.schools) {
      const sig = schoolSig(name);
      if (!sig.tokens) continue;
      const id = `${sig.tokens}|${sig.level}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
      if (!places.has(id)) places.set(id, { name, lat, lon, tokens: sig.tokens, level: sig.level });
    }
  }
  lines.push(...nameUnnamed(lines, unnamed));
  return { lines, places: [...places.values()] };
}

const pointKey = (c: LonLat) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

/**
 * A road with no name in OSM, most often a roundabout or a short connector,
 * is driven as the streets it joins: the piece of roundabout between two
 * halves of Town Hall Drive is Town Hall Drive (and the cross street). Pieces
 * that only touch other unnamed pieces take their names a round later.
 */
function nameUnnamed(named: RawLine[], unnamed: { coords: LonLat[]; oneway: number }[]): RawLine[] {
  const at = new Map<string, { keys: Set<string>; name: string }>();
  const mark = (line: { coords: LonLat[]; keys: string[]; name: string }) => {
    for (const c of line.coords) {
      const k = pointKey(c);
      let entry = at.get(k);
      if (!entry) at.set(k, (entry = { keys: new Set(), name: line.name }));
      for (const key of line.keys) entry.keys.add(key);
    }
  };
  for (const line of named) if (line.kind === "named") mark(line);
  const out: RawLine[] = [];
  let left = unnamed;
  for (let round = 0; round < 4 && left.length; round++) {
    const next: typeof unnamed = [];
    const found: RawLine[] = [];
    for (const way of left) {
      // A ring (a roundabout drawn as one closed way) meets its streets
      // anywhere along it, not at its ends.
      const ring = pointKey(way.coords[0]) === pointKey(way.coords.at(-1)!);
      const touch = ring ? way.coords : [way.coords[0], way.coords.at(-1)!];
      const ends = touch.map((c) => at.get(pointKey(c))).filter((e) => e != null);
      const keys = [...new Set(ends.flatMap((e) => [...e.keys]))];
      if (!keys.length) {
        next.push(way);
        continue;
      }
      found.push({ name: ends[0].name, keys, coords: way.coords, kind: "named", oneway: way.oneway, onewayKnown: true });
    }
    for (const line of found) mark(line);
    out.push(...found);
    left = next;
  }
  return out;
}
