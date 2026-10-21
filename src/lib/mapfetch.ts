import { decodeTiles, type TileBuffer } from "./engine/tiles";
import { expandPlaceQuery, looksLikePlace, titleCaseStreet } from "./engine/names";
import { classifyLocation } from "./engine/parseSheet";
import type { LonLat, RawLine, RawPlace, Sheet } from "./engine/types";

export type MapData = { lines: RawLine[]; places: RawPlace[] };

export type Bbox = { minLon: number; minLat: number; maxLon: number; maxLat: number };

const WAKE = { lat: 35.79, lon: -78.66, label: "Wake County, North Carolina" };

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    state?: string;
    countrycode?: string;
    osm_value?: string;
    osm_key?: string;
    extent?: [number, number, number, number];
  };
};

function streetQuery(raw: string): string {
  if (looksLikePlace(raw)) return expandPlaceQuery(raw);
  return titleCaseStreet(raw).replace(/\bPkwy\b/g, "Parkway").replace(/\bHwy\b/g, "Highway");
}

async function photon(
  query: string,
  bias: { lat: number; lon: number },
  filter?: { tag?: string; layer?: string },
): Promise<PhotonFeature[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  if (filter?.tag) url.searchParams.set("osm_tag", filter.tag);
  if (filter?.layer) url.searchParams.set("layer", filter.layer);
  url.searchParams.set("lat", String(bias.lat));
  url.searchParams.set("lon", String(bias.lon));
  url.searchParams.set("limit", "5");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoder responded ${res.status}`);
  const json = (await res.json()) as { features?: PhotonFeature[] };
  return json.features ?? [];
}

function keepFeature(f: PhotonFeature, bias: { lat: number; lon: number }): { lon: number; lat: number; extent?: Bbox } | null {
  const coords = f.geometry?.coordinates;
  if (!coords) return null;
  const [lon, lat] = coords;
  const props = f.properties ?? {};
  const name = `${props.name ?? ""} ${props.osm_value ?? ""}`;
  if (/\b(trail|greenway|bus_stop|platform)\b/i.test(name)) return null;
  if (props.countrycode && props.countrycode !== "US") return null;
  const dLat = (lat - bias.lat) * 111;
  const dLon = (lon - bias.lon) * 111 * Math.cos((bias.lat * Math.PI) / 180);
  if (Math.hypot(dLat, dLon) > 45) return null;
  let extent: Bbox | undefined;
  if (props.extent && props.extent.length === 4) {
    const [minLon, maxLat, maxLon, minLat] = props.extent;
    extent = { minLon, minLat, maxLon, maxLat };
  }
  return { lon, lat, extent };
}

export function bboxFromPoints(points: { lon: number; lat: number; extent?: Bbox }[]): Bbox | null {
  const kept: { lon: number; lat: number; extent?: Bbox }[] = [];
  if (!points.length) return null;
  const lats = points.map((p) => p.lat).sort((a, b) => a - b);
  const lons = points.map((p) => p.lon).sort((a, b) => a - b);
  const midLat = lats[Math.floor(lats.length / 2)];
  const midLon = lons[Math.floor(lons.length / 2)];
  for (const p of points) {
    const dLat = (p.lat - midLat) * 111;
    const dLon = (p.lon - midLon) * 111 * Math.cos((midLat * Math.PI) / 180);
    if (Math.hypot(dLat, dLon) <= 12) kept.push(p);
  }
  if (!kept.length) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const p of kept) {
    const box = p.extent ?? { minLon: p.lon - 0.01, maxLon: p.lon + 0.01, minLat: p.lat - 0.01, maxLat: p.lat + 0.01 };
    minLon = Math.min(minLon, box.minLon);
    minLat = Math.min(minLat, box.minLat);
    maxLon = Math.max(maxLon, box.maxLon);
    maxLat = Math.max(maxLat, box.maxLat);
  }
  const pad = 0.04;
  return { minLon: minLon - pad, minLat: minLat - pad, maxLon: maxLon + pad, maxLat: maxLat + pad };
}

function lonTile(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function latTile(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export function tilesInBbox(box: Bbox, z = 14, cap = 48): { z: number; x: number; y: number }[] {
  let minX = lonTile(box.minLon, z);
  let maxX = lonTile(box.maxLon, z);
  let minY = latTile(box.maxLat, z);
  let maxY = latTile(box.minLat, z);
  while ((maxX - minX + 1) * (maxY - minY + 1) > cap && maxX > minX && maxY > minY) {
    minX++;
    maxX--;
    minY++;
    maxY--;
  }
  const out: { z: number; x: number; y: number }[] = [];
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) out.push({ z, x, y });
  return out.slice(0, cap);
}

function sheetQueries(sheet: Sheet): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const q = streetQuery(raw).trim();
    const key = q.toLowerCase();
    if (!q || seen.has(key)) return;
    seen.add(key);
    out.push(q);
  };
  // Schools first: they anchor runs, and a stop line alone may name them.
  for (const stop of sheet.stops) {
    const loc = classifyLocation(stop.description);
    if (loc.kind === "school") add(loc.name);
  }
  for (const stop of sheet.stops) {
    for (const m of stop.maneuvers) add(m.street);
  }
  return out.slice(0, 10);
}

/**
 * Look a school up as a school and a street as a street. A plain search for
 * "Oak St" mostly returns bus stops named after it, which are thrown away, so
 * the map area fell back to a box around the county center that could miss
 * the run entirely.
 */
async function geocode(query: string, bias: { lat: number; lon: number }): Promise<PhotonFeature[]> {
  const first = /\bschool\b/i.test(query)
    ? await photon(query, bias, { tag: "amenity:school" })
    : await photon(query, bias, { layer: "street" });
  if (first.some((f) => keepFeature(f, bias))) return first;
  return photon(query, bias);
}

async function areaBias(area: string): Promise<{ lat: number; lon: number; label: string }> {
  const q = area.trim() || WAKE.label;
  if (/wake/i.test(q)) return { ...WAKE };
  try {
    const features = await photon(q, WAKE);
    const hit = features.find((f) => f.geometry?.coordinates && (f.properties?.countrycode === "US" || !f.properties?.countrycode));
    if (hit?.geometry?.coordinates) {
      const [lon, lat] = hit.geometry.coordinates;
      return { lat, lon, label: hit.properties?.name || q };
    }
  } catch {
    /* the street search still has the Wake County center to lean on */
  }
  return { ...WAKE, label: q };
}

let tileTemplate: string | null = null;

async function template(): Promise<string> {
  if (tileTemplate) return tileTemplate;
  const res = await fetch("https://tiles.openfreemap.org/planet");
  if (!res.ok) throw new Error("Map tiles are unavailable right now.");
  const json = (await res.json()) as { tiles?: string[] };
  const url = json.tiles?.[0];
  if (!url) throw new Error("Map tiles did not say where to download.");
  tileTemplate = url;
  return url;
}

async function readTiles(box: Bbox, onStatus?: (s: string) => void): Promise<MapData> {
  const tiles = tilesInBbox(box);
  onStatus?.(`Reading ${tiles.length} map tiles…`);
  const pattern = await template();
  const buffers: TileBuffer[] = [];
  await Promise.all(
    tiles.map(async (t) => {
      const url = pattern.replace("{z}", String(t.z)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
      const res = await fetch(url);
      if (!res.ok) return;
      buffers.push({ ...t, bytes: new Uint8Array(await res.arrayBuffer()) });
    }),
  );
  if (!buffers.length) throw new Error("No map tiles came back. Check the connection and try again.");
  return decodeTiles(buffers);
}

/** Tiles covering the straight-line corridor between two runs, for the deadhead drive. */
export async function loadCorridor(a: LonLat, b: LonLat, onStatus?: (s: string) => void): Promise<MapData> {
  const box: Bbox = {
    minLon: Math.min(a[0], b[0]) - 0.025,
    maxLon: Math.max(a[0], b[0]) + 0.025,
    minLat: Math.min(a[1], b[1]) - 0.025,
    maxLat: Math.max(a[1], b[1]) + 0.025,
  };
  return readTiles(box, onStatus);
}

export async function loadMap(
  sheet: Sheet,
  area: string,
  onStatus?: (s: string) => void,
): Promise<MapData> {
  onStatus?.("Finding these streets…");
  const bias = await areaBias(area);
  const queries = sheetQueries(sheet);
  const points: { lon: number; lat: number; extent?: Bbox }[] = [];
  for (const q of queries) {
    try {
      const features = await geocode(q, bias);
      for (const f of features) {
        const k = keepFeature(f, bias);
        if (k) {
          points.push(k);
          break;
        }
      }
    } catch {
      /* one missed street should not sink the sheet */
    }
  }
  const box = bboxFromPoints(points) ?? {
    minLon: bias.lon - 0.08,
    maxLon: bias.lon + 0.08,
    minLat: bias.lat - 0.06,
    maxLat: bias.lat + 0.06,
  };
  onStatus?.("Matching the printed streets…");
  return readTiles(box, onStatus);
}
