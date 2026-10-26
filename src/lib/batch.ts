/**
 * Sort a pile of trip sheet photos into trips.
 *
 * A shift's photos come in any order: several runs, some with a second page.
 * Every printed page repeats the "Run: 123.456" header, so pages are grouped
 * by run number, put in order by their stop times, and the trips are ordered
 * by their first stop. Pure functions, so they can be tested without a browser.
 */

import { schoolSig } from "./engine/names";
import { editDistance } from "./engine/route";
import { classifyLocation, parseSheet, ROUTE_HEADING, RUN_HEADING } from "./engine/parseSheet";
import type { Sheet, Stop } from "./engine/types";

/** One page of text: a photo, part of a photo, or pasted text. `photo` is -1 for pasted text. */
export type PageRead = {
  photo: number;
  name: string;
  text: string;
  thumb?: string;
  /** The page footer was never read; the bottom of the page may be missing. */
  incomplete?: boolean;
  /** The load column lists this many more stops than were read. */
  missingStops?: number;
};

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

/** Minutes between a run's last stop and a continuation page's first stop that still count as "next". */
const CONTINUE_GAP = 60;

/**
 * A trip key for every page, in the same order as `pages`. The result does
 * not depend on the order the photos were picked in, except for a page that
 * has neither a run number nor a stop time.
 *
 * 1. A first page (it starts with a stop, not with directions) is keyed by
 *    the Run number in its header. Without one, a page that opens with a
 *    Deadhead stop starts a trip of its own.
 * 2. A continuation page (directions before any stop) joins a run only when
 *    its times follow that run's last stop: the run its header names, else a
 *    run one character off (an OCR slip), else the run whose last stop comes
 *    closest before it. It never joins a run whose times it doesn't continue.
 *    Continuation pages are placed earliest first, so a third page follows
 *    the second.
 */
export function autoGroup(pages: PageInfo[]): string[] {
  const keys: (string | null)[] = pages.map(() => null);
  const isFirst = (p: PageInfo) => !p.continues && (!!p.run || p.starts);
  pages.forEach((p, i) => {
    if (!isFirst(p)) return;
    keys[i] = p.run ?? newTripKey(keys.filter((k): k is string => !!k));
  });

  const lastOf = (key: string): number | null => {
    let last: number | null = null;
    pages.forEach((q, j) => {
      if (keys[j] === key && q.last != null) last = last == null ? q.last : Math.max(last, q.last);
    });
    return last;
  };
  const follows = (p: PageInfo, key: string): number | null => {
    if (p.first == null) return 0;
    const last = lastOf(key);
    if (last == null) return 0;
    const gap = p.first - last;
    return gap >= 0 && gap <= CONTINUE_GAP ? gap : null;
  };

  const rest = pages
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => keys[i] == null)
    .sort((a, b) => (a.p.first ?? Infinity) - (b.p.first ?? Infinity) || a.p.photo - b.p.photo || a.i - b.i);
  for (const { p, i } of rest) {
    const existing = [...new Set(keys.filter((k): k is string => !!k))];
    const fits = existing.map((key) => ({ key, gap: follows(p, key) })).filter((f) => f.gap != null) as { key: string; gap: number }[];
    let key: string | undefined;
    if (p.run) key = fits.find((f) => f.key === p.run)?.key;
    if (!key && p.run) {
      const near = fits.filter((f) => /^\d{3}\.\w{3}$/.test(f.key) && nearRun(f.key, p.run as string));
      if (near.length === 1) key = near[0].key;
    }
    if (!key && p.first != null) key = fits.sort((a, b) => a.gap - b.gap)[0]?.key;
    if (!key && p.first == null) {
      // No times to go by: the header's run, else the photo taken just before it.
      key = (p.run && existing.includes(p.run) ? p.run : undefined) ?? keys[i - 1] ?? undefined;
    }
    keys[i] = key ?? p.run ?? newTripKey(existing);
  }
  return keys.map((k) => k ?? "trip-1");
}

/**
 * The same page photographed twice: same run, same stop times. Keep the first.
 * Returns the pages to keep and the photos that were left out.
 */
export function dropDuplicatePages(pages: PageInfo[]): { pages: PageInfo[]; dropped: PageInfo[] } {
  const seen = new Set<string>();
  const kept: PageInfo[] = [];
  const dropped: PageInfo[] = [];
  for (const p of pages) {
    const sheet = parseSheet(p.text);
    const times = sheet.stops.map((s) => s.time).filter(Boolean);
    if (times.length < 2) {
      kept.push(p);
      continue;
    }
    const sig = `${p.run ?? "?"}|${times.join(",")}|${sheet.stops.length}`;
    if (seen.has(sig)) dropped.push(p);
    else {
      seen.add(sig);
      kept.push(p);
    }
  }
  return { pages: kept, dropped };
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
  const route = commonRoute(pages);
  const trips: Trip[] = [];
  for (const [key, group] of byKey) {
    const ordered = orderPages(group);
    const text = ordered.map((p) => p.text).join("\n");
    const sheet = sortStopsByTime(parseSheet(text));
    const run = /^\d{3}\.\w{3}$/.test(key) ? key : sheet.run;
    if (run) sheet.run = run;
    // One misread page ("GHy715") takes the route the other pages agree on.
    if (route && sheet.route !== route && (!sheet.route || editDistance(sheet.route.toUpperCase(), route) <= 2)) sheet.route = route;
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

/** The route printed on most pages, when at least two pages agree. */
function commonRoute(pages: PageInfo[]): string {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const route = parseSheet(page.text).route.toUpperCase();
    if (route) counts.set(route, (counts.get(route) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 1;
  for (const [route, count] of counts) if (count > bestCount) [best, bestCount] = [route, count];
  return best;
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
export function mergeIntoDay<T extends { run: string; firstTime: string; locked?: boolean }>(day: T[], added: T[]): T[] {
  let out = day.filter((d) => d.locked || !d.run || !added.some((a) => a.run === d.run));
  for (const run of added) {
    // A protected GPX wins over a newly imported run with the same run number.
    if (run.run && out.some((existing) => existing.locked && existing.run === run.run)) continue;
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
  return { ...sheet, stops: mergeSameSchool(ordered) };
}

/**
 * A run that starts at a school prints it twice at the same minute: the
 * Deadhead line and the "SCHOOL:" line. Show it as one stop, with the
 * directions of both, named by the SCHOOL: line.
 */
export function mergeSameSchool(stops: Stop[]): Stop[] {
  const out: Stop[] = [];
  const sig = (s: Stop) => {
    const loc = classifyLocation(s.description);
    return loc.kind === "school" ? schoolSig(loc.name) : null;
  };
  for (const stop of stops) {
    const prev = out.at(-1);
    const a = prev ? sig(prev) : null;
    const b = sig(stop);
    if (prev && a && b && a.tokens && a.tokens === b.tokens && (!a.level || !b.level || a.level === b.level) && minutesOf(prev.time) === minutesOf(stop.time)) {
      const keep = /^\s*school\s*:/i.test(stop.description) || !/^\s*school\s*:/i.test(prev.description) ? stop : prev;
      out[out.length - 1] = {
        ...keep,
        stopLoad: keep.stopLoad ?? prev.stopLoad ?? stop.stopLoad,
        runLoad: keep.runLoad ?? stop.runLoad ?? prev.runLoad,
        maneuvers: [...prev.maneuvers, ...stop.maneuvers],
      };
      continue;
    }
    out.push(stop);
  }
  return out;
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
    if (seenStop && RUN_HEADING.test(line)) {
      // "Run 900.102 - ..." titles the next run on a converted sheet.
      cuts.push(i);
      seenStop = false;
      continue;
    }
    const t = line.match(TIME_LINE);
    if (t) {
      if (seenStop && /^\s*[-\u2013\u2014:]*\s*deadhead\b/i.test(t[3])) {
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
  for (const c of [...new Set(cuts)].sort((a, b) => a - b)) {
    out.push(lines.slice(from, c).join("\n"));
    from = c;
  }
  out.push(lines.slice(from).join("\n"));
  // A converted sheet prints "Route DEMO42 - ..." once at the top; every run on it shares that route.
  const routeLine = lines.slice(0, cuts[0]).find((l) => ROUTE_HEADING.test(l));
  if (routeLine) for (let k = 1; k < out.length; k++) if (!ROUTE_HEADING.test(out[k])) out[k] = `${routeLine}\n${out[k]}`;
  // Otherwise a chunk without a run header inherits nothing; the run number, if any, comes from its own header.
  return out.filter((c) => c.trim());
}
