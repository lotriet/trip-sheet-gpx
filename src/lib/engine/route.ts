import { buildGpx } from "./gpx";
import {
  arrivalHeading,
  appendLine,
  departureHeading,
  haversine,
  minDistToLine,
  nearestIndex,
  polylineMeters,
  projectPoint,
  turnAngle,
} from "./geo";
import { buildGraph, edgeHas, edgeServes, keysInGraph, nodeHas, type Graph, type GraphEdge, type GraphLine, type GraphNode } from "./graph";
import { canonicalKey, looksLikePlace, sameSchool, schoolSig, withoutDirection } from "./names";
import { classifyLocation, flattenManeuvers } from "./parseSheet";
import type {
  LonLat,
  ManeuverKind,
  RawLine,
  RawPlace,
  RouteFailure,
  RouteLeg,
  RouteOverrides,
  RouteResult,
  RouteSuccess,
  Sheet,
  TurnaroundPin,
  TurnMark,
  Warning,
} from "./types";

type Goal =
  | { type: "turn"; key: string; dir: "left" | "right" | null }
  | { type: "node"; id: string };

type Travel = {
  coords: LonLat[];
  node: GraphNode;
  heading: number;
  meters: number;
  matched: boolean;
};

class MinHeap<T> {
  private a: { k: number; v: T }[] = [];
  get size() {
    return this.a.length;
  }
  push(k: number, v: T) {
    const a = this.a;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { k: number; v: T } | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l].k < a[s].k) s = l;
        if (r < a.length && a[r].k < a[s].k) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

function placeRouteKey(p: { tokens: string; level: string }): string {
  return `place:${p.tokens}:${p.level || "any"}`;
}

export function matchPlace(raw: string, places: RawPlace[]): RawPlace | null {
  const sig = schoolSig(raw.replace(/^\s*school\s*:\s*/i, ""));
  // Re-read each place's name, so places saved by an older version still match.
  const sigs = places.map((p) => ({ p, s: { ...schoolSig(p.name), level: schoolSig(p.name).level || p.level } }));
  let hits = sigs.filter((x) => sameSchool(sig, x.s)).map((x) => x.p);
  if (!hits.length && sig.tokens.length >= 5) {
    // A letter misread: "GREEN HOEP HS". Same level, names one or two edits apart.
    const max = sig.tokens.length >= 10 ? 2 : 1;
    hits = sigs
      .filter((x) => (!sig.level || !x.s.level || sig.level === x.s.level) && editDistance(sig.tokens, x.s.tokens) <= max)
      .map((x) => x.p);
  }
  if (!hits.length) return null;
  // Duplicate POI pins: keep the first; they sit on the same campus.
  return hits[0];
}

export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

function lineNear(coords: LonLat[], point: LonLat, maxM: number): boolean {
  return minDistToLine(point, coords).d <= maxM;
}

type MappedRoad = { coords: LonLat[]; minLon: number; maxLon: number; minLat: number; maxLat: number };

/** Real (not synthetic) road geometry with bounding boxes, for quick nearness checks. */
function mappedRoadIndex(graph: Graph): MappedRoad[] {
  const out: MappedRoad[] = [];
  for (const edge of graph.edges) {
    if (edge.synthetic || edge.coords.length < 2) continue;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of edge.coords) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    out.push({ coords: edge.coords, minLon, maxLon, minLat, maxLat });
  }
  return out;
}

/** Every point along [line] lies within a few meters of mapped road. */
function overliesMappedRoad(line: LonLat[], roads: MappedRoad[], tolerance = 4): boolean {
  const pad = 0.0001; // about 10 m
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const steps = Math.max(2, Math.ceil(haversine(a, b) / 8));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const p: LonLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const covered = roads.some((road) =>
        p[0] >= road.minLon - pad && p[0] <= road.maxLon + pad && p[1] >= road.minLat - pad && p[1] <= road.maxLat + pad &&
        minDistToLine(p, road.coords).d <= tolerance,
      );
      if (!covered) return false;
    }
  }
  return true;
}

function trackUsesLine(track: LonLat[], line: LonLat[]): boolean {
  if (track.length < 2 || line.length < 2) return false;
  const a = line[0];
  const b = line[line.length - 1];
  const mid: LonLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [a, mid, b].every((point) => minDistToLine(point, track).d <= 3);
}

/** Named streets, plus service roads around each school the sheet turns into. */
export function prepareLines(sheet: Sheet, named: RawLine[], services: RawLine[], places: RawPlace[]): GraphLine[] {
  const lines: GraphLine[] = named
    .filter((l) => l.kind === "named" && l.keys.length && l.coords.length >= 2)
    .map((l) => ({ name: l.name, keys: l.keys, coords: l.coords, oneway: l.oneway, onewayKnown: l.onewayKnown }));

  const flat = flattenManeuvers(sheet);
  const attached = new Set<string>();

  for (let i = 0; i < flat.length; i++) {
    const raw = flat[i].maneuver.street;
    if (!looksLikePlace(raw)) continue;
    const place = matchPlace(raw, places);
    if (!place) continue;
    const pk = placeRouteKey(place);
    if (attached.has(pk)) continue;
    attached.add(pk);
    const point: LonLat = [place.lon, place.lat];
    const near = services.filter((s) => s.coords.length >= 2 && lineNear(s.coords, point, 480) && polylineMeters(s.coords) >= 12);
    for (const s of near) lines.push({ name: place.name, keys: [pk], coords: s.coords, oneway: s.oneway, onewayKnown: s.onewayKnown });

    const prev = i > 0 ? flat[i - 1].maneuver.street : "";
    const approach = prev && !looksLikePlace(prev) ? canonicalKey(prev) : null;
    const approachLines = approach ? lines.filter((l) => l.keys.includes(approach) && !l.keys.includes(pk)) : [];
    const fallbackLines = lines.filter((l) => l.keys[0] && !l.keys[0].startsWith("place:"));

    for (const s of near) {
      for (const end of [s.coords[0], s.coords[s.coords.length - 1]]) {
        const pick = (cands: GraphLine[], maxM: number) => {
          let best: { d: number; point: LonLat } | null = null;
          for (const n of cands) {
            const hit = minDistToLine(end, n.coords);
            if (hit.d < maxM && (!best || hit.d < best.d)) best = hit;
          }
          return best;
        };
        const hit = (approachLines.length ? pick(approachLines, 45) : null) ?? pick(fallbackLines, 30);
        if (hit && hit.d > 1.2) lines.push({ name: place.name, keys: [pk], coords: [hit.point, end], oneway: 0, onewayKnown: false });
      }
    }
  }
  return lines;
}

/** Pairs of streets the sheet expects to meet: one direction after another, and each stop's corner. */
function meetingPairs(sheet: Sheet, available: Set<string>, places: RawPlace[]): [string, string][] {
  const out = new Map<string, [string, string]>();
  const add = (a: string, b: string) => {
    if (!a || !b || a === b || a.startsWith("place:") || b.startsWith("place:")) return;
    const id = [a, b].sort().join("|");
    if (!out.has(id)) out.set(id, [a, b]);
  };
  const flat = flattenManeuvers(sheet);
  // A bare name with several direction variants pairs with each of them.
  const addAll = (as: string[], bs: string[]) => {
    for (const a of as.slice(0, 4)) for (const b of bs.slice(0, 4)) add(a, b);
  };
  let prev: string[] = [];
  for (const f of flat) {
    if (f.maneuver.kind === "proceed" && isRoundabout(f.maneuver.street)) continue;
    const keys = candidateKeys(f.maneuver.street, available, places);
    addAll(prev, keys);
    prev = keys;
  }
  for (const stop of sheet.stops) {
    const loc = classifyLocation(stop.description);
    if (loc.kind === "intersection") addAll(candidateKeys(loc.a, available, places), candidateKeys(loc.b, available, places));
  }
  return [...out.values()];
}

const GAP_M = 40;

/**
 * The map tiles carry only named streets, so the unnamed piece where two of
 * them meet (a roundabout, a short link, a divided-road crossover) is missing
 * and the streets stop 10–40 m apart. For streets the sheet says meet but that
 * never touch in the tiles, add a short join at each place they come closest.
 */
export function gapLinks(pairs: [string, string][], lines: GraphLine[]): GraphLine[] {
  const out: GraphLine[] = [];
  for (const [a, b] of pairs) {
    const A = lines.filter((l) => l.keys.includes(a));
    const B = lines.filter((l) => l.keys.includes(b));
    if (!A.length || !B.length) continue;
    const hits: { d: number; p: LonLat; q: LonLat }[] = [];
    let touch = false;
    const scan = (from: GraphLine[], to: GraphLine[], flip: boolean) => {
      for (const la of from) {
        for (const p of la.coords) {
          for (const lb of to) {
            const h = minDistToLine(p, lb.coords);
            if (h.d <= 3) touch = true;
            if (h.d <= GAP_M) hits.push(flip ? { d: h.d, p: h.point, q: p } : { d: h.d, p, q: h.point });
          }
        }
      }
    };
    scan(A, B, false);
    scan(B, A, true);
    if (touch || !hits.length) continue;
    hits.sort((x, y) => x.d - y.d);
    const kept: typeof hits = [];
    for (const h of hits) {
      if (kept.some((k) => haversine(k.p, h.p) < 150)) continue;
      kept.push(h);
    }
    for (const h of kept) {
      out.push({ name: "gap", keys: [`xlink:${a}`, `xlink:${b}`, "gap:"], coords: [h.p, h.q], oneway: 0, synthetic: "expected-intersection" });
    }
  }
  return out;
}

function resolveTarget(
  raw: string,
  available: Set<string>,
  places: RawPlace[],
  /** Chooses among several direction variants ("nw cary pkwy", "se cary pkwy"); null when none fits. */
  pick?: (keys: string[]) => string | null,
): { key: string; label: string; how: "street" | "place" | "loose" | "missing" } {
  if (looksLikePlace(raw)) {
    const p = matchPlace(raw, places);
    if (p) {
      const key = placeRouteKey(p);
      return available.has(key)
        ? { key, label: p.name, how: "place" }
        : { key, label: p.name, how: "missing" };
    }
  }
  const key = canonicalKey(raw);
  if (available.has(key)) return { key, label: raw, how: "street" };
  // The sheet drops (or adds) the map's direction: "CARY PKWY" for Southeast
  // Cary Parkway. This comes before the looser suffix match below, which would
  // take a different street ("Cary St"). Several variants (NW, SW, SE Cary
  // Pkwy) are settled by [pick], or left unmatched rather than guessed.
  const bare = withoutDirection(key);
  const directed = [...available].filter((a) => !a.startsWith("place:") && a !== key && withoutDirection(a) === bare);
  if (directed.length === 1) return { key: directed[0], label: raw, how: "loose" };
  if (directed.length > 1) {
    const chosen = pick?.(directed);
    return chosen ? { key: chosen, label: raw, how: "loose" } : { key, label: raw, how: "missing" };
  }
  const strip = (k: string) => k.split(" ").slice(0, -1).join(" ");
  const suffix = new Set(["st", "rd", "dr", "ln", "ct", "ave", "blvd", "pkwy", "cir", "pl", "trl", "ter", "way", "hwy", "xing"]);
  const hits = [...available].filter((a) => {
    if (a.startsWith("place:")) return false;
    if (a === key) return true;
    const as = suffix.has(a.split(" ").at(-1) ?? "") ? strip(a) : a;
    const ks = suffix.has(key.split(" ").at(-1) ?? "") ? strip(key) : key;
    return as === ks && as.length > 0;
  });
  if (hits.length === 1) return { key: hits[0], label: raw, how: "loose" };
  // A space dropped or added by the reader ("MAPLEW OOD MILL RD"), the
  // same rule the street check in the form uses, so a green mark always routes.
  const squashed = key.replace(/\s+/g, "");
  const joined = [...available].filter((a) => !a.startsWith("place:") && a.replace(/\s+/g, "") === squashed);
  if (joined.length === 1) return { key: joined[0], label: raw, how: "loose" };
  return { key, label: raw, how: "missing" };
}

/** Every key a sheet name may mean: one when it resolves, else each direction variant. */
function candidateKeys(raw: string, available: Set<string>, places: RawPlace[]): string[] {
  const resolved = resolveTarget(raw, available, places);
  if (resolved.how !== "missing") return [resolved.key];
  const bare = withoutDirection(resolved.key);
  const directed = [...available].filter((a) => !a.startsWith("place:") && withoutDirection(a) === bare);
  return directed.length ? directed : [resolved.key];
}

/** The two streets of an intersection stop, choosing the direction variants that actually meet. */
function intersectionKeys(graph: Graph, a: string, b: string, available: Set<string>, places: RawPlace[]): [string, string] {
  const as = candidateKeys(a, available, places);
  const bs = candidateKeys(b, available, places);
  for (const ka of as) for (const kb of bs) if (intersectionNodes(graph, ka, kb).length) return [ka, kb];
  return [as[0], bs[0]];
}

function reconstruct(
  prev: Map<string, { via: string; edge: GraphEdge }>,
  id: string,
): { coords: LonLat[]; edge: GraphEdge | null } {
  const edges: GraphEdge[] = [];
  let cur = id;
  const guard = new Set<string>();
  while (prev.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    const p = prev.get(cur)!;
    edges.push(p.edge);
    cur = p.via;
  }
  edges.reverse();
  const coords: LonLat[] = [];
  for (const e of edges) appendLine(coords, e.coords, 0.3);
  return { coords, edge: edges.at(-1) ?? null };
}

function follow(
  graph: Graph,
  start: GraphNode,
  heading: number | null,
  alongKey: string,
  goal: Goal,
  maxMeters = 16000,
  strict = false,
  minMeters = 12,
): Travel | null {
  const best = new Map<string, number>();
  const prev = new Map<string, { via: string; edge: GraphEdge }>();
  const head = new Map<string, number | null>();
  const heap = new MinHeap<string>();
  best.set(start.id, 0);
  head.set(start.id, heading);
  heap.push(0, start.id);

  let matchId: string | null = null;
  let anyId: string | null = null;
  let anyDist = Infinity;
  let pops = 0;

  const isMatch = (id: string, arrived: number | null) => {
    if (id === start.id) return false;
    const node = graph.nodes.get(id);
    if (!node) return false;
    if (goal.type === "node") return id === goal.id;
    if (!nodeHas(node, goal.key)) return false;
    if (goal.dir == null || arrived == null) return true;
    return node.out.some((e) => {
      if (!edgeServes(e, goal.key)) return false;
      const ang = turnAngle(arrived, departureHeading(e.coords));
      return goal.dir === "right" ? ang > 25 && ang < 165 : ang < -25 && ang > -165;
    });
  };

  while (heap.size && pops < 25000) {
    const item = heap.pop();
    if (!item) break;
    pops++;
    const dist = item.k;
    const id = item.v;
    if (dist !== best.get(id)) continue;
    if (dist > maxMeters) break;
    const arrived = head.get(id) ?? null;
    const minTravel = goal.type === "node" ? 1 : minMeters;
    if (dist >= minTravel && isMatch(id, arrived)) {
      matchId = id;
      break;
    }
    if (dist >= 12 && goal.type === "turn" && id !== start.id && nodeHas(graph.nodes.get(id)!, goal.key) && dist < anyDist) {
      anyDist = dist;
      anyId = id;
    }
    const node = graph.nodes.get(id)!;
    for (const e of node.out) {
      if (!edgeHas(e, alongKey)) continue;
      const dep = departureHeading(e.coords);
      if (arrived != null) {
        const ang = Math.abs(turnAngle(arrived, dep));
        if (id === start.id && ang > 80) continue;
        if (ang > 158) continue;
      }
      const nd = dist + e.length;
      const to = e.to;
      if (nd + 0.2 < (best.get(to) ?? Infinity)) {
        best.set(to, nd);
        prev.set(to, { via: id, edge: e });
        head.set(to, arrivalHeading(e.coords));
        heap.push(nd, to);
      }
    }
  }

  const chosen = matchId ?? (strict ? null : anyId);
  if (!chosen) return null;
  const path = reconstruct(prev, chosen);
  const end = graph.nodes.get(chosen)!;
  const endHeading = path.edge ? arrivalHeading(path.edge.coords) : (heading ?? 0);
  return {
    coords: path.coords,
    node: end,
    heading: endHeading,
    meters: best.get(chosen) ?? polylineMeters(path.coords),
    matched: matchId != null,
  };
}

function downstreamMeters(graph: Graph, edge: GraphEdge, key: string): number {
  let total = edge.length;
  const seen = new Set<string>([edge.from, edge.to]);
  const q: { id: string; dist: number }[] = [{ id: edge.to, dist: 0 }];
  while (q.length) {
    const cur = q.shift()!;
    if (cur.dist > 350) continue;
    const node = graph.nodes.get(cur.id);
    if (!node) continue;
    for (const e of node.out) {
      if (!edgeHas(e, key) || seen.has(e.to)) continue;
      seen.add(e.to);
      total += e.length;
      q.push({ id: e.to, dist: cur.dist + e.length });
    }
  }
  return total;
}

function chooseTurn(
  node: GraphNode,
  heading: number | null,
  key: string,
  dir: "left" | "right" | "straight",
  graph: Graph,
): { edge: GraphEdge; angle: number; matched: boolean } | null {
  const ideal = dir === "left" ? -90 : dir === "right" ? 90 : 0;
  let best: { edge: GraphEdge; angle: number; score: number } | null = null;
  for (const e of node.out) {
    if (!edgeServes(e, key)) continue;
    const dep = departureHeading(e.coords);
    const angle = heading == null ? ideal : turnAngle(heading, dep);
    if (heading != null && Math.abs(angle) > 170) continue;
    let score = Math.abs(((angle - ideal + 540) % 360) - 180);
    if (key.startsWith("place:")) {
      const down = downstreamMeters(graph, e, key);
      if (down < 35) score += 45;
      score -= Math.min(down, 280) / 50;
    }
    if (!best || score < best.score) best = { edge: e, angle, score };
  }
  if (!best) return null;
  const matched =
    dir === "straight"
      ? Math.abs(best.angle) < 55 || heading == null
      : dir === "right"
        ? best.angle > 30 && best.angle < 155
        : best.angle < -30 && best.angle > -155;
  return { edge: best.edge, angle: best.angle, matched: matched || heading == null };
}

function canTurn(node: GraphNode, heading: number | null, key: string, dir: "left" | "right", graph: Graph): boolean {
  const t = chooseTurn(node, heading, key, dir, graph);
  return !!t && t.matched && Math.abs(t.angle) < 165;
}

function nearestNode(graph: Graph, key: string, point: LonLat, maxM: number): GraphNode | null {
  let best: { n: GraphNode; d: number } | null = null;
  for (const n of graph.nodes.values()) {
    if (!nodeHas(n, key)) continue;
    const d = haversine(n.coord, point);
    if (d <= maxM && (!best || d < best.d)) best = { n, d };
  }
  return best?.n ?? null;
}

/** Closest spot on this street's pavement, not only an intersection. */
function nearestAlong(graph: Graph, key: string, point: LonLat, maxM: number): { edge: GraphEdge; point: LonLat } | null {
  let best: { edge: GraphEdge; point: LonLat; d: number } | null = null;
  for (const edge of graph.edges) {
    if (!edgeServes(edge, key)) continue;
    for (let i = 1; i < edge.coords.length; i++) {
      const proj = projectPoint(point, edge.coords[i - 1], edge.coords[i]);
      if (proj.d <= maxM && (!best || proj.d < best.d)) best = { edge, point: proj.point, d: proj.d };
    }
  }
  return best;
}

type WalkEnd = {
  coords: LonLat[];
  node: GraphNode;
  heading: number;
  far: LonLat;
  how: TurnaroundPin["how"];
};

type TurnCandidate = {
  how: TurnaroundPin["how"];
  dist: number;
  depth: number;
  nodeId: string;
  coords: LonLat[];
  heading: number;
  far: LonLat;
};

function ancestorChain(parent: Map<string, { via: string; edge: GraphEdge }>, id: string): Set<string> {
  const chain = new Set<string>();
  let cur: string | undefined = id;
  while (cur && !chain.has(cur)) {
    chain.add(cur);
    cur = parent.get(cur)?.via;
  }
  return chain;
}

function pathCoords(parent: Map<string, { via: string; edge: GraphEdge }>, id: string): LonLat[] {
  const edges: GraphEdge[] = [];
  let cur = id;
  const guard = new Set<string>();
  while (parent.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    const p = parent.get(cur)!;
    edges.push(p.edge);
    cur = p.via;
  }
  edges.reverse();
  const coords: LonLat[] = [];
  for (const e of edges) appendLine(coords, e.coords, 0.3);
  return coords;
}

/**
 * A turnaround is the first place the street lets the bus reverse:
 * a short loop at the mouth of a court, or the dead end farther along.
 * Campus drives are the exception — the bus loop is the deepest loop on the
 * school roads, not the first parking circle.
 */
function doTurnaround(
  graph: Graph,
  start: GraphNode,
  heading: number | null,
  key: string,
  override?: { lat: number; lon: number },
): WalkEnd {
  if (override) {
    const target = nearestNode(graph, key, [override.lon, override.lat], 120);
    if (target && target.id !== start.id) {
      const leg = follow(graph, start, heading, key, { type: "node", id: target.id }, 8000, true);
      const retry = leg ?? follow(graph, start, null, key, { type: "node", id: target.id }, 8000, true);
      if (retry) {
        const h = (retry.heading + 180) % 360;
        return { coords: retry.coords, node: retry.node, heading: h, far: retry.node.coord, how: "override" };
      }
    }
  }

  const deep = key.startsWith("place:");
  const best = new Map<string, number>([[start.id, 0]]);
  const parent = new Map<string, { via: string; edge: GraphEdge }>();
  const head = new Map<string, number | null>([[start.id, heading]]);
  const heap = new MinHeap<string>();
  heap.push(0, start.id);
  const loops: TurnCandidate[] = [];
  const ends: TurnCandidate[] = [];
  let pops = 0;

  const consider = (cand: TurnCandidate, bag: TurnCandidate[]) => {
    bag.push(cand);
  };

  while (heap.size && pops < 12000) {
    const item = heap.pop();
    if (!item) break;
    pops++;
    const dist = item.k;
    const id = item.v;
    if (dist !== best.get(id)) continue;
    if (dist > 3200) break;
    const node = graph.nodes.get(id);
    if (!node) continue;
    const arrived = head.get(id) ?? null;
    const chain = id === start.id ? new Set<string>([start.id]) : ancestorChain(parent, id);
    const options = node.out.filter((e) => edgeHas(e, key));
    let forward = 0;
    for (const e of options) {
      const dep = departureHeading(e.coords);
      const ang = arrived == null ? 0 : Math.abs(turnAngle(arrived, dep));
      // 175, not 150: a tight cul-de-sac bends harder than a normal turn, but a pure reversal stays out.
      if (arrived != null && ang > 175) continue;
      const known = best.has(e.to);
      if (known && e.to !== id && dist + e.length > 20) {
        const cycle = cycleMeters(id, e.to, e.length, parent, best);
        const limit = deep ? 900 : 200;
        if (cycle >= 30 && cycle <= limit && dist <= (deep ? 1800 : 250)) {
          const coords = pathCoords(parent, id);
          appendLine(coords, e.coords, 0.3);
          let far = node.coord;
          let farD = -1;
          for (const p of coords) {
            const d = haversine(start.coord, p);
            if (d > farD) {
              farD = d;
              far = p;
            }
          }
          if (farD >= 12) {
            consider(
              {
                how: "loop",
                dist: dist + e.length,
                depth: farD,
                nodeId: e.to,
                coords,
                heading: arrivalHeading(e.coords),
                far,
              },
              loops,
            );
          }
        }
        if (chain.has(e.to)) continue;
      }
      if (chain.has(e.to)) continue;
      forward++;
      const nd = dist + e.length;
      if (nd + 0.2 < (best.get(e.to) ?? Infinity) && nd <= 3200) {
        best.set(e.to, nd);
        parent.set(e.to, { via: id, edge: e });
        head.set(e.to, arrivalHeading(e.coords));
        heap.push(nd, e.to);
      }
    }
    if (id !== start.id && forward === 0 && dist >= 12 && dist <= 3000) {
      const coords = pathCoords(parent, id);
      consider(
        {
          how: "deadend",
          dist,
          depth: haversine(start.coord, node.coord),
          nodeId: id,
          coords,
          heading: ((arrived ?? heading ?? 0) + 180) % 360,
          far: node.coord,
        },
        ends,
      );
    }
  }

  const pick = chooseTurnaround(loops, ends, deep);
  if (!pick) {
    return { coords: [], node: start, heading: heading ?? 0, far: start.coord, how: "fallback" };
  }
  const endNode = graph.nodes.get(pick.nodeId) ?? start;
  const how: TurnaroundPin["how"] = pick.dist >= 3100 ? "capped" : pick.how;
  return { coords: pick.coords, node: endNode, heading: pick.heading, far: pick.far, how };
}

function cycleMeters(
  here: string,
  other: string,
  edgeLen: number,
  parent: Map<string, { via: string; edge: GraphEdge }>,
  best: Map<string, number>,
): number {
  const chain = ancestorChain(parent, here);
  if (chain.has(other)) return (best.get(here) ?? 0) + edgeLen - (best.get(other) ?? 0);
  let cur = other;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (chain.has(cur)) {
      const lca = best.get(cur) ?? 0;
      return (best.get(here) ?? 0) + edgeLen + (best.get(other) ?? 0) - 2 * lca;
    }
    seen.add(cur);
    cur = parent.get(cur)?.via ?? "";
  }
  return Infinity;
}

function chooseTurnaround(loops: TurnCandidate[], ends: TurnCandidate[], deep: boolean): TurnCandidate | null {
  if (deep) {
    // The loading loop beats a driveway spur a little farther on.
    const loop = loops.sort((a, b) => b.depth - a.depth)[0];
    const dead = ends.sort((a, b) => b.depth - a.depth)[0];
    if (loop && (!dead || loop.depth + 90 >= dead.depth)) return loop;
    return dead ?? loop ?? null;
  }
  // A bulb at the mouth of the street. Not a median crossover:
  // those stay within a few dozen meters and were already dropped.
  const bulb = loops.filter((c) => c.dist <= 220 && c.depth >= 18 && c.depth <= 160).sort((a, b) => a.dist - b.dist)[0];
  if (bulb) return bulb;
  const farEnough = ends.filter((c) => c.dist <= 1600 && c.depth >= 80);
  const dead = (farEnough.length ? farEnough : ends.filter((c) => c.dist <= 3000)).sort((a, b) => a.dist - b.dist)[0];
  return dead ?? loops.sort((a, b) => a.dist - b.dist)[0] ?? null;
}

/**
 * Nodes where streets [a] and [b] meet. A one-way street that only arrives at
 * the corner still meets it, so incoming edges count as well as outgoing ones.
 */
function intersectionNodes(graph: Graph, a: string, b: string): GraphNode[] {
  const arrives = (key: string) => {
    const ids = new Set<string>();
    for (const e of graph.edges) if (edgeServes(e, key)) ids.add(e.to);
    return ids;
  };
  const inA = arrives(a);
  const inB = arrives(b);
  const out: GraphNode[] = [];
  for (const n of graph.nodes.values()) {
    if ((nodeHas(n, a) || inA.has(n.id)) && (nodeHas(n, b) || inB.has(n.id))) out.push(n);
  }
  return out;
}

function crossKey(
  description: string,
  currentKey: string | null,
  available: Set<string>,
  places: RawPlace[],
): string | null {
  const loc = classifyLocation(description);
  if (loc.kind !== "intersection") return null;
  const keys = [loc.a, loc.b]
    .map((s) => resolveTarget(s, available, places).key)
    .filter((k) => k && k !== currentKey);
  return keys[0] ?? null;
}

/**
 * A road router for the places the map tiles can't connect: returns a driven
 * line through the given points, or null. The app passes one backed by OSRM.
 */
export type Router = (points: LonLat[]) => Promise<LonLat[] | null>;

const JUMP_NOTE = "Couldn't connect";

/** A roundabout named only as such on the sheet, not a street. */
export function isRoundabout(street: string): boolean {
  return /^(?:the\s+)?(?:roundabout|traffic\s+circle|rotary)$/i.test(street.trim());
}

async function routeFrom(
  graph: Graph,
  sheet: Sheet,
  start: GraphNode,
  available: Set<string>,
  places: RawPlace[],
  overrides: RouteOverrides,
  router?: Router,
): Promise<RouteSuccess> {
  const warnings: Warning[] = [];
  const legs: RouteLeg[] = [];
  const turnarounds: TurnaroundPin[] = [];
  const turnMarks: TurnMark[] = [];
  const anchors: { key: string; coord: LonLat; at: number }[] = [];
  const coords: LonLat[] = [[start.coord[0], start.coord[1]]];
  let node = start;
  let heading: number | null = null;
  /** The heading came from a straight join or the road router, so the next turn's angle can't be judged. */
  let roughHeading = false;
  let currentKey: string | null = null;
  /** Intersection we just turned through. The next turn has to happen farther along the street. */
  let skipTurnAt: string | null = null;
  const flat = flattenManeuvers(sheet);
  const vias = (overrides.vias ?? []).map((v, i) => ({ ...v, i, used: false }));

  const warn = (level: Warning["level"], stopIndex: number, maneuverIndex: number, message: string, location?: LonLat) => {
    warnings.push({ level, stopIndex, maneuverIndex, message, ...(location ? { location } : {}) });
  };

  const travel = (along: string, goal: Goal, minMeters = 12): Travel | null => {
    const headings: (number | null)[] = heading == null ? [null] : [heading, null];
    const goals: Goal[] =
      goal.type === "turn" && goal.dir ? [goal, { type: "turn", key: goal.key, dir: null }] : [goal];
    for (const h of headings) {
      for (const g of goals) {
        const leg = follow(graph, node, h, along, g, 16000, true, minMeters);
        if (leg) return leg;
      }
    }
    const loose = goal.type === "turn" ? { type: "turn" as const, key: goal.key, dir: null } : goal;
    return follow(graph, node, null, along, loose, 16000, false, minMeters);
  };

  /** Nodes of a street, nearest a point. */
  const nearestOn = (key: string, point: LonLat, also?: string | null): GraphNode | null => {
    let best: { n: GraphNode; d: number } | null = null;
    for (const n of graph.nodes.values()) {
      if (!nodeHas(n, key) || (also && !nodeHas(n, also))) continue;
      const d = haversine(n.coord, point);
      if (!best || d < best.d) best = { n, d };
    }
    return best?.n ?? null;
  };

  /**
   * The tile graph can't get from here to the next street on the sheet (a
   * piece of road missing from the tiles, an unnamed roundabout). Go to where
   * the two streets meet, or the nearest point of the next street, by the road
   * router, with a via point on the street we're on so it keeps to it.
   */
  const jumpTo = async (toKey: string, label: string, stopIndex: number, maneuverIndex: number): Promise<boolean> => {
    const target = (currentKey ? nearestOn(toKey, node.coord, currentKey) : null) ?? nearestOn(toKey, node.coord);
    if (!target || target.id === node.id) return false;
    const from = node.coord;
    const to = target.coord;
    if (haversine(from, to) > 8000) return false;
    let path: LonLat[] | null = null;
    if (router) {
      const viaNode = currentKey && currentKey !== toKey ? nearestOn(currentKey, to) : null;
      const via = viaNode && haversine(viaNode.coord, to) > 60 && haversine(viaNode.coord, from) > 60 ? viaNode.coord : null;
      try {
        path = await router(via ? [from, via, to] : [from, to]);
      } catch {
        path = null;
      }
      if (path && (
        path.length < 2 ||
        haversine(path[0], from) > 80 ||
        haversine(path.at(-1)!, to) > 80 ||
        polylineMeters(path) > 2.5 * haversine(from, to) + 800 ||
        (via != null && minDistToLine(via, path).d > 80)
      )) path = null;
    }
    const line = path ?? [from, to];
    appendLine(coords, line, 0.4);
    node = target;
    heading = line.length >= 2 ? arrivalHeading(line) : heading;
    roughHeading = true;
    warn(
      path ? "info" : "warn",
      stopIndex,
      maneuverIndex,
      path
        ? `The map tiles have a gap before ${label}; the road router joined it.`
        : `${JUMP_NOTE} to ${label} on the map. The track draws a straight line here. Check it.`,
    );
    return true;
  };

  const hopVias = (key: string) => {
    for (const via of vias) {
      if (via.used) continue;
      const point: LonLat = [via.lon, via.lat];
      // A finger on the phone lands between intersections, often well off a 40 m node.
      const hit = nearestAlong(graph, key, point, 400);
      if (!hit) continue;
      let best: Travel | null = null;
      for (const id of [hit.edge.to, hit.edge.from]) {
        if (id === node.id) continue;
        const leg = follow(graph, node, heading, key, { type: "node", id }, 8000);
        if (!leg) continue;
        if (minDistToLine(hit.point, leg.coords).d > 30) continue;
        if (leg.meters > haversine(node.coord, hit.point) * 2.5 + 250) continue;
        if (!best || leg.meters < best.meters) best = leg;
      }
      if (!best) continue;
      via.used = true;
      appendLine(coords, best.coords, 0.4);
      node = best.node;
      heading = best.heading;
    }
  };

  for (let i = 0; i < flat.length; i++) {
    const { stopIndex, maneuverIndex, maneuver } = flat[i];
    if (maneuver.kind === "proceed" && isRoundabout(maneuver.street)) {
      // "Proceed Onto ROUNDABOUT": drive through it. The next line names the
      // street to leave on, so there is no road called ROUNDABOUT to find.
      legs.push({ stopIndex, maneuverIndex, kind: "proceed", street: maneuver.street, meters: 0 });
      continue;
    }
    const before = polylineMeters(coords);
    // Of several direction variants, the one the bus is nearest to.
    const target = resolveTarget(maneuver.street, available, places, (keys) => {
      let best: { key: string; d: number } | null = null;
      for (const k of keys) {
        const n = nearestOn(k, node.coord);
        const d = n ? haversine(n.coord, node.coord) : Infinity;
        if (d < (best?.d ?? 3000)) best = { key: k, d };
      }
      return best?.key ?? null;
    });
    if (target.how === "missing") {
      warn("warn", stopIndex, maneuverIndex, `Couldn't find “${maneuver.street}” in the map for this area.`);
    } else if (target.how === "loose") {
      warn("info", stopIndex, maneuverIndex, `Matched “${maneuver.street}” to the nearest street name in the map.`);
    }

    if (maneuver.kind === "turnaround") {
      skipTurnAt = null;
      if (currentKey && currentKey !== target.key && target.how !== "missing") {
        const leg = travel(currentKey, { type: "turn", key: target.key, dir: null });
        if (leg) {
          appendLine(coords, leg.coords, 0.4);
          node = leg.node;
          heading = leg.heading;
        } else {
          await jumpTo(target.key, maneuver.street, stopIndex, maneuverIndex);
        }
      }
      const pinId = `${stopIndex}:${maneuverIndex}`;
      const walk = doTurnaround(graph, node, heading, target.how === "missing" ? (currentKey ?? target.key) : target.key, overrides.turnarounds?.[pinId]);
      appendLine(coords, walk.coords, 0.4);
      node = walk.node;
      heading = walk.heading;
      currentKey = target.how === "missing" ? currentKey : target.key;
      const at = Math.max(0, coords.length - 1);
      anchors.push({ key: target.key, coord: walk.far, at });
      const farAt = nearestIndexFrom(coords, walk.far, at - walk.coords.length);
      turnMarks.push({
        stopIndex,
        maneuverIndex,
        kind: "turnaround",
        street: maneuver.street,
        trackIndex: farAt,
        confirmed: walk.how !== "fallback" && walk.how !== "capped",
      });
      turnarounds.push({
        id: pinId,
        stopIndex,
        maneuverIndex,
        street: maneuver.street,
        lat: walk.far[1],
        lon: walk.far[0],
        how: walk.how,
      });
      const where =
        walk.how === "override"
          ? "using the point you set"
          : walk.how === "loop"
            ? "around the loop at the end of the street"
            : walk.how === "capped"
              ? "a few kilometers along the street, because it does not end nearby"
              : walk.how === "fallback"
                ? "at the current spot, because no turnaround was found"
                : "at the end of the street";
      warn(
        walk.how === "fallback" || walk.how === "capped" ? "warn" : "info",
        stopIndex,
        maneuverIndex,
        `Turnaround on ${maneuver.street} was placed ${where}. Move it on the map if the bus turns around somewhere else.`,
      );
    } else if (maneuver.kind === "proceed") {
      skipTurnAt = null;
      if (nodeHas(node, target.key)) {
        // Leave heading unset when we are just starting out, so the next turn can try both directions.
        currentKey = target.key;
      } else if (currentKey && target.how !== "missing") {
        const leg = travel(currentKey, { type: "turn", key: target.key, dir: null });
        if (leg) {
          appendLine(coords, leg.coords, 0.4);
          node = leg.node;
          heading = leg.heading;
          const turn = chooseTurn(node, heading, target.key, "straight", graph);
          if (turn) {
            appendLine(coords, turn.edge.coords, 0.4);
            node = graph.nodes.get(turn.edge.to) ?? node;
            heading = arrivalHeading(turn.edge.coords);
            currentKey = target.key;
          }
        } else if (await jumpTo(target.key, maneuver.street, stopIndex, maneuverIndex)) {
          currentKey = target.key;
        } else {
          warn("warn", stopIndex, maneuverIndex, `Couldn't stay on the sheet from here onto ${maneuver.street}.`);
        }
      } else if (target.how !== "missing") {
        currentKey = target.key;
      }
      if (currentKey) hopVias(currentKey);
    } else {
      const dir = maneuver.kind;
      const sameCorner = skipTurnAt != null && node.id === skipTurnAt;
      let usedClosestConnection = false;
      if (currentKey && currentKey !== target.key && (sameCorner || !canTurn(node, heading, target.key, dir, graph))) {
        if (currentKey) hopVias(currentKey);
        const loose = travel(currentKey, { type: "turn", key: target.key, dir }, sameCorner ? 45 : 12);
        if (loose) {
          appendLine(coords, loose.coords, 0.4);
          node = loose.node;
          heading = loose.heading;
          if (!loose.matched) {
            usedClosestConnection = true;
          }
        } else if (target.how !== "missing" && !(await jumpTo(target.key, maneuver.street, stopIndex, maneuverIndex))) {
          warn("warn", stopIndex, maneuverIndex, `Couldn't follow the sheet onto ${maneuver.street}.`);
        }
      }
      if (target.how !== "missing") {
        const turn = chooseTurn(node, heading, target.key, dir, graph);
        if (turn) {
          // The intersection the bus turns at is the current end of the track.
          turnMarks.push({
            stopIndex,
            maneuverIndex,
            kind: dir,
            street: maneuver.street,
            trackIndex: coords.length - 1,
            confirmed: !usedClosestConnection,
          });
          appendLine(coords, turn.edge.coords, 0.4);
          node = graph.nodes.get(turn.edge.to) ?? node;
          heading = arrivalHeading(turn.edge.coords);
          currentKey = target.key;
          skipTurnAt = node.id;
          if (usedClosestConnection && !turn.matched) {
            warn("warn", stopIndex, maneuverIndex, `The ${dir} turn onto ${maneuver.street} could not be confirmed at a clear intersection. The track uses the closest connection. Check it against the sheet.`);
          }
          if (!turn.matched && !roughHeading && !usedClosestConnection) {
            // Nearly straight on: the street changes its name here, or the road
            // bends into the turn before the junction. The track is still on
            // the named street, so it's a note, not a problem.
            const straightOn = Math.abs(turn.angle) < 30;
            warn(
              straightOn ? "info" : "warn",
              stopIndex,
              maneuverIndex,
              straightOn
                ? `The ${dir} turn onto ${maneuver.street} is almost straight on the map.`
                : `Turned onto ${maneuver.street}, but the angle was not a clear ${dir}. Check this turn.`,
            );
          }
          roughHeading = false;
        } else if (!warnings.some((w) => w.stopIndex === stopIndex && w.maneuverIndex === maneuverIndex)) {
          warn("warn", stopIndex, maneuverIndex, usedClosestConnection
            ? `The ${dir} turn onto ${maneuver.street} could not be confirmed at a clear intersection. The track uses the closest connection. Check it against the sheet.`
            : `No connection found for the ${dir} turn onto ${maneuver.street}.`);
        }
      }
    }

    const last = i === flat.length - 1;
    if (last && currentKey) {
      const dest = crossKey(sheet.stops[sheet.stops.length - 1]?.description ?? "", currentKey, available, places);
      if (dest && !nodeHas(node, dest)) {
        hopVias(currentKey);
        const leg = travel(currentKey, { type: "turn", key: dest, dir: null });
        if (leg) {
          appendLine(coords, leg.coords, 0.4);
          node = leg.node;
          heading = leg.heading;
        } else if (!(await jumpTo(dest, sheet.stops.at(-1)?.description ?? "the last stop", sheet.stops.length - 1, 0))) {
          warn("warn", sheet.stops.length - 1, 0, `Couldn't reach the last stop on ${sheet.stops.at(-1)?.description ?? "the sheet"}.`);
        }
      }
    }

    legs.push({
      stopIndex,
      maneuverIndex,
      kind: maneuver.kind as ManeuverKind,
      street: maneuver.street,
      meters: polylineMeters(coords) - before,
    });
  }

  // A tap that never landed on the street being driven still has to move the track.
  const inserted = await pullVias(coords, vias, router, (level, message) => warn(level, -1, -1, message));
  // Via detours are spliced into the track; keep recorded indices on the same points.
  for (const { at, count } of inserted) {
    for (const anchor of anchors) if (anchor.at >= at) anchor.at += count;
    for (const mark of turnMarks) if (mark.trackIndex >= at) mark.trackIndex += count;
  }
  const viaStreets = (overrides.vias ?? []).map((v) => nearestStreetName(graph, [v.lon, v.lat]));

  // These graph edges are deliberate straight-line guesses across missing tile geometry.
  // Require a visible warning whenever the actual route uses one.
  const syntheticSeen = new Set<string>();
  const mapped = mappedRoadIndex(graph);
  for (const edge of graph.edges) {
    if (!edge.synthetic || edge.coords.length < 2) continue;
    // A bridge laid over road the map already has (tile pieces that overlap)
    // is not an assumed connection: the bus drives mapped road there.
    if (overliesMappedRoad(edge.coords, mapped)) continue;
    const a = edge.coords[0];
    const b = edge.coords.at(-1)!;
    const mid: LonLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!trackUsesLine(coords, edge.coords)) continue;
    const key = `${mid[0].toFixed(4)},${mid[1].toFixed(4)}`;
    if (syntheticSeen.has(key)) continue;
    syntheticSeen.add(key);
    const meters = Math.round(polylineMeters(edge.coords));
    const road = edge.name && edge.name !== "gap" ? ` on ${edge.name}` : "";
    warn(
      "warn",
      -1,
      -1,
      `The map has an incomplete connection${road}; the route uses an assumed ${meters} m straight join. Check this point on the map.`,
      mid,
    );
  }

  const directionUnknown = graph.edges.filter((edge) =>
    edge.onewayKnown === false && !edge.synthetic && trackUsesLine(coords, edge.coords),
  );
  if (directionUnknown.length) {
    const roads = [...new Set(directionUnknown.map((edge) => edge.name).filter(Boolean))];
    const visible = roads.slice(0, 3).join(", ");
    const extra = roads.length > 3 ? `, and ${roads.length - 3} more` : "";
    const edge = directionUnknown[0];
    const a = edge.coords[0];
    const b = edge.coords.at(-1)!;
    const location: LonLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    warn(
      // A general caution about the map, not a problem on this route to fix.
      "info",
      -1,
      -1,
      `One-way direction data could not be confidently matched for ${visible || "one or more named roads"}${extra}. Check road signs along this route.`,
      location,
    );
  }

  // Place stops along the finished track.
  const placement = placeStops(sheet, coords, anchors, turnMarks, graph, available, places);
  warnings.push(...placement.warnings);
  const meters = polylineMeters(coords);
  const gpx = buildGpx(sheet, coords, placement.stops, turnMarks);
  return {
    ok: true,
    coords,
    meters,
    miles: meters / 1609.344,
    stops: placement.stops,
    turnMarks,
    warnings,
    turnarounds,
    legs,
    gpx,
    viaStreets,
  };
}

/** The named road closest to a tap, so a waypoint can say which street it is on. */
function nearestStreetName(graph: Graph, point: LonLat, maxM = 400): string {
  let best: { name: string; d: number } | null = null;
  for (const edge of graph.edges) {
    const name = edge.name.trim();
    if (!name || edge.keys.every((k) => k.startsWith("xlink:"))) continue;
    for (let i = 1; i < edge.coords.length; i++) {
      const proj = projectPoint(point, edge.coords[i - 1], edge.coords[i]);
      if (proj.d <= maxM && (!best || proj.d < best.d)) best = { name, d: proj.d };
    }
  }
  return best?.name ?? "";
}

/** How close a tap already is to the track before we bend the line out to it. */
const VIA_ON_TRACK_M = 45;

/**
 * Points the driver added on the map. If the printed streets already pass
 * there, leave the line. Otherwise bend the track out to that point and back,
 * along roads when a router is available.
 */
async function pullVias(
  coords: LonLat[],
  vias: { lat: number; lon: number; used: boolean }[],
  router: Router | undefined,
  note: (level: Warning["level"], message: string) => void,
): Promise<{ at: number; count: number }[]> {
  const inserted: { at: number; count: number }[] = [];
  for (const via of vias) {
    const point: LonLat = [via.lon, via.lat];
    if (coords.length < 2) continue;
    if (minDistToLine(point, coords).d <= VIA_ON_TRACK_M) {
      via.used = true;
      continue;
    }
    const near = minDistToLine(point, coords).point;
    let path: LonLat[] | null = null;
    if (router) {
      try {
        const driven = await router([near, point, near]);
        const nearAgain = driven?.at(-1);
        const reasonableLength = driven && polylineMeters(driven) <= 5 * haversine(near, point) + 800;
        const reachesTap = driven && minDistToLine(point, driven).d <= 75;
        if (driven && driven.length >= 2 && nearAgain && haversine(driven[0], near) <= 80 && haversine(nearAgain, near) <= 80 && reasonableLength && reachesTap) {
          path = driven;
        }
      } catch {
        path = null;
      }
    }
    if (path) {
      inserted.push(insertOutAndBack(coords, point, path));
      note("info", "The track now passes along mapped roads through the point you added.");
    } else {
      inserted.push(insertOutAndBack(coords, point, [point]));
      note("warn", "Couldn't find a drivable connection to the point you added. The track uses straight lines to and from it. Check this section before exporting.");
    }
    via.used = true;
  }
  return inserted;
}

function insertOutAndBack(coords: LonLat[], point: LonLat, path: LonLat[]): { at: number; count: number } {
  let bestI = 1;
  let bestD = Infinity;
  let bestPoint: LonLat = coords[0];
  for (let i = 1; i < coords.length; i++) {
    const proj = projectPoint(point, coords[i - 1], coords[i]);
    if (proj.d < bestD) {
      bestD = proj.d;
      bestI = i;
      bestPoint = proj.point;
    }
  }
  const mid = path.length > 2 ? path.slice(1, -1) : path;
  const chunk = [bestPoint, ...mid, bestPoint].filter((p, i, arr) => i === 0 || haversine(arr[i - 1], p) > 0.6);
  coords.splice(bestI, 0, ...chunk);
  return { at: bestI, count: chunk.length };
}

/** Index of the track point nearest [point], searching forward from [from]. */
function nearestIndexFrom(coords: LonLat[], point: LonLat, from: number): number {
  let best = Math.max(0, coords.length - 1);
  let bestD = Infinity;
  for (let i = Math.max(0, from); i < coords.length; i++) {
    const d = haversine(coords[i], point);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function placeStops(
  sheet: Sheet,
  track: LonLat[],
  anchors: { key: string; coord: LonLat; at: number }[],
  turnMarks: TurnMark[],
  graph: Graph,
  available: Set<string>,
  places: RawPlace[],
): { stops: RouteSuccess["stops"]; warnings: Warning[] } {
  const out: RouteSuccess["stops"] = [];
  const warnings: Warning[] = [];
  let minAt = 0;
  // A stop's directions are driven after it, so it sits after the earlier stops'
  // turns and before its own. Stops the map can't pin go in that stretch.
  const windowFor = (index: number) => {
    let from = minAt;
    let to = track.length - 1;
    for (const mark of turnMarks) {
      if (mark.stopIndex < index) from = Math.max(from, mark.trackIndex);
      else if (mark.trackIndex >= minAt) to = Math.min(to, mark.trackIndex);
    }
    return { from: Math.min(from, to), to };
  };
  sheet.stops.forEach((stop, index) => {
    const loc = classifyLocation(stop.description);
    let coord: LonLat = track[Math.min(minAt, track.length - 1)] ?? track[0];
    let at = minAt;
    let placed = index === 0;

    if (index === 0) {
      coord = track[0];
      at = 0;
    } else if (loc.kind === "school") {
      const p = matchPlace(loc.name, places);
      const key = p ? placeRouteKey(p) : "";
      const anchor = anchors.find((a) => a.key === key && a.at >= Math.max(0, minAt - 2));
      if (anchor) {
        at = Math.max(minAt, Math.min(anchor.at, track.length - 1));
        coord = track[at] ?? anchor.coord;
        placed = true;
      } else if (p) {
        const hit = nearestIndex(track, [p.lon, p.lat], minAt);
        if (hit.d <= 350) {
          at = hit.index;
          coord = track[at];
          placed = true;
        } else {
          warnings.push({ level: "warn", stopIndex: index, maneuverIndex: -1, message: `Couldn't place the SCHOOL stop “${stop.description}” near its mapped location on the route. Check this stop marker.` });
        }
      } else {
        warnings.push({ level: "warn", stopIndex: index, maneuverIndex: -1, message: `Couldn't match the SCHOOL stop “${stop.description}” to a place on the map. Check this stop marker.` });
      }
    } else if (loc.kind === "end") {
      const key = resolveTarget(loc.street, available, places).key;
      const anchor = [...anchors].reverse().find((a) => a.key === key && a.at >= Math.max(0, minAt - 2));
      if (anchor) {
        at = Math.max(minAt, Math.min(anchor.at, track.length - 1));
        coord = track[at] ?? anchor.coord;
        placed = true;
      } else {
        warnings.push({ level: "warn", stopIndex: index, maneuverIndex: -1, message: `Couldn't confirm the end-of-street location for stop “${stop.description}” on the route. Check this stop marker.` });
      }
    } else if (loc.kind === "intersection") {
      const [ka, kb] = intersectionKeys(graph, loc.a, loc.b, available, places);
      const nodes = intersectionNodes(graph, ka, kb);
      let best: { at: number; coord: LonLat } | null = null;
      for (const n of nodes) {
        const hit = nearestIndex(track, n.coord, minAt);
        if (hit.d <= 60 && (!best || hit.index < best.at)) best = { at: hit.index, coord: track[hit.index] };
      }
      if (!best) {
        // The route passes near the corner without reaching it: take the closest point in this stop's stretch.
        const { from, to } = windowFor(index);
        let near = { index: from, d: Infinity };
        for (const n of nodes) {
          const hit = nearestIndex(track.slice(0, to + 1), n.coord, from);
          if (hit.d < near.d) near = hit;
        }
        if (near.d <= 250) {
          at = near.index;
          coord = track[at];
          placed = true;
        }
      }
      if (best) {
        coord = best.coord;
        at = best.at;
        placed = true;
      } else {
        warnings.push({ level: "warn", stopIndex: index, maneuverIndex: -1, message: `The route doesn't reach the mapped intersection for stop “${stop.description}”. Its marker is approximate; check it on the map.` });
      }
    } else if (index > 0) {
      warnings.push({ level: "warn", stopIndex: index, maneuverIndex: -1, message: `Stop “${stop.description}” gives only a street name, so its exact position along the street is unknown. Check this stop marker.` });
    }
    if (!placed) {
      at = windowFor(index).from;
      coord = track[at] ?? coord;
    }

    out.push({
      index,
      time: stop.time,
      description: stop.description,
      stopId: stop.stopId,
      stopLoad: stop.stopLoad,
      runLoad: stop.runLoad,
      lat: coord[1],
      lon: coord[0],
      trackIndex: at,
    });
    minAt = Math.max(minAt, at);
  });
  return { stops: out, warnings };
}

function scoreRoute(r: RouteSuccess): number {
  const hard = r.warnings.filter((w) => w.level === "warn").length;
  const traveled = r.legs.filter((l) => l.meters > 15).length;
  return hard * 1e9 - traveled * 1e6 + r.meters;
}

export async function routeSheet(
  sheet: Sheet,
  data: { lines: RawLine[]; places: RawPlace[] },
  overrides: RouteOverrides = {},
  router?: Router,
): Promise<RouteResult> {
  if (!sheet.stops.length) {
    return { ok: false, error: "No stops were found on the sheet.", warnings: [] } satisfies RouteFailure;
  }
  const named = data.lines.filter((l) => l.kind === "named");
  const services = data.lines.filter((l) => l.kind === "service");
  const graphLines = prepareLines(sheet, named, services, data.places);
  const linkKeys = new Set<string>();
  for (const stop of sheet.stops) {
    const loc = classifyLocation(stop.description);
    if (loc.kind === "intersection") {
      linkKeys.add(canonicalKey(loc.a));
      linkKeys.add(canonicalKey(loc.b));
    } else if (loc.kind === "end" || loc.kind === "street") linkKeys.add(canonicalKey(loc.street));
    for (const m of stop.maneuvers) {
      if (!looksLikePlace(m.street)) linkKeys.add(canonicalKey(m.street));
    }
  }
  const lineKeys = new Set(graphLines.flatMap((l) => l.keys));
  const pairs = meetingPairs(sheet, lineKeys, data.places);
  graphLines.push(...gapLinks(pairs, graphLines));
  const graph = buildGraph(graphLines, linkKeys, new Set(pairs.map((p) => [...p].sort().join("|"))));
  const available = keysInGraph(graph);
  // Where the track starts: the first stop, or, when the map can't place it,
  // the next stop that it can (the start is then flagged for the driver to check).
  const startsFor = (k: number): GraphNode[] => {
    const stop = sheet.stops[k];
    const loc = classifyLocation(stop.description);
    if (loc.kind === "intersection") {
      const [ka, kb] = intersectionKeys(graph, loc.a, loc.b, available, data.places);
      return intersectionNodes(graph, ka, kb);
    }
    const street =
      loc.kind === "end" || loc.kind === "street"
        ? loc.street
        : loc.kind === "school"
          ? loc.name
          : // A Deadhead with no directions of its own starts where the next stop's directions do.
            stop.maneuvers[0]?.street ?? sheet.stops[k + 1]?.maneuvers[0]?.street ?? "";
    const key = street ? resolveTarget(street, available, data.places).key : "";
    const out: GraphNode[] = [];
    if (!key) return out;
    for (const n of graph.nodes.values()) {
      if (nodeHas(n, key)) out.push(n);
      if (out.length > 12) break;
    }
    return out;
  };
  let starts: GraphNode[] = [];
  let startAt = 0;
  for (let k = 0; k < Math.min(sheet.stops.length, 4) && !starts.length; k++) {
    starts = startsFor(k);
    startAt = k;
  }
  if (!starts.length) {
    // Last resort: anywhere on the first street the sheet drives.
    const firstStreet = flattenManeuvers(sheet)[0]?.maneuver.street;
    const key = firstStreet ? resolveTarget(firstStreet, available, data.places).key : "";
    for (const n of graph.nodes.values()) {
      if (key && nodeHas(n, key)) starts.push(n);
      if (starts.length > 12) break;
    }
    startAt = -1;
  }
  if (!starts.length) {
    const loc = classifyLocation(sheet.stops[0].description);
    return {
      ok: false,
      error:
        loc.kind === "intersection"
          ? `Couldn't find the intersection of ${loc.a} and ${loc.b} in this map area. Check the spelling, or widen the area.`
          : "Couldn't find the first stop on the map. Check its street names.",
      warnings: [],
    };
  }

  // Intersections of two long roads can repeat. Try a handful and keep the cleanest trace.
  if (starts.length > 6) starts = starts.slice(0, 6);
  let best: RouteSuccess | null = null;
  let bestStart: GraphNode | null = null;
  for (const s of starts) {
    // Let the page repaint between tries, so the phone doesn't look frozen.
    await new Promise((r) => setTimeout(r, 0));
    const r = await routeFrom(graph, sheet, s, available, data.places, overrides);
    if (!best || scoreRoute(r) < scoreRoute(best)) {
      best = r;
      bestStart = s;
    }
  }
  // Where the tiles left gaps, drive them again with the road router.
  if (router && best && bestStart && best.warnings.some((w) => w.message.startsWith(JUMP_NOTE))) {
    best = await routeFrom(graph, sheet, bestStart, available, data.places, overrides, router);
  }
  if (!best || best.coords.length < 2) {
    // Name the streets the map didn't have: they are almost always the reason.
    const missing = [...new Set((best?.warnings ?? []).flatMap((w) => w.message.match(/^Couldn't find “(.+)” in the map/)?.[1] ?? []))];
    const error = missing.length
      ? `Couldn't find ${missing.map((m) => `“${m}”`).join(", ")} on the map for this area, so the streets don't connect. Check the spelling (streets marked with a red ?), or the Area.`
      : "The streets on the sheet did not connect into a route. Check the directions marked with a red ?, or the Area.";
    return { ok: false, error, warnings: best?.warnings ?? [] };
  }
  if (startAt !== 0) {
    best.warnings.unshift({
      level: "warn",
      stopIndex: 0,
      maneuverIndex: -1,
      message: `Couldn't place the first stop (${sheet.stops[0].description}) on the map, so the track starts at ${
        startAt > 0 ? `stop ${startAt + 1}` : "the first street on the sheet"
      }. Check the start.`,
    });
  }
  best.warnings.push(...loadWarnings(sheet));
  return best;
}

/**
 * Run Ld is the running total of Stop Load: it rises by each pickup (or falls
 * by each drop-off) and is 0 at a school. A total that doesn't follow means a
 * stop is missing between the two, or a number was misread. A note only: OCR
 * misreads digits often enough that this can't block an export.
 */
export function loadWarnings(sheet: Sheet): Warning[] {
  const out: Warning[] = [];
  for (let k = 1; k < sheet.stops.length; k++) {
    const prev = sheet.stops[k - 1].runLoad;
    const { stopLoad, runLoad, description } = sheet.stops[k];
    if (prev == null || stopLoad == null || runLoad == null) continue;
    const follows = runLoad === prev + stopLoad || runLoad === prev - stopLoad || (runLoad === 0 && stopLoad === 0);
    if (follows) continue;
    out.push({
      level: "info",
      stopIndex: k,
      maneuverIndex: -1,
      message: `Load numbers don't add up at stop ${k + 1} (${description}): run load ${prev} → ${runLoad} with stop load ${stopLoad}. A stop may be missing before it, or a number was misread. Check against the sheet.`,
    });
  }
  return out;
}
