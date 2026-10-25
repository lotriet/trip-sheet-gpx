import { canonicalKey, routeKeyFromRef, schoolSig } from "./names";
import type { LonLat, RawLine, RawPlace } from "./types";
import { minDistToLine } from "./geo";

const DRIVE = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "minor",
  "bus",
  "service",
]);

type TileFeature = {
  properties: Record<string, string | number | boolean | undefined>;
  toGeoJSON(x: number, y: number, z: number): {
    geometry: { type: string; coordinates: unknown };
  };
};

type TileLayer = { length: number; feature(i: number): TileFeature };

export type TileBuffer = { z: number; x: number; y: number; bytes: Uint8Array };

function asLines(coords: unknown, type: string): LonLat[][] {
  if (type === "LineString") return [coords as LonLat[]];
  if (type === "MultiLineString") return coords as LonLat[][];
  return [];
}

function num(v: string | number | boolean | undefined): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: string | number | boolean | undefined): string {
  return v == null ? "" : String(v);
}

function samples(coords: LonLat[]): LonLat[] {
  const step = Math.max(1, Math.ceil(coords.length / 12));
  return coords.filter((_, i) => i === 0 || i === coords.length - 1 || i % step === 0);
}

function lineMatchDistance(a: LonLat[], b: LonLat[]): { average: number; maximum: number } {
  const distances = samples(a).map((point) => minDistToLine(point, b).d);
  return {
    average: distances.reduce((sum, distance) => sum + distance, 0) / distances.length,
    maximum: Math.max(...distances),
  };
}

/**
 * Read OpenFreeMap / OpenMapTiles roads.
 * Names live on `transportation_name` (with highway refs); campus drives are unnamed
 * `transportation` service roads. Geometry at zoom 14 matches OSM closely for these roads.
 */
export async function decodeTiles(tiles: TileBuffer[]): Promise<{ lines: RawLine[]; places: RawPlace[] }> {
  const Pbf = (await import("pbf")).default;
  const { VectorTile } = await import("@mapbox/vector-tile");
  const lines: RawLine[] = [];
  const placeMap = new Map<string, RawPlace>();

  for (const tile of tiles) {
    const decoded = new VectorTile(new Pbf(tile.bytes)) as unknown as { layers: Record<string, TileLayer> };
    const namedFeatures: { name: string; keys: string[]; coords: LonLat[]; cls: string }[] = [];
    const roadFeatures: { coords: LonLat[]; cls: string; oneway: number }[] = [];
    const names = decoded.layers.transportation_name;
    if (names) {
      for (let i = 0; i < names.length; i++) {
        const f = names.feature(i);
        const p = f.properties;
        const cls = str(p.class);
        if (!DRIVE.has(cls)) continue;
        const name = str(p.name).trim();
        if (/\b(trail|greenway|sidewalk|footway|cycleway)\b/i.test(name)) continue;
        const keys: string[] = [];
        if (name) {
          keys.push(canonicalKey(name));
          // Sheets print "HARGETT ST" for OSM's "East Hargett Street".
          const bare = name.replace(/^(?:north|south|east|west|n|s|e|w)\.?\s+(?=\S+\s+\S)/i, "");
          if (bare !== name) keys.push(canonicalKey(bare));
        }
        const network = `${str(p.network)} ${str(p.route_1_network)}`;
        const ref = str(p.ref || p.route_1_ref);
        const rk = ref ? routeKeyFromRef(ref, network) : null;
        if (rk) keys.push(rk);
        const uniq = [...new Set(keys)].filter(Boolean);
        if (!uniq.length) continue;
        const gj = f.toGeoJSON(tile.x, tile.y, tile.z);
        for (const coords of asLines(gj.geometry.coordinates, gj.geometry.type)) {
          if (coords.length < 2) continue;
          namedFeatures.push({
            name: name || rk || "road",
            keys: uniq,
            coords,
            cls,
          });
        }
      }
    }

    const roads = decoded.layers.transportation;
    if (roads) {
      for (let i = 0; i < roads.length; i++) {
        const f = roads.feature(i);
        const p = f.properties;
        const cls = str(p.class);
        const gj = f.toGeoJSON(tile.x, tile.y, tile.z);
        for (const coords of asLines(gj.geometry.coordinates, gj.geometry.type)) {
          if (coords.length < 2) continue;
          if (DRIVE.has(cls)) roadFeatures.push({ coords, cls, oneway: num(p.oneway) });
          if (cls !== "service") continue;
          const svc = str(p.service);
          if (svc === "parking_aisle" || svc === "emergency" || str(p.access) === "no") continue;
          lines.push({ name: "service road", keys: [], coords, kind: "service", oneway: num(p.oneway), onewayKnown: true });
        }
      }
    }

    // transportation_name stitches same-named roads for label placement and omits
    // oneway. Match its names to transportation geometry, which carries OSM direction.
    const matchedNames = new Set<number>();
    for (const road of roadFeatures) {
      let best: { index: number; average: number } | null = null;
      for (let i = 0; i < namedFeatures.length; i++) {
        const named = namedFeatures[i];
        if (named.cls !== road.cls) continue;
        const distance = lineMatchDistance(road.coords, named.coords);
        // Keep this conservative: a nearby parallel carriageway must not lend
        // its one-way direction to the wrong named line.
        if (distance.maximum > 5 || distance.average > 2.5) continue;
        if (!best || distance.average < best.average) best = { index: i, average: distance.average };
      }
      if (!best) continue;
      const named = namedFeatures[best.index];
      matchedNames.add(best.index);
      lines.push({ name: named.name, keys: named.keys, coords: road.coords, kind: "named", oneway: road.oneway, onewayKnown: true });
    }
    for (let i = 0; i < namedFeatures.length; i++) {
      if (matchedNames.has(i)) continue;
      const named = namedFeatures[i];
      // Keep the named geometry available when the direction layer has no match;
      // the app's route disclaimer continues to call out incomplete one-way data.
      lines.push({ name: named.name, keys: named.keys, coords: named.coords, kind: "named", oneway: 0, onewayKnown: false });
    }

    const pois = decoded.layers.poi;
    if (pois) {
      for (let i = 0; i < pois.length; i++) {
        const f = pois.feature(i);
        const p = f.properties;
        if (str(p.class) !== "school" || !str(p.name)) continue;
        const gj = f.toGeoJSON(tile.x, tile.y, tile.z);
        const g = gj.geometry;
        let lon = 0;
        let lat = 0;
        if (g.type === "Point") {
          const c = g.coordinates as LonLat;
          lon = c[0];
          lat = c[1];
        } else continue;
        const sig = schoolSig(str(p.name));
        if (!sig.tokens) continue;
        const id = `${sig.tokens}|${sig.level}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
        if (!placeMap.has(id)) {
          placeMap.set(id, { name: str(p.name), lat, lon, tokens: sig.tokens, level: sig.level });
        }
      }
    }
  }

  return { lines, places: [...placeMap.values()] };
}
