import { decodeTiles, type TileBuffer } from "./engine/tiles";
import { expandPlaceQuery, looksLikePlace, schoolSig, titleCaseStreet } from "./engine/names";
import { matchPlace } from "./engine/route";
import { KNOWN_SCHOOLS, WAKE_BBOX } from "./engine/schools";
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
  // Keep answers in Wake County; the bias pulls them toward the run.
  url.searchParams.set("bbox", `${WAKE_BBOX.minLon},${WAKE_BBOX.minLat},${WAKE_BBOX.maxLon},${WAKE_BBOX.maxLat}`);
  url.searchParams.set("lat", String(bias.lat));
  url.searchParams.set("lon", String(bias.lon));
  url.searchParams.set("limit", "5");
  const key = url.toString();
  const hit = photonCache.get(key);
  if (hit) return hit;
  // The public geocoder turns away bursts (and then sends no CORS header, so
  // the browser only sees a failed fetch) and sometimes never answers. Space
  // the lookups out, give up on one after a few seconds, and try once more.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const features = await queued(() => fetchJson<{ features?: PhotonFeature[] }>(key, 8000));
      const out = features.features ?? [];
      photonCache.set(key, out);
      return out;
    } catch (err) {
      lastError = err;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The geocoder did not answer.");
}

const photonCache = new Map<string, PhotonFeature[]>();
let lane: Promise<unknown> = Promise.resolve();
let lastCall = 0;
const GAP_MS = 400;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** One geocoder request at a time, at most one every GAP_MS. */
function queued<T>(job: () => Promise<T>): Promise<T> {
  const run = lane.then(async () => {
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return job();
  });
  lane = run.catch(() => undefined);
  return run;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`Geocoder responded ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function keepFeature(
  f: PhotonFeature,
  bias: { lat: number; lon: number },
  maxKm = 45,
): { lon: number; lat: number; extent?: Bbox; name?: string } | null {
  const coords = f.geometry?.coordinates;
  if (!coords) return null;
  const [lon, lat] = coords;
  const props = f.properties ?? {};
  const name = `${props.name ?? ""} ${props.osm_value ?? ""}`;
  if (/\b(trail|greenway|bus_stop|platform)\b/i.test(name)) return null;
  if (props.countrycode && props.countrycode !== "US") return null;
  const dLat = (lat - bias.lat) * 111;
  const dLon = (lon - bias.lon) * 111 * Math.cos((bias.lat * Math.PI) / 180);
  if (Math.hypot(dLat, dLon) > maxKm) return null;
  let extent: Bbox | undefined;
  if (props.extent && props.extent.length === 4) {
    const [minLon, maxLat, maxLon, minLat] = props.extent;
    extent = { minLon, minLat, maxLon, maxLat };
  }
  return { lon, lat, extent, name: props.name };
}

/** The built-in school list, in the shape the route builder matches against. */
export const knownPlaces: RawPlace[] = KNOWN_SCHOOLS.map(([name, lat, lon]) => ({ name, lat, lon, ...schoolSig(name) }));

function knownSchool(raw: string): RawPlace | null {
  return looksLikePlace(raw) ? matchPlace(raw, knownPlaces) : null;
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

/** A tile that hangs should not hold up the map; one retry for a dropped one. */
async function fetchTile(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (res.ok || res.status === 404) return res;
    } catch {
      /* try again below */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function readTiles(box: Bbox, onStatus?: (s: string) => void): Promise<MapData> {
  const tiles = tilesInBbox(box);
  onStatus?.(`Reading ${tiles.length} map tiles…`);
  const pattern = await template();
  const buffers: TileBuffer[] = [];
  await Promise.all(
    tiles.map(async (t) => {
      const url = pattern.replace("{z}", String(t.z)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
      const res = await fetchTile(url);
      if (!res?.ok) return;
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
  const points: { lon: number; lat: number; extent?: Bbox }[] = [];
  // Schools the app already knows anchor the area without asking the geocoder.
  for (const raw of sheetPlaceNames(sheet)) {
    const p = knownSchool(raw);
    if (p) points.push({ lon: p.lon, lat: p.lat });
  }
  const queries = sheetQueries(sheet).filter((q) => !knownSchool(q));
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    onStatus?.(`Finding street ${i + 1} of ${queries.length}…`);
    // Once one stop is found, look for the rest near it, not across the county.
    const anchor = points.length ? middle(points) : null;
    try {
      const features = await geocode(q, anchor ?? bias);
      for (const f of features) {
        const k = keepFeature(f, anchor ?? bias, anchor ? 20 : 45);
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
  return withKnownSchools(await readTiles(box, onStatus), box);
}

function middle(points: { lon: number; lat: number }[]): { lon: number; lat: number } {
  const lats = points.map((p) => p.lat).sort((a, b) => a - b);
  const lons = points.map((p) => p.lon).sort((a, b) => a - b);
  return { lat: lats[Math.floor(lats.length / 2)], lon: lons[Math.floor(lons.length / 2)] };
}

function sheetPlaceNames(sheet: Sheet): string[] {
  const out: string[] = [];
  for (const stop of sheet.stops) {
    const loc = classifyLocation(stop.description);
    if (loc.kind === "school") out.push(loc.name);
    for (const m of stop.maneuvers) if (looksLikePlace(m.street)) out.push(m.street);
  }
  return out;
}

/** Add the built-in schools inside the map area that the tiles didn't label. */
function withKnownSchools(data: MapData, box: Bbox): MapData {
  const extra = knownPlaces.filter(
    (k) =>
      k.lon >= box.minLon && k.lon <= box.maxLon && k.lat >= box.minLat && k.lat <= box.maxLat &&
      !data.places.some((p) => p.tokens === k.tokens && (p.level || "") === (k.level || "") && Math.abs(p.lat - k.lat) < 0.01 && Math.abs(p.lon - k.lon) < 0.01),
  );
  return extra.length ? { ...data, places: [...data.places, ...extra] } : data;
}

export type Lookup = { name: string; lat: number; lon: number; place: boolean };

/**
 * Look one name up right now, near the run: a school from the built-in list
 * or the geocoder, or a street from the geocoder. Null when nothing matching
 * is within a few miles of the run.
 */
export async function lookupName(raw: string, near: { lat: number; lon: number }): Promise<Lookup | null> {
  const known = knownSchool(raw);
  if (known) return { name: known.name, lat: known.lat, lon: known.lon, place: true };
  const q = streetQuery(raw).trim();
  if (!q) return null;
  const features = await geocode(q, near);
  for (const f of features) {
    const k = keepFeature(f, near, 12);
    if (k) return { name: k.name ?? q, lat: k.lat, lon: k.lon, place: looksLikePlace(raw) };
  }
  return null;
}

/** Map data for a small area around one point, to add to a run's map. */
export async function loadAround(point: { lat: number; lon: number }, onStatus?: (s: string) => void): Promise<MapData> {
  const d = 0.012;
  const box = { minLon: point.lon - d, maxLon: point.lon + d, minLat: point.lat - d, maxLat: point.lat + d };
  return withKnownSchools(await readTiles(box, onStatus), box);
}

/** Two map areas as one. */
export function mergeMaps(a: MapData, b: MapData): MapData {
  const seen = new Set(a.places.map((p) => `${p.name}|${p.lat.toFixed(4)}|${p.lon.toFixed(4)}`));
  return {
    lines: [...a.lines, ...b.lines],
    places: [...a.places, ...b.places.filter((p) => !seen.has(`${p.name}|${p.lat.toFixed(4)}|${p.lon.toFixed(4)}`))],
  };
}
