import { haversine, polylineMeters, appendLine } from "./geo";
import { buildGraph, type Graph, type GraphEdge } from "./graph";
import type { LonLat, RawLine } from "./types";

class MinHeap {
  private a: { k: number; v: string }[] = [];
  get size() {
    return this.a.length;
  }
  push(k: number, v: string) {
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
  pop(): { k: number; v: string } | undefined {
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

function nearest(graph: Graph, point: LonLat, maxM: number): string | null {
  let best: { id: string; d: number } | null = null;
  for (const n of graph.nodes.values()) {
    const d = haversine(n.coord, point);
    if (d <= maxM && (!best || d < best.d)) best = { id: n.id, d };
  }
  return best?.id ?? null;
}

/**
 * Shortest drive on the mapped streets between two points.
 * Used only for the deadhead between runs, where the trip sheet does not name the streets.
 */
export function driveBetween(
  lines: RawLine[],
  from: LonLat,
  to: LonLat,
): { coords: LonLat[]; meters: number } | null {
  const graph = buildGraph(
    lines
      .filter((l) => l.kind === "named" && l.keys.length && l.coords.length >= 2)
      .map((l) => ({ name: l.name, keys: l.keys, coords: l.coords, oneway: l.oneway, onewayKnown: l.onewayKnown })),
  );
  const start = nearest(graph, from, 180);
  const goal = nearest(graph, to, 180);
  if (!start || !goal) return null;
  if (start === goal) {
    const c = graph.nodes.get(start)!.coord;
    return { coords: [from, c, to], meters: haversine(from, to) };
  }

  const best = new Map<string, number>([[start, 0]]);
  const prev = new Map<string, GraphEdge>();
  const heap = new MinHeap();
  heap.push(0, start);
  let pops = 0;
  while (heap.size && pops < 40000) {
    const item = heap.pop();
    if (!item) break;
    pops++;
    if (item.k !== best.get(item.v)) continue;
    if (item.v === goal) break;
    if (item.k > 25000) break;
    const node = graph.nodes.get(item.v);
    if (!node) continue;
    for (const e of node.out) {
      if (e.keys.some((k) => k.startsWith("xlink:"))) continue;
      const nd = item.k + e.length;
      if (nd + 0.2 < (best.get(e.to) ?? Infinity)) {
        best.set(e.to, nd);
        prev.set(e.to, e);
        heap.push(nd, e.to);
      }
    }
  }
  if (!prev.has(goal) && start !== goal) return null;

  const edges: GraphEdge[] = [];
  let cur = goal;
  const guard = new Set<string>();
  while (cur !== start && !guard.has(cur)) {
    guard.add(cur);
    const e = prev.get(cur);
    if (!e) return null;
    edges.push(e);
    cur = e.from;
  }
  edges.reverse();
  const coords: LonLat[] = [[from[0], from[1]]];
  for (const e of edges) appendLine(coords, e.coords, 0.4);
  appendLine(coords, [to], 0.4);
  return { coords, meters: polylineMeters(coords) };
}
