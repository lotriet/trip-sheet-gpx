import type { LonLat } from "./types";

const R = 6371000;

export function haversine(a: LonLat, b: LonLat): number {
  const φ1 = (a[1] * Math.PI) / 180;
  const φ2 = (b[1] * Math.PI) / 180;
  const dφ = ((b[1] - a[1]) * Math.PI) / 180;
  const dλ = ((b[0] - a[0]) * Math.PI) / 180;
  const s =
    Math.sin(dφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Degrees clockwise from north, 0..360. */
export function bearing(a: LonLat, b: LonLat): number {
  const y =
    Math.sin(((b[0] - a[0]) * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180);
  const x =
    Math.cos((a[1] * Math.PI) / 180) * Math.sin((b[1] * Math.PI) / 180) -
    Math.sin((a[1] * Math.PI) / 180) *
      Math.cos((b[1] * Math.PI) / 180) *
      Math.cos(((b[0] - a[0]) * Math.PI) / 180);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Signed turn, -180..180. Positive is right. */
export function turnAngle(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

export function polylineMeters(coords: LonLat[]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversine(coords[i - 1], coords[i]);
  return m;
}

export function appendLine(into: LonLat[], add: LonLat[], minMeters = 0.4) {
  for (const p of add) {
    if (!into.length || haversine(into[into.length - 1], p) > minMeters) into.push([p[0], p[1]]);
  }
}

export function projectPoint(
  p: LonLat,
  a: LonLat,
  b: LonLat,
): { d: number; t: number; point: LonLat } {
  const lat = (p[1] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat);
  const ky = 110540;
  const px = p[0] * kx;
  const py = p[1] * ky;
  const ax = a[0] * kx;
  const ay = a[1] * ky;
  const bx = b[0] * kx;
  const by = b[1] * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 < 1e-9 ? 0 : ((px - ax) * dx + (py - ay) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return { d: Math.hypot(px - qx, py - qy), t, point: [qx / kx, qy / ky] };
}

/**
 * Closest approach of segment AB to segment CD.
 * `t` and `u` are 0..1 along AB and CD. Distance is meters.
 */
export function segmentApproach(
  a: LonLat,
  b: LonLat,
  c: LonLat,
  d: LonLat,
): { distance: number; p: LonLat; q: LonLat; t: number; u: number } {
  const lat0 = (((a[1] + c[1]) / 2) * Math.PI) / 180;
  const mx = 111320 * Math.cos(lat0);
  const my = 110540;
  const A: [number, number] = [0, 0];
  const B: [number, number] = [(b[0] - a[0]) * mx, (b[1] - a[1]) * my];
  const C: [number, number] = [(c[0] - a[0]) * mx, (c[1] - a[1]) * my];
  const D: [number, number] = [(d[0] - a[0]) * mx, (d[1] - a[1]) * my];
  const ux = B[0] - A[0];
  const uy = B[1] - A[1];
  const vx = D[0] - C[0];
  const vy = D[1] - C[1];
  const wx = A[0] - C[0];
  const wy = A[1] - C[1];
  const aa = ux * ux + uy * uy;
  const bb = ux * vx + uy * vy;
  const cc = vx * vx + vy * vy;
  const dd = ux * wx + uy * wy;
  const ee = vx * wx + vy * wy;
  const denom = aa * cc - bb * bb;
  let sN: number;
  let sD = denom;
  let tN: number;
  let tD = denom;
  const eps = 1e-8;
  if (denom < eps) {
    sN = 0;
    sD = 1;
    tN = ee;
    tD = cc;
  } else {
    sN = bb * ee - cc * dd;
    tN = aa * ee - bb * dd;
    if (sN < 0) {
      sN = 0;
      tN = ee;
      tD = cc;
    } else if (sN > sD) {
      sN = sD;
      tN = ee + bb;
      tD = cc;
    }
  }
  if (tN < 0) {
    tN = 0;
    if (-dd < 0) sN = 0;
    else if (-dd > aa) sN = sD;
    else {
      sN = -dd;
      sD = aa;
    }
  } else if (tN > tD) {
    tN = tD;
    if (-dd + bb < 0) sN = 0;
    else if (-dd + bb > aa) sN = sD;
    else {
      sN = -dd + bb;
      sD = aa;
    }
  }
  const sc = Math.abs(sN) < eps || Math.abs(sD) < eps ? 0 : sN / sD;
  const tc = Math.abs(tN) < eps || Math.abs(tD) < eps ? 0 : tN / tD;
  const px = A[0] + ux * sc;
  const py = A[1] + uy * sc;
  const qx = C[0] + vx * tc;
  const qy = C[1] + vy * tc;
  const p: LonLat = [a[0] + (b[0] - a[0]) * sc, a[1] + (b[1] - a[1]) * sc];
  const q: LonLat = [c[0] + (d[0] - c[0]) * tc, c[1] + (d[1] - c[1]) * tc];
  return { distance: Math.hypot(px - qx, py - qy), p, q, t: sc, u: tc };
}

export function minDistToLine(p: LonLat, coords: LonLat[]): { d: number; point: LonLat } {
  let best = { d: Infinity, point: coords[0] ?? p };
  for (let i = 1; i < coords.length; i++) {
    const proj = projectPoint(p, coords[i - 1], coords[i]);
    if (proj.d < best.d) best = { d: proj.d, point: proj.point };
  }
  return best;
}

export function minDistToTrack(p: LonLat, track: LonLat[]): number {
  return minDistToLine(p, track).d;
}

/** Heading along coords, looking `meters` ahead of the start (or the whole edge). */
export function departureHeading(coords: LonLat[], meters = 18): number {
  if (coords.length < 2) return 0;
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += haversine(coords[i - 1], coords[i]);
    if (acc >= meters || i === coords.length - 1) return bearing(coords[0], coords[i]);
  }
  return bearing(coords[0], coords[coords.length - 1]);
}

export function arrivalHeading(coords: LonLat[], meters = 18): number {
  if (coords.length < 2) return 0;
  let acc = 0;
  for (let i = coords.length - 1; i > 0; i--) {
    acc += haversine(coords[i], coords[i - 1]);
    if (acc >= meters || i === 1) return bearing(coords[i - 1], coords[coords.length - 1]);
  }
  return bearing(coords[0], coords[coords.length - 1]);
}

export function nearestIndex(track: LonLat[], p: LonLat, from = 0): { index: number; d: number } {
  let best = { index: from, d: Infinity };
  for (let i = from; i < track.length; i++) {
    const d = haversine(track[i], p);
    if (d < best.d) best = { index: i, d };
  }
  return best;
}

export function compareTracks(reference: LonLat[], generated: LonLat[]) {
  const refToGen = reference.map((p) => minDistToTrack(p, generated)).sort((a, b) => a - b);
  const genToRef = generated.map((p) => minDistToTrack(p, reference)).sort((a, b) => a - b);
  const pick = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)))] ?? 0;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    refMedian: pick(refToGen, 0.5),
    refP95: pick(refToGen, 0.95),
    refMax: refToGen[refToGen.length - 1] ?? 0,
    genMedian: pick(genToRef, 0.5),
    genP95: pick(genToRef, 0.95),
    genMax: genToRef[genToRef.length - 1] ?? 0,
    refMean: mean(refToGen),
  };
}
