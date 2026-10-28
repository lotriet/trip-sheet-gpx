/**
 * Download Wake County's drivable roads and schools from OpenStreetMap and
 * write them to public/roads as one small file per cell.
 *
 *   npm run roads                 download, then write
 *   npm run roads -- roads.json   write from an Overpass answer saved earlier
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cellName, onewayOf, ROAD_AREA, ROAD_CELL_DEG, type RoadCell, type RoadWay } from "../src/lib/engine/roads";

const SERVERS = ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter"];
const HIGHWAYS =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|busway|" +
  "motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";
const box = (minLat: number, minLon: number, maxLat: number, maxLon: number) => `${minLat},${minLon},${maxLat},${maxLon}`;
const roadsQuery = (b: string) => `[out:json][timeout:600];way["highway"~"^(${HIGHWAYS})$"](${b});out geom tags;`;
const SCHOOLS = `[out:json][timeout:300];nwr["amenity"="school"]["name"](${box(ROAD_AREA.minLat, ROAD_AREA.minLon, ROAD_AREA.maxLat, ROAD_AREA.maxLon)});out center tags;`;
/** The county in 4 × 4 pieces: one query for all of it times out. */
const PIECES = 4;

type Element = {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
};

async function ask(query: string): Promise<Element[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const server of SERVERS) {
      try {
        const res = await fetch(server, {
          method: "POST",
          headers: { "User-Agent": "trip-sheet-gpx road extract", "Content-Type": "application/x-www-form-urlencoded" },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (res.ok) return ((await res.json()) as { elements: Element[] }).elements;
        console.log(`  ${server} answered ${res.status}`);
      } catch (err) {
        console.log(`  ${server}: ${err instanceof Error ? err.message : err}`);
      }
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error("No Overpass server answered.");
}

async function download(): Promise<{ elements: Element[] }> {
  const elements: Element[] = [];
  const dLon = (ROAD_AREA.maxLon - ROAD_AREA.minLon) / PIECES;
  const dLat = (ROAD_AREA.maxLat - ROAD_AREA.minLat) / PIECES;
  for (let i = 0; i < PIECES; i++) {
    for (let j = 0; j < PIECES; j++) {
      const minLon = ROAD_AREA.minLon + i * dLon;
      const minLat = ROAD_AREA.minLat + j * dLat;
      console.log(`roads, piece ${i * PIECES + j + 1} of ${PIECES * PIECES}…`);
      elements.push(...(await ask(roadsQuery(box(minLat, minLon, minLat + dLat, minLon + dLon)))));
    }
  }
  console.log("schools…");
  elements.push(...(await ask(SCHOOLS)));
  return { elements };
}

const SKIP_SERVICE = new Set(["driveway", "parking_aisle", "drive-through", "emergency_access"]);
const round = (v: number) => Math.round(v * 1e6) / 1e6;
const cellOf = (lon: number, lat: number) => cellName(Math.floor(lon / ROAD_CELL_DEG), Math.floor(lat / ROAD_CELL_DEG));

const data = process.argv[2] ? (JSON.parse(readFileSync(process.argv[2], "utf8")) as { elements: Element[] }) : await download();
if (!process.argv[2]) writeFileSync(new URL("../.roads-download.json", import.meta.url), JSON.stringify(data));
const cells = new Map<string, RoadCell>();
const cell = (name: string) => {
  let c = cells.get(name);
  if (!c) cells.set(name, (c = { ways: [], schools: [] }));
  return c;
};

/** Douglas–Peucker in meters, never dropping a point in [keep]. */
function simplify(points: { lat: number; lon: number }[], keep: Set<string>, tolerance = 1.5) {
  const mx = 111320 * Math.cos((points[0].lat * Math.PI) / 180);
  const xy = points.map((p) => [p.lon * mx, p.lat * 110540]);
  const kept = new Array(points.length).fill(false);
  kept[0] = kept[points.length - 1] = true;
  points.forEach((p, i) => {
    if (keep.has(at(p))) kept[i] = true;
  });
  const split = (a: number, b: number) => {
    let far = -1;
    let most = tolerance;
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - xy[i][1]) - (ax - xy[i][0]) * (by - ay)) / len;
      if (kept[i] || d > most) {
        far = i;
        most = kept[i] ? Infinity : d;
        if (kept[i]) break;
      }
    }
    if (far < 0) return;
    kept[far] = true;
    split(a, far);
    split(far, b);
  };
  split(0, points.length - 1);
  return points.filter((_, i) => kept[i]);
}
const at = (p: { lat: number; lon: number }) => `${round(p.lon)},${round(p.lat)}`;

// Points two ways share are junctions; simplifying must keep them.
const uses = new Map<string, number>();
const counted = new Set<number>();
for (const el of data.elements) {
  if (el.type !== "way" || !el.geometry || counted.has(el.id)) continue;
  counted.add(el.id);
  for (const p of new Set(el.geometry.map(at))) uses.set(p, (uses.get(p) ?? 0) + 1);
}
const junctions = new Set([...uses].filter(([, n]) => n > 1).map(([p]) => p));

const done = new Set<number>();
let ways = 0;
let schools = 0;
for (const el of data.elements) {
  const tags = el.tags ?? {};
  if (tags.amenity === "school" && tags.name) {
    const at = el.center ?? (el.lat != null && el.lon != null ? { lat: el.lat, lon: el.lon } : null);
    if (!at) continue;
    cell(cellOf(at.lon, at.lat)).schools.push([tags.name, round(at.lat), round(at.lon)]);
    schools++;
    continue;
  }
  if (el.type !== "way" || !el.geometry || el.geometry.length < 2 || !tags.highway || done.has(el.id)) continue;
  done.add(el.id);
  // Driveways, parking aisles and drive-throughs are half the county's ways and no bus route.
  if (tags.highway === "service" && SKIP_SERVICE.has(tags.service ?? "")) continue;
  const way: RoadWay = { id: el.id, h: tags.highway.replace(/_link$/, ""), c: simplify(el.geometry, junctions).flatMap((p) => [round(p.lon), round(p.lat)]) };
  if (tags.name) way.n = tags.name;
  if (tags.ref) way.r = tags.ref;
  const oneway = onewayOf(tags);
  if (oneway) way.o = oneway;
  if (tags.service) way.s = tags.service;
  if (tags.access) way.a = tags.access;
  // A way crossing cells is stored whole in each, so every cell sees its ends.
  const touched = new Set(el.geometry.map((p) => cellOf(p.lon, p.lat)));
  for (const name of touched) cell(name).ways.push(way);
  ways++;
}

const out = new URL("../public/roads/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let bytes = 0;
for (const [name, c] of cells) {
  const text = JSON.stringify(c);
  bytes += text.length;
  writeFileSync(new URL(`${name}.json`, out), text);
}
writeFileSync(
  new URL("meta.json", out),
  JSON.stringify({ updated: new Date().toISOString().slice(0, 10), cell: ROAD_CELL_DEG, area: ROAD_AREA, cells: [...cells.keys()].sort() }),
);
console.log(`${ways} ways, ${schools} schools in ${cells.size} cells, ${(bytes / 1e6).toFixed(1)} MB`);
