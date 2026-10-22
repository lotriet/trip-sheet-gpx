/**
 * The public OSRM road router, for the few places where the map tiles leave a
 * gap between two streets on the sheet. Only those short legs are sent: two or
 * three points, never the sheet or the stops.
 */
import type { LonLat } from "./engine/types";
import type { Router } from "./engine/route";

const cache = new Map<string, LonLat[] | null>();

export const osrmRouter: Router = async (points) => {
  const path = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(";");
  if (cache.has(path)) return cache.get(path) ?? null;
  const url = `https://router.project-osrm.org/route/v1/driving/${path}?overview=full&geometries=geojson&continue_straight=true`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (res.ok) {
        const json = (await res.json()) as { code?: string; routes?: { geometry?: { coordinates?: LonLat[] } }[] };
        const line = json.code === "Ok" ? (json.routes?.[0]?.geometry?.coordinates ?? null) : null;
        cache.set(path, line);
        return line;
      }
    } catch {
      /* try once more, then draw a straight line */
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
};
