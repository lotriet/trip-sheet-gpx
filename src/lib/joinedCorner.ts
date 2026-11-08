import { canonicalKey } from "./engine/names";
import type { Sheet } from "./engine/types";

/**
 * A direction names one street. One that names a corner ("GRAND LIBERTY BLVD
 * AND LEGENDARY LN") is a stop line the reader joined onto the direction above
 * it: the direction is the first street, the corner is a stop's location.
 */
export function cornerInDirection(street: string): { street: string; corner: string } | null {
  const m = street.trim().match(/^(.+?)\s+(?:&|AND|@)\s+(.+)$/i);
  if (!m) return null;
  const a = m[1].trim().replace(/[,;]+$/, "");
  const b = m[2].trim();
  // Two words a side ("OAK ST"), so a name like "ROCK AND ROLL" isn't split.
  if (a.split(/\s+/).length < 2 || b.split(/\s+/).length < 2) return null;
  return { street: a, corner: `${a} & ${b}` };
}

const sameCorner = (x: string, y: string) => {
  const key = (s: string) => s.split(/\s+(?:&|AND|@)\s+/i).map((part) => canonicalKey(part)).sort().join("&");
  return !!x.trim() && key(x) === key(y);
};

export type CornerFix = { sheet: Sheet; says: string };

/** What tapping "Fix it" does to direction [mi] of stop [si], and the sentence that says so. */
export function fixJoinedCorner(sheet: Sheet, si: number, mi: number): CornerFix | null {
  const stop = sheet.stops[si];
  const found = stop && cornerInDirection(stop.maneuvers[mi]?.street ?? "");
  if (!found) return null;
  const stops = sheet.stops.map((s) => ({ ...s, maneuvers: [...s.maneuvers] }));
  const here = stops[si];
  here.maneuvers[mi] = { ...here.maneuvers[mi], street: found.street };
  const next = stops[si + 1];
  const direction = `The direction becomes ${found.street}`;
  const holder = stops.findIndex((s) => sameCorner(s.description, found.corner));
  if (holder >= 0) {
    return { sheet: { ...sheet, stops }, says: `${direction}. Stop ${holder + 1} already has ${found.corner}.` };
  }
  if (next && !next.description.trim()) {
    next.description = found.corner;
    return { sheet: { ...sheet, stops }, says: `${direction}, and ${found.corner} goes on stop ${si + 2}.` };
  }
  // Directions printed after the joined line lead away from that stop.
  const after = here.maneuvers.splice(mi + 1);
  stops.splice(si + 1, 0, { time: "", description: found.corner, stopLoad: null, runLoad: null, stopId: null, maneuvers: after });
  return {
    sheet: { ...sheet, stops },
    says: `${direction}, and ${found.corner} becomes a new stop ${si + 2}. Add its time from the sheet.`,
  };
}
