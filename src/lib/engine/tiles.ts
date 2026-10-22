import { canonicalKey, routeKeyFromRef, schoolSig } from "./names";
import type { LonLat, RawLine, RawPlace } from "./types";

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
          lines.push({
            name: name || rk || "road",
            keys: uniq,
            coords,
            kind: "named",
            oneway: 0,
          });
        }
      }
    }

    const roads = decoded.layers.transportation;
    if (roads) {
      for (let i = 0; i < roads.length; i++) {
        const f = roads.feature(i);
        const p = f.properties;
        if (str(p.class) !== "service") continue;
        const svc = str(p.service);
        if (svc === "parking_aisle" || svc === "emergency") continue;
        if (str(p.access) === "no") continue;
        const gj = f.toGeoJSON(tile.x, tile.y, tile.z);
        for (const coords of asLines(gj.geometry.coordinates, gj.geometry.type)) {
          if (coords.length < 2) continue;
          lines.push({ name: "service road", keys: [], coords, kind: "service", oneway: num(p.oneway) });
        }
      }
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
