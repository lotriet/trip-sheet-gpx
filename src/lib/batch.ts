/**
 * Sort a pile of trip sheet photos into trips.
 *
 * A shift's photos come in any order: several runs, some with a second page.
 * Every printed page repeats the "Run: 123.456" header, so pages are grouped
 * by run number, put in order by their stop times, and the trips are ordered
 * by their first stop. Pure functions, so they can be tested without a browser.
 */

import { parseSheet } from "./engine/parseSheet";
import type { Sheet, Stop } from "./engine/types";

/** One page of text: a photo, part of a photo, or pasted text. `photo` is -1 for pasted text. */
export type PageRead = { photo: number; name: string; text: string };

export type PageInfo = PageRead & {
  /** "123.456", or null when the header couldn't be read. */
  run: string | null;
  /** First and last stop times on the page in minutes after midnight, or null. */
  first: number | null;
  last: number | null;
  /** The page starts with directions before any stop: a second (or later) page. */
  continues: boolean;
  /** The page's first stop is a Deadhead line: the start of a run. */
  starts: boolean;
};

export type Trip = {
  key: string;
  run: string;
  pages: PageInfo[];
  text: string;
  sheet: Sheet;
  firstTime: string;
  firstMinutes: number | null;
  stops: number;
  turns: number;
};

/** Read the run number from a page header, forgiving common OCR slips (O for 0, l for 1). */
export function runNumberOf(text: string): string | null {
  // "Run: 900 10]" is 900.101 with a lost dot and a 1 read as a bracket.
  const m = text.match(/\brun\s*[:;]?\s*([0-9OoIl|\]![]{3})\s?[.,]?\s?([0-9OoIl|\]![X]{3})(?![0-9])/i);
  if (!m) return null;
  const fix = (s: string) => s.replace(/[Oo]/g, "0").replace(/[Il|\]![]/g, "1");
  return `${fix(m[1])}.${fix(m[2])}`;
}

/** "2:28 PM" -> 868. */
export function minutesOf(time: string): number | null {
  const m = time.trim().match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "P") h += 12;
  return h * 60 + Number(m[2]);
}

export function describePage(page: PageRead): PageInfo {
  const sheet = parseSheet(page.text);
  const times = sheet.stops.map((s) => minutesOf(s.time)).filter((m): m is number => m != null);
  const first = times.length ? times[0] : null;
  const last = times.length ? Math.max(...times) : null;
  const continues = !!sheet.stops.length && !sheet.stops[0].time && sheet.stops[0].maneuvers.length > 0;
  const firstTimed = sheet.stops.find((s) => s.time);
  const starts = !continues && !!firstTimed && /^deadhead\b/i.test(firstTimed.description);
  return { ...page, run: runNumberOf(page.text), first, last, continues, starts };
}

/** Same length and at most one character different: an OCR slip in the run number. */
function nearRun(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff <= 1;
}

/**
 * A trip key for every page, in the same order as `pages`.
 * Pages share a key when their run numbers match. A continuation page whose
 * number is one character off an existing run (an OCR slip) joins that run;
 * two first pages are never merged that way, since real run numbers on one
 * route can differ by a single digit. A page with no readable run number
 * joins the previous photo's trip, unless it starts with a Deadhead line,
 * which always begins a new trip.
 */
export function autoGroup(pages: PageInfo[]): string[] {
  const starts = new Set(pages.filter((p) => p.run && !p.continues).map((p) => p.run as string));
  const keys: string[] = [];
  pages.forEach((p, i) => {
    if (p.run) {
      if (!starts.has(p.run) && p.continues) {
        const near = [...starts].filter((k) => nearRun(k, p.run as string));
        if (near.length === 1) {
          keys.push(near[0]);
          return;
        }
      }
      keys.push(p.run);
    } else if (!p.starts && (i > 0 || pages.some((q) => q.run))) {
      // A continuation page: the run whose first page ends closest before it starts,
      // or else the previous photo's trip.
      keys.push(closestBefore(p, pages, keys, i) ?? keys[i - 1] ?? pages.find((q) => q.run)?.run ?? "trip-1");
    } else {
      // No run number, but a Deadhead line: a new run starts here.
      keys.push(newTripKey(keys));
    }
  });
  return keys;
}

function closestBefore(page: PageInfo, pages: PageInfo[], keys: string[], at: number): string | null {
  if (page.first == null) return null;
  let best: { key: string; gap: number } | null = null;
  pages.forEach((q, j) => {
    if (j === at || !q.starts || q.last == null || !q.run) return;
    const gap = (page.first as number) - q.last;
    // Within an hour after that page's last stop.
    if (gap < 0 || gap > 60) return;
    const key = keys[j] ?? q.run;
    if (!best || gap < best.gap) best = { key, gap };
  });
  return (best as { key: string; gap: number } | null)?.key ?? null;
}

function orderPages(pages: PageInfo[]): PageInfo[] {
  return pages.slice().sort((a, b) => {
    if (a.first != null && b.first != null && a.first !== b.first) return a.first - b.first;
    // A page with no stop time is a continuation: keep it after a page that has one.
    if (a.first == null && b.first != null) return 1;
    if (b.first == null && a.first != null) return -1;
    return a.photo - b.photo;
  });
}

/** Build trips from pages and their keys. Trips are ordered by first stop time. */
export function buildTrips(pages: PageInfo[], keys: string[]): Trip[] {
  const byKey = new Map<string, PageInfo[]>();
  pages.forEach((p, i) => {
    const k = keys[i];
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(p);
  });
  const trips: Trip[] = [];
  for (const [key, group] of byKey) {
    const ordered = orderPages(group);
    const text = ordered.map((p) => p.text).join("\n");
    const sheet = sortStopsByTime(parseSheet(text));
    const run = /^\d{3}\.\w{3}$/.test(key) ? key : sheet.run;
    if (run) sheet.run = run;
    const firstTime = sheet.stops.find((s) => s.time)?.time ?? "";
    trips.push({
      key,
      run,
      pages: ordered,
      text,
      sheet,
      firstTime,
      firstMinutes: minutesOf(firstTime),
      stops: sheet.stops.length,
      turns: sheet.stops.reduce((n, s) => n + s.maneuvers.length, 0),
    });
  }
  return trips.sort((a, b) => {
    if (a.firstMinutes == null) return b.firstMinutes == null ? 0 : 1;
    if (b.firstMinutes == null) return -1;
    return a.firstMinutes - b.firstMinutes;
  });
}

/** A key for a trip the user makes by moving a page out of its group. */
export function newTripKey(keys: string[]): string {
  let n = 1;
  while (keys.includes(`trip-${n}`)) n++;
  return `trip-${n}`;
}

/** `run_441109.gpx`; numbered when the run is unknown or the name is taken. */
export function gpxFileName(run: string, index: number, used: Set<string>): string {
  const id = run.replace(/[^0-9A-Za-z]/g, "");
  const base = id ? `run_${id}` : `run_${String(index + 1).padStart(2, "0")}`;
  let name = `${base}.gpx`;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}.gpx`;
  used.add(name);
  return name;
}

/**
 * Where to put new runs in the day list: each goes before the first run that
 * starts later, so the list stays in driving order without moving runs the
 * driver already placed. A run with the same run number is replaced.
 */
export function mergeIntoDay<T extends { run: string; firstTime: string }>(day: T[], added: T[]): T[] {
  let out = day.filter((d) => !d.run || !added.some((a) => a.run === d.run));
  for (const run of added) {
    const t = minutesOf(run.firstTime);
    const at = t == null ? -1 : out.findIndex((d) => {
      const dt = minutesOf(d.firstTime);
      return dt != null && dt > t;
    });
    out = at === -1 ? [...out, run] : [...out.slice(0, at), run, ...out.slice(at)];
  }
  return out;
}

/**
 * Put a run's stops in scheduled order, each with its own directions.
 *
 * Directions printed before any stop (an empty card: no time, no place) come
 * from the top of a page. They belong to the stop just before the next stop
 * on that page; when there is no such stop they are the run's opening
 * directions and go to the run's start (its Deadhead stop).
 * A stop with a place but no readable time stays right after the stop before
 * it. The sort is stable, so stops printed with the same time keep their order.
 */
export function sortStopsByTime(sheet: Sheet): Sheet {
  const stops = sheet.stops.map((s) => ({ ...s, maneuvers: s.maneuvers.slice() }));
  const isOrphan = (s: Stop) => !s.time && !s.description.trim() && s.stopId == null;
  const orphans: { at: number; stop: Stop }[] = [];
  stops.forEach((s, i) => {
    if (isOrphan(s)) orphans.push({ at: i, stop: s });
  });
  const kept = stops.filter((s) => !isOrphan(s));

  let last = -1;
  const keyed = kept.map((stop, i) => {
    const m = minutesOf(stop.time);
    if (m != null) last = m;
    return { stop, i, at: m ?? last };
  });
  keyed.sort((a, b) => (a.at !== b.at ? a.at - b.at : a.i - b.i));
  const ordered = keyed.map((k) => k.stop);

  // Attach orphans last to first, so several land in printed order.
  for (const { at, stop } of orphans.reverse()) {
    if (!stop.maneuvers.length) continue;
    const next = stops.slice(at + 1).find((s) => !isOrphan(s) && minutesOf(s.time) != null);
    const t = next ? minutesOf(next.time) : null;
    const pos = next ? ordered.indexOf(next) : -1;
    const owner = t != null && pos > 0 ? ordered[pos - 1] : null;
    if (owner) owner.maneuvers.push(...stop.maneuvers);
    else if (ordered.length) ordered[0].maneuvers.unshift(...stop.maneuvers);
    else ordered.push(stop);
  }
  return { ...sheet, stops: ordered };
}

const TIME_LINE = /^\W{0,3}(\d{1,2}\s?:\s?\d{2})\s*([AP])\.?M\b(.*)$/i;
const DIRECTION = /^\W{0,3}(?:proceed|continue|right|left|turn\s*around|tu[mn]\s*around|u[\s-]?turn)\b/i;

/**
 * Split text that holds more than one run into one chunk per run. A new run
 * starts at a Deadhead stop that follows other stops (the times usually jump
 * back, e.g. a 4:22 PM school arrival and then a 3:48 PM Deadhead). The page
 * header printed just above it (Route/Run, column titles) goes with the new run.
 */
export function splitRuns(text: string): string[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const cuts: number[] = [];
  let seenStop = false;
  let lastContent = -1; // last time or direction line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.match(TIME_LINE);
    if (t) {
      if (seenStop && /^\s*deadhead\b/i.test(t[3])) {
        // Header lines between the last direction and this Deadhead belong to the new run.
        cuts.push(lastContent + 1);
      }
      seenStop = true;
      lastContent = i;
    } else if (DIRECTION.test(line)) {
      lastContent = i;
    }
  }
  if (!cuts.length) return [text];
  const out: string[] = [];
  let from = 0;
  for (const c of cuts) {
    out.push(lines.slice(from, c).join("\n"));
    from = c;
  }
  out.push(lines.slice(from).join("\n"));
  // A chunk without a run header inherits nothing; the run number, if any, comes from its own header.
  return out.filter((c) => c.trim());
}
