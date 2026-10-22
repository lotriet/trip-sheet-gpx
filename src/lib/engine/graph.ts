import { arrivalHeading, bearing, haversine, polylineMeters, projectPoint, segmentApproach, turnAngle } from "./geo";
import type { LonLat } from "./types";

const SNAP_M = 4;

export type GraphLine = {
  name: string;
  keys: string[];
  coords: LonLat[];
  oneway: number;
};

export type GraphEdge = {
  id: number;
  from: string;
  to: string;
  keys: string[];
  name: string;
  coords: LonLat[];
  length: number;
};

export type GraphNode = {
  id: string;
  coord: LonLat;
  out: GraphEdge[];
};

export type Graph = {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  /** Straight joins added where a named street had a gap in the map tiles. */
  bridges: number;
  /** Short joins added where two different streets pass within a few meters but do not share a node. */
  links: number;
};

function coordKey(c: LonLat): string {
  return `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
}

const CELL = 0.00008;

function cellId(c: LonLat): string {
  return `${Math.floor(c[0] / CELL)},${Math.floor(c[1] / CELL)}`;
}

function nearbyKeys(c: LonLat): string[] {
  const cx = Math.floor(c[0] / CELL);
  const cy = Math.floor(c[1] / CELL);
  const out: string[] = [];
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) out.push(`${cx + dx},${cy + dy}`);
  return out;
}

function dedupeConsecutive(coords: LonLat[]): LonLat[] {
  const out: LonLat[] = [];
  for (const c of coords) {
    if (!out.length || haversine(out[out.length - 1], c) > 0.6) out.push([c[0], c[1]]);
  }
  return out;
}

export function edgeHas(edge: GraphEdge, key: string): boolean {
  return edge.keys.includes(key);
}

/** A real edge of this street, or a short join from another street onto it. */
export function edgeServes(edge: GraphEdge, key: string): boolean {
  return edge.keys.includes(key) || edge.keys.includes(`xlink:${key}`);
}

export function nodeHas(node: GraphNode, key: string): boolean {
  return node.out.some((e) => edgeServes(e, key));
}

export function buildGraph(input: GraphLine[], linkKeys?: Set<string>): Graph {
  const pls = input
    .filter((l) => l.coords.length >= 2 && l.keys.length)
    .map((l) => ({
      name: l.name,
      keys: [...new Set(l.keys)],
      oneway: l.oneway,
      coords: dedupeConsecutive(l.coords.map((c) => [c[0], c[1]] as LonLat)),
    }))
    .filter((l) => l.coords.length >= 2);

  const segGrid = new Map<string, { pi: number; si: number }[]>();
  const addSeg = (pi: number, si: number) => {
    const a = pls[pi].coords[si];
    const b = pls[pi].coords[si + 1];
    const steps = Math.max(1, Math.ceil(haversine(a, b) / 12));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const id = cellId([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      let bucket = segGrid.get(id);
      if (!bucket) segGrid.set(id, (bucket = []));
      if (!bucket.some((item) => item.pi === pi && item.si === si)) bucket.push({ pi, si });
    }
  };
  const indexSegs = () => {
    segGrid.clear();
    for (let pi = 0; pi < pls.length; pi++) {
      for (let si = 0; si < pls[pi].coords.length - 1; si++) addSeg(pi, si);
    }
  };
  indexSegs();

  const splits: { t: number; point: LonLat }[][][] = pls.map((pl) =>
    pl.coords.slice(0, -1).map(() => []),
  );

  for (let pi = 0; pi < pls.length; pi++) {
    const coords = pls[pi].coords;
    const ends = [0, coords.length - 1];
    for (const vi of ends) {
      const end = coords[vi];
      let best: { qj: number; si: number; t: number; point: LonLat; d: number } | null = null;
      const seen = new Set<string>();
      for (const ck of nearbyKeys(end)) {
        for (const seg of segGrid.get(ck) ?? []) {
          if (seg.pi === pi) continue;
          const tag = `${seg.pi}:${seg.si}`;
          if (seen.has(tag)) continue;
          seen.add(tag);
          const a = pls[seg.pi].coords[seg.si];
          const b = pls[seg.pi].coords[seg.si + 1];
          const proj = projectPoint(end, a, b);
          if (proj.d >= SNAP_M || proj.t <= 0.02 || proj.t >= 0.98) continue;
          if (haversine(proj.point, a) < SNAP_M || haversine(proj.point, b) < SNAP_M) continue;
          if (!best || proj.d < best.d) best = { qj: seg.pi, si: seg.si, t: proj.t, point: proj.point, d: proj.d };
        }
      }
      if (best) splits[best.qj][best.si].push({ t: best.t, point: best.point });
    }
  }

  const connectors = linkKeys?.size ? linkNearMisses(pls, splits, segGrid, linkKeys) : [];

  for (let pi = 0; pi < pls.length; pi++) {
    const src = pls[pi].coords;
    const next: LonLat[] = [];
    for (let si = 0; si < src.length - 1; si++) {
      next.push(src[si]);
      const ins = splits[pi][si].slice().sort((a, b) => a.t - b.t);
      for (const s of ins) {
        if (haversine(next[next.length - 1], s.point) > 0.8) next.push(s.point);
      }
    }
    next.push(src[src.length - 1]);
    pls[pi].coords = dedupeConsecutive(next);
  }
  for (const c of connectors) {
    if (haversine(c.coords[0], c.coords[1]) < 1.2) continue;
    pls.push({ name: c.name, keys: c.keys, oneway: 0, coords: c.coords });
  }

  // Snap endpoints onto nearby vertices so T-intersections share a node.
  const vertGrid = new Map<string, { pi: number; vi: number }[]>();
  for (let pi = 0; pi < pls.length; pi++) {
    pls[pi].coords.forEach((_, vi) => {
      const id = cellId(pls[pi].coords[vi]);
      let bucket = vertGrid.get(id);
      if (!bucket) vertGrid.set(id, (bucket = []));
      bucket.push({ pi, vi });
    });
  }
  const moves = new Map<string, LonLat>();
  const vid = (pi: number, vi: number) => `${pi}:${vi}`;
  for (let pi = 0; pi < pls.length; pi++) {
    const coords = pls[pi].coords;
    for (const vi of [0, coords.length - 1]) {
      const id = vid(pi, vi);
      if (moves.has(id)) continue;
      const end = coords[vi];
      let best: { pi: number; vi: number; d: number } | null = null;
      const seen = new Set<string>();
      for (const ck of nearbyKeys(end)) {
        for (const v of vertGrid.get(ck) ?? []) {
          const tag = vid(v.pi, v.vi);
          if (seen.has(tag)) continue;
          seen.add(tag);
          if (v.pi === pi && Math.abs(v.vi - vi) <= 3) continue;
          const d = haversine(end, pls[v.pi].coords[v.vi]);
          if (d < 0.05 || d >= SNAP_M) continue;
          if (!best || d < best.d) best = { pi: v.pi, vi: v.vi, d };
        }
      }
      if (!best) continue;
      const bId = vid(best.pi, best.vi);
      const bCoord = moves.get(bId) ?? pls[best.pi].coords[best.vi];
      const bIsEnd = best.vi === 0 || best.vi === pls[best.pi].coords.length - 1;
      if (!bIsEnd || moves.has(bId)) {
        moves.set(id, [bCoord[0], bCoord[1]]);
      } else {
        const mid: LonLat = [(end[0] + bCoord[0]) / 2, (end[1] + bCoord[1]) / 2];
        moves.set(id, mid);
        moves.set(bId, mid);
      }
    }
  }
  for (const [id, coord] of moves) {
    const [ps, vs] = id.split(":");
    pls[Number(ps)].coords[Number(vs)] = coord;
  }

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  let nextId = 1;

  const ensure = (id: string, coord: LonLat) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { id, coord, out: [] }));
    return n;
  };

  const addDirected = (from: string, to: string, coords: LonLat[], line: (typeof pls)[number]) => {
    if (from === to) return;
    const sig = `${from}>${to}|${line.keys.join(",")}`;
    if (seenEdge.has(sig)) return;
    const length = polylineMeters(coords);
    if (length < 0.4) return;
    seenEdge.add(sig);
    const edge: GraphEdge = {
      id: nextId++,
      from,
      to,
      keys: line.keys,
      name: line.name,
      coords,
      length,
    };
    edges.push(edge);
    ensure(from, coords[0]).out.push(edge);
    ensure(to, coords[coords.length - 1]);
  };

  for (const line of pls) {
    const coords = line.coords;
    let startIdx = 0;
    let prev = coordKey(coords[0]);
    ensure(prev, coords[0]);
    for (let i = 1; i < coords.length; i++) {
      const k = coordKey(coords[i]);
      if (k === prev) continue;
      const slice = coords.slice(startIdx, i + 1).map((c) => [c[0], c[1]] as LonLat);
      if (line.oneway !== -1) addDirected(prev, k, slice, line);
      if (line.oneway !== 1) addDirected(k, prev, slice.slice().reverse(), line);
      prev = k;
      startIdx = i;
    }
  }

  const bridges = bridgeNamedGaps(nodes, edges, () => nextId++);
  return { nodes, edges, bridges, links: connectors.length };
}

const CROSS_M = 18;

/**
 * Divided roads in these tiles often leave the side street touching only one
 * carriageway, with the other 10–18 m away across the median. Join that gap
 * when the two streets actually cross (not when they run side by side).
 * The link is tagged with the shorter street so a trace along the main road
 * does not wander across it.
 */
function linkNearMisses(
  pls: { name: string; keys: string[]; coords: LonLat[] }[],
  splits: { t: number; point: LonLat }[][][],
  segGrid: Map<string, { pi: number; si: number }[]>,
  linkKeys: Set<string>,
): { name: string; keys: string[]; coords: LonLat[] }[] {
  const listed = (keys: string[]) => keys.some((k) => linkKeys.has(k));
  const best = new Map<string, { d: number; pi: number; si: number; t: number; p: LonLat; qj: number; sj: number; u: number; q: LonLat }>();

  for (let pi = 0; pi < pls.length; pi++) {
    if (!listed(pls[pi].keys)) continue;
    const coords = pls[pi].coords;
    for (let si = 0; si < coords.length - 1; si++) {
      const a = coords[si];
      const b = coords[si + 1];
      const steps = Math.max(1, Math.ceil(haversine(a, b) / 12));
      const seen = new Set<string>();
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const sample: LonLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        for (const ck of nearbyKeys(sample)) {
          for (const seg of segGrid.get(ck) ?? []) {
            if (seg.pi <= pi) continue;
            const tag = `${seg.pi}:${seg.si}`;
            if (seen.has(tag)) continue;
            seen.add(tag);
            const other = pls[seg.pi];
            if (!listed(other.keys)) continue;
            if (other.keys.some((k) => pls[pi].keys.includes(k))) continue;
            const c = other.coords[seg.si];
            const d = other.coords[seg.si + 1];
            const ang = Math.abs(turnAngle(bearing(a, b), bearing(c, d)));
            if (ang < 35 || ang > 145) continue;
            const hit = segmentApproach(a, b, c, d);
            if (hit.distance < 2.2 || hit.distance > CROSS_M) continue;
            const pair = `${pi}:${seg.pi}`;
            const prev = best.get(pair);
            if (!prev || hit.distance < prev.d) {
              best.set(pair, {
                d: hit.distance,
                pi,
                si,
                t: hit.t,
                p: hit.p,
                qj: seg.pi,
                sj: seg.si,
                u: hit.u,
                q: hit.q,
              });
            }
          }
        }
      }
    }
  }

  const connectors: { name: string; keys: string[]; coords: LonLat[] }[] = [];
  for (const hit of best.values()) {
    splits[hit.pi][hit.si].push({ t: hit.t, point: hit.p });
    splits[hit.qj][hit.sj].push({ t: hit.u, point: hit.q });
    const left = pls[hit.pi];
    const right = pls[hit.qj];
    const leftLen = polylineMeters(left.coords);
    const rightLen = polylineMeters(right.coords);
    const owner = leftLen <= rightLen ? left : right;
    // xlink: so a trace that is following a street does not drive across the median join.
    connectors.push({
      name: owner.name,
      keys: owner.keys.filter((k) => linkKeys.has(k)).map((k) => `xlink:${k}`),
      coords: [hit.p, hit.q],
    });
  }
  return connectors;
}


/**
 * OpenMapTiles sometimes drops a short piece of a road. Join dead-ends of the
 * same street when they face each other across a gap of a few hundred meters.
 * Lateral jumps between the two sides of a divided road fail the heading test.
 */
function bridgeNamedGaps(
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  nextId: () => number,
): number {
  const keys = new Set<string>();
  for (const e of edges) for (const k of e.keys) if (!k.startsWith("place:")) keys.add(k);
  let bridges = 0;
  const seen = new Set<string>();

  for (const key of keys) {
    const ends: { node: GraphNode; heading: number }[] = [];
    for (const n of nodes.values()) {
      const outs = n.out.filter((e) => e.keys.includes(key));
      const neighbors = new Set(outs.map((e) => e.to));
      if (neighbors.size !== 1 || !outs.length) continue;
      const back = outs[0];
      const inbound = edges.find((e) => e.to === n.id && e.from === back.to && e.keys.includes(key));
      const heading = inbound ? arrivalHeading(inbound.coords) : (arrivalHeading(back.coords) + 180) % 360;
      ends.push({ node: n, heading });
    }
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i];
        const b = ends[j];
        const d = haversine(a.node.coord, b.node.coord);
        if (d < 12 || d > 200) continue;
        const ab = bearing(a.node.coord, b.node.coord);
        const ba = bearing(b.node.coord, a.node.coord);
        if (Math.abs(turnAngle(a.heading, ab)) > 42) continue;
        if (Math.abs(turnAngle(b.heading, ba)) > 42) continue;
        const sig = [a.node.id, b.node.id].sort().join("|") + key;
        if (seen.has(sig)) continue;
        seen.add(sig);
        const name = a.node.out.find((e) => e.keys.includes(key))?.name ?? key;
        const coords: LonLat[] = [a.node.coord, b.node.coord];
        const rev: LonLat[] = [b.node.coord, a.node.coord];
        for (const [from, to, line] of [
          [a.node, b.node, coords],
          [b.node, a.node, rev],
        ] as const) {
          const edge: GraphEdge = {
            id: nextId(),
            from: from.id,
            to: to.id,
            keys: [key],
            name,
            coords: line.map((c) => [c[0], c[1]]),
            length: d,
          };
          edges.push(edge);
          from.out.push(edge);
        }
        bridges++;
      }
    }
  }
  return bridges;
}

export function keysInGraph(graph: Graph): Set<string> {
  const s = new Set<string>();
  for (const e of graph.edges) for (const k of e.keys) s.add(k);
  return s;
}
