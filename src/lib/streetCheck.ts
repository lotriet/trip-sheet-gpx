/**
 * Check the street names in the form against the map data loaded around the
 * sheet's stops, and suggest the closest real names for a misread one
 * ("MAPLEW OOD MILL RD" -> "MAPLEWOOD MILL RD"). Pure, so it can be tested.
 */

import { canonicalKey, expandPlaceQuery, looksLikePlace } from "./engine/names";
import { classifyLocation } from "./engine/parseSheet";
import { matchPlace } from "./engine/route";
import type { RawLine, RawPlace } from "./engine/types";

export type StreetIndex = {
  keys: Set<string>;
  names: { display: string; squash: string }[];
  places: RawPlace[];
};

export type StreetStatus = "found" | "missing" | "place" | "empty";

const ABBR: Record<string, string> = {
  STREET: "ST",
  ROAD: "RD",
  AVENUE: "AVE",
  DRIVE: "DR",
  LANE: "LN",
  COURT: "CT",
  PLACE: "PL",
  BOULEVARD: "BLVD",
  PARKWAY: "PKWY",
  CIRCLE: "CIR",
  TRAIL: "TRL",
  TERRACE: "TER",
  CROSSING: "XING",
  HIGHWAY: "HWY",
};

/** "Maplewood Mill Road" -> "MAPLEWOOD MILL RD", the way the sheets print it. */
export function sheetStyle(name: string): string {
  const words = name.toUpperCase().replace(/\s+/g, " ").trim().split(" ");
  const last = words.length - 1;
  if (last > 0 && ABBR[words[last]]) words[last] = ABBR[words[last]];
  return words.join(" ");
}

function squash(raw: string): string {
  return canonicalKey(raw).replace(/\s+/g, "");
}

export function buildStreetIndex(lines: RawLine[], places: RawPlace[] = []): StreetIndex {
  const keys = new Set<string>();
  const seen = new Set<string>();
  const names: StreetIndex["names"] = [];
  for (const line of lines) {
    for (const k of line.keys) keys.add(k);
    if (!line.name) continue;
    const key = canonicalKey(line.name);
    keys.add(key);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push({ display: sheetStyle(line.name), squash: key.replace(/\s+/g, "") });
  }
  return { keys, names, places };
}

export function checkStreet(index: StreetIndex, raw: string): StreetStatus {
  if (!raw.trim()) return "empty";
  // School campuses are matched by the route builder in other ways.
  if (looksLikePlace(raw)) return "place";
  const key = canonicalKey(raw);
  if (index.keys.has(key) || index.keys.has(key.replace(/\s+/g, ""))) return "found";
  // A space dropped or added by the reader: "MAPLEWOODMILL RD".
  const sq = squash(raw);
  if (index.names.some((n) => n.squash === sq)) return "found";
  // The sheet says ROAD where the map says DRIVE: the route builder takes the
  // one street of that name, so the check does too (and shows the map's name).
  return looseName(index, raw) ? "found" : "missing";
}

const SUFFIXES = new Set(["st", "rd", "dr", "ln", "ct", "ave", "blvd", "pkwy", "cir", "pl", "trl", "ter", "way", "hwy", "xing"]);
const stem = (key: string) => {
  const w = key.split(" ");
  return w.length > 1 && SUFFIXES.has(w.at(-1)!) ? w.slice(0, -1).join(" ") : key;
};

/** The map's name for a street the sheet writes a little differently, if there's exactly one. */
export function looseName(index: StreetIndex, raw: string): string | null {
  const key = canonicalKey(raw);
  const sq = key.replace(/\s+/g, "");
  const exact = index.names.find((n) => n.squash === sq);
  if (exact) return canonicalKey(exact.display) === key ? null : exact.display;
  const st = stem(key);
  if (!st) return null;
  const hits = index.names.filter((n) => stem(canonicalKey(n.display)) === st);
  return hits.length === 1 ? hits[0].display : null;
}

function distance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
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

/** Closest real street names, best first. */
export function suggestStreets(index: StreetIndex, raw: string, limit = 4): string[] {
  const q = squash(raw);
  if (!q) return [];
  const max = Math.max(2, Math.floor(q.length * 0.35));
  return index.names
    .map((n) => ({ n, d: distance(q, n.squash) }))
    .filter((x) => x.d <= max)
    .sort((a, b) => a.d - b.d || a.n.display.localeCompare(b.n.display))
    .slice(0, limit)
    .map((x) => x.n.display);
}

/** Closest school or place names on the map, written the way the sheet does. */
export function suggestPlaces(index: StreetIndex, raw: string, limit = 3): string[] {
  const q = squash(expandPlaceQuery(raw));
  if (!q) return [];
  const seen = new Set<string>();
  return index.places
    .map((p) => ({ name: sheetStyle(p.name), d: distance(q, squash(p.name)) }))
    .filter((x) => x.d <= Math.max(3, Math.floor(q.length * 0.4)) && !seen.has(x.name) && seen.add(x.name))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.name);
}

export type StopCheck = { status: StreetStatus; missing: string[] };

/** Can the route builder place this stop? `missing` lists the names it couldn't find. */
export function checkStop(index: StreetIndex, description: string): StopCheck {
  const loc = classifyLocation(description);
  const placeFound = (name: string) => !!matchPlace(name, index.places);
  const one = (name: string): boolean => {
    if (looksLikePlace(name)) return placeFound(name);
    return checkStreet(index, name) === "found";
  };
  let names: string[] = [];
  if (loc.kind === "intersection") names = [loc.a, loc.b];
  else if (loc.kind === "school") names = [loc.name];
  else if (loc.kind === "end" || loc.kind === "street") names = [loc.street];
  else return { status: "empty", missing: [] };
  const missing = names.filter((n) => !one(n));
  return { status: missing.length ? "missing" : "found", missing };
}

/** Suggestions for one missing name in a stop line, street or school. */
export function suggestFor(index: StreetIndex, name: string): string[] {
  return looksLikePlace(name) ? suggestPlaces(index, name) : suggestStreets(index, name);
}
