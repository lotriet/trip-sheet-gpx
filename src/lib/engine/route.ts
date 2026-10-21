import { buildGpx } from "./gpx";
import {
  arrivalHeading,
  appendLine,
  bearing,
  departureHeading,
  haversine,
  minDistToLine,
  nearestIndex,
  polylineMeters,
  turnAngle,
} from "./geo";
import { buildGraph, edgeHas, edgeServes, keysInGraph, nodeHas, type Graph, type GraphEdge, type GraphLine, type GraphNode } from "./graph";
import { canonicalKey, looksLikePlace, sameSchool, schoolSig } from "./names";
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

function matchPlace(raw: string, places: RawPlace[]): RawPlace | null {
  const sig = schoolSig(raw.replace(/^\s*school\s*:\s*/i, ""));
  const hits = places.filter((p) => sameSchool(sig, p));
  if (!hits.length) return null;
  // Duplicate POI pins: keep the first; they sit on the same campus.
  return hits[0];
}

function lineNear(coords: LonLat[], point: LonLat, maxM: number): boolean {
  return minDistToLine(point, coords).d <= maxM;
}

/** Named streets, plus service roads around each school the sheet turns into. */
export function prepareLines(sheet: Sheet, named: RawLine[], services: RawLine[], places: RawPlace[]): GraphLine[] {
  const lines: GraphLine[] = named
    .filter((l) => l.kind === "named" && l.keys.length && l.coords.length >= 2)
    .map((l) => ({ name: l.name, keys: l.keys, coords: l.coords, oneway: 0 }));

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
    for (const s of near) lines.push({ name: place.name, keys: [pk], coords: s.coords, oneway: 0 });

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
        if (hit && hit.d > 1.2) lines.push({ name: place.name, keys: [pk], coords: [hit.point, end], oneway: 0 });
      }
    }
  }
  return lines;
}

function resolveTarget(
  raw: string,
  available: Set<string>,
  places: RawPlace[],
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
  return { key, label: raw, how: "missing" };
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

function intersectionNodes(graph: Graph, a: string, b: string): GraphNode[] {
  const out: GraphNode[] = [];
  for (const n of graph.nodes.values()) {
    if (nodeHas(n, a) && nodeHas(n, b)) out.push(n);
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

function routeFrom(
  graph: Graph,
  sheet: Sheet,
  start: GraphNode,
  available: Set<string>,
  places: RawPlace[],
  overrides: RouteOverrides,
): RouteSuccess {
  const warnings: Warning[] = [];
  const legs: RouteLeg[] = [];
  const turnarounds: TurnaroundPin[] = [];
  const anchors: { key: string; coord: LonLat; at: number }[] = [];
  const coords: LonLat[] = [[start.coord[0], start.coord[1]]];
  let node = start;
  let heading: number | null = null;
  let currentKey: string | null = null;
  /** Intersection we just turned through. The next turn has to happen farther along the street. */
  let skipTurnAt: string | null = null;
  const flat = flattenManeuvers(sheet);
  const vias = (overrides.vias ?? []).map((v, i) => ({ ...v, i, used: false }));

  const warn = (level: Warning["level"], stopIndex: number, maneuverIndex: number, message: string) => {
    warnings.push({ level, stopIndex, maneuverIndex, message });
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

  const hopVias = (key: string) => {
    for (const via of vias) {
      if (via.used) continue;
      const hit = nearestNode(graph, key, [via.lon, via.lat], 40);
      if (!hit) continue;
      via.used = true;
      if (hit.id === node.id) continue;
      const leg = follow(graph, node, heading, key, { type: "node", id: hit.id }, 8000);
      if (!leg) continue;
      appendLine(coords, leg.coords, 0.4);
      node = leg.node;
      heading = leg.heading;
    }
  };

  for (let i = 0; i < flat.length; i++) {
    const { stopIndex, maneuverIndex, maneuver } = flat[i];
    const before = polylineMeters(coords);
    const target = resolveTarget(maneuver.street, available, places);
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
      if (currentKey && currentKey !== target.key && (sameCorner || !canTurn(node, heading, target.key, dir, graph))) {
        if (currentKey) hopVias(currentKey);
        const loose = travel(currentKey, { type: "turn", key: target.key, dir }, sameCorner ? 45 : 12);
        if (loose) {
          appendLine(coords, loose.coords, 0.4);
          node = loose.node;
          heading = loose.heading;
          if (!loose.matched) {
            warn("warn", stopIndex, maneuverIndex, `The ${dir} turn onto ${maneuver.street} did not match a clear intersection. The track uses the closest connection.`);
          }
        } else if (target.how !== "missing") {
          warn("warn", stopIndex, maneuverIndex, `Couldn't follow the sheet from ${currentKey} onto ${maneuver.street}.`);
        }
      }
      if (target.how !== "missing") {
        const turn = chooseTurn(node, heading, target.key, dir, graph);
        if (turn) {
          appendLine(coords, turn.edge.coords, 0.4);
          node = graph.nodes.get(turn.edge.to) ?? node;
          heading = arrivalHeading(turn.edge.coords);
          currentKey = target.key;
          skipTurnAt = node.id;
          if (!turn.matched) {
            warn("warn", stopIndex, maneuverIndex, `Turned onto ${maneuver.street}, but the angle was not a clear ${dir}. Check this turn.`);
          }
        } else if (!warnings.some((w) => w.stopIndex === stopIndex && w.maneuverIndex === maneuverIndex)) {
          warn("warn", stopIndex, maneuverIndex, `No connection found for the ${dir} turn onto ${maneuver.street}.`);
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
        } else {
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

  // Place stops along the finished track.
  const placed = placeStops(sheet, coords, anchors, graph, available, places);
  const meters = polylineMeters(coords);
  const gpx = buildGpx(sheet, coords, placed);
  return {
    ok: true,
    coords,
    meters,
    miles: meters / 1609.344,
    stops: placed,
    warnings,
    turnarounds,
    legs,
    gpx,
  };
}

function placeStops(
  sheet: Sheet,
  track: LonLat[],
  anchors: { key: string; coord: LonLat; at: number }[],
  graph: Graph,
  available: Set<string>,
  places: RawPlace[],
): RouteSuccess["stops"] {
  const out: RouteSuccess["stops"] = [];
  let minAt = 0;
  sheet.stops.forEach((stop, index) => {
    const loc = classifyLocation(stop.description);
    let coord: LonLat = track[Math.min(minAt, track.length - 1)] ?? track[0];
    let at = minAt;

    if (index === 0) {
      coord = track[0];
      at = 0;
    } else if (loc.kind === "school") {
      const p = matchPlace(loc.name, places);
      const key = p ? placeRouteKey(p) : "";
      const anchor = anchors.find((a) => a.key === key && a.at >= Math.max(0, minAt - 2));
      if (anchor) {
        coord = anchor.coord;
        at = anchor.at;
      }
    } else if (loc.kind === "end") {
      const key = resolveTarget(loc.street, available, places).key;
      const anchor = [...anchors].reverse().find((a) => a.key === key && a.at >= Math.max(0, minAt - 2));
      if (anchor) {
        coord = anchor.coord;
        at = anchor.at;
      }
    } else if (loc.kind === "intersection") {
      const ka = resolveTarget(loc.a, available, places).key;
      const kb = resolveTarget(loc.b, available, places).key;
      const nodes = intersectionNodes(graph, ka, kb);
      let best: { at: number; coord: LonLat; d: number } | null = null;
      for (const n of nodes) {
        const hit = nearestIndex(track, n.coord, minAt);
        if (hit.d < 45 && (!best || hit.index < best.at)) best = { at: hit.index, coord: n.coord, d: hit.d };
      }
      if (!best) {
        for (const n of nodes) {
          const hit = nearestIndex(track, n.coord, 0);
          if (!best || hit.d < best.d) best = { at: Math.max(hit.index, minAt), coord: n.coord, d: hit.d };
        }
      }
      if (best) {
        coord = best.coord;
        at = best.at;
      }
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
  return out;
}

function scoreRoute(r: RouteSuccess): number {
  const hard = r.warnings.filter((w) => w.level === "warn").length;
  const traveled = r.legs.filter((l) => l.meters > 15).length;
  return hard * 1e9 - traveled * 1e6 + r.meters;
}

export function routeSheet(
  sheet: Sheet,
  data: { lines: RawLine[]; places: RawPlace[] },
  overrides: RouteOverrides = {},
): RouteResult {
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
  const graph = buildGraph(graphLines, linkKeys);
  const available = keysInGraph(graph);
  const first = sheet.stops[0];
  const loc = classifyLocation(first.description);
  let starts: GraphNode[] = [];
  if (loc.kind === "intersection") {
    const a = resolveTarget(loc.a, available, data.places);
    const b = resolveTarget(loc.b, available, data.places);
    starts = intersectionNodes(graph, a.key, b.key);
    if (!starts.length) {
      return {
        ok: false,
        error: `Couldn't find the intersection of ${loc.a} and ${loc.b} in this map area. Check the spelling, or widen the area.`,
        warnings: [],
      };
    }
  } else {
    const street =
      loc.kind === "end" || loc.kind === "street" ? loc.street : first.maneuvers[0]?.street ?? "";
    const key = street ? resolveTarget(street, available, data.places).key : "";
    for (const n of graph.nodes.values()) {
      if (key && nodeHas(n, key)) starts.push(n);
      if (starts.length > 12) break;
    }
  }
  if (!starts.length) {
    return { ok: false, error: "Couldn't find the first stop on the map.", warnings: [] };
  }

  // Intersections of two long roads can repeat. Try a handful and keep the cleanest trace.
  if (starts.length > 6) starts = starts.slice(0, 6);
  let best: RouteSuccess | null = null;
  for (const s of starts) {
    const r = routeFrom(graph, sheet, s, available, data.places, overrides);
    if (!best || scoreRoute(r) < scoreRoute(best)) best = r;
  }
  if (!best || best.coords.length < 2) {
    return { ok: false, error: "The streets on the sheet did not connect into a route.", warnings: best?.warnings ?? [] };
  }
  return best;
}
