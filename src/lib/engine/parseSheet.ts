import { looksLikePlace } from "./names";
import type { Maneuver, ManeuverKind, Sheet, Stop, StopLocation } from "./types";

const BOILER =
  /driver directions|if the directions cannot|this document and information|provided in confidence|stop\s*time|stop\s*load|run\s*ld|may not be disclosed|wcpss students|report name|page\s+\d+|^\d{1,2}\/\d{1,2}\/\d{2,4}$|tims\b|medians in the roadway|one way streets|private streets/i;

function cleanLine(s: string): string {
  return s
    // Typed and converted sheets separate fields with en or em dashes.
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/[|]/g, " ")
    .replace(/[[\]{}]/g, "")
    .replace(/\btu[mn]\b/gi, "Turn")
    .replace(/\b[0O]nt[o0]\b/g, "Onto")
    // Route numbers misread as letters: "NC SS HWY" is NC 55, "US 1O" is US 10.
    .replace(/\b(NC|US|I)([\s-]+)([0-9SOIlBZ]{1,3})\b/g, (m, net: string, gap: string, num: string) => {
      const fixed = num.replace(/S/g, "5").replace(/O/g, "0").replace(/[Il]/g, "1").replace(/B/g, "8").replace(/Z/g, "2");
      return /\d/.test(num) || /^(?:SS|S|SSS)$/.test(num) || /[SOIlBZ]/.test(num) ? `${net}${gap}${fixed}` : m;
    })
    .replace(/\s+/g, " ")
    .trim()
    // OCR often adds stray marks from the page edge before or after a line.
    .replace(/^[^A-Za-z0-9]+/, "")
    // A stray mark or letter in front of a time or a direction: "i 02:36 PM ...".
    .replace(/^(?:\S{1,2}\s+){1,3}(?=(?:\d{1,2}\s?:\s?\d{2}|proceed|continue|right|left|turn)\b)/i, "")
    .replace(/[^A-Za-z0-9)]+$/, "")
    .trim();
}

const SUFFIX =
  /\b(?:RD|DR|LN|ST|AVE|AV|CT|WAY|PKWY|PKY|HWY|BLVD|CIR|PL|TRL|TR|LOOP|TER|XING|RUN|PATH|SQ|ROW|PT|HS|MS|ES|EXPY|FWY)\b/;

/** Drop OCR crumbs after a street name: "MAIN ST i", "OAK DR 5", "ELM AVE L". */
function trimCrumbs(s: string): string {
  let out = s.trim();
  for (;;) {
    const m = out.match(/^(.*\S)\s+(\S+)$/);
    if (!m) break;
    const [, head, last] = m;
    const crumb =
      /^[^A-Za-z0-9]+$/.test(last) ||
      /^[a-z]{1,3}$/.test(last) ||
      (/^[A-Za-z0-9]$/.test(last) && SUFFIX.test(head.split(/\s+/).pop() ?? "")) ||
      (/^\d{5}$/.test(last) && SUFFIX.test(head.split(/\s+/).pop() ?? ""));
    if (!crumb) break;
    out = head;
  }
  return out;
}

/** A wrapped stop description is printed in capitals: street names, &, @, numbers. */
function looksLikeDescription(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length > 0.8 && /[A-Z]{3,}/.test(line) && !/[^A-Za-z0-9 &@().,'/#-]/.test(line);
}

// "123.045", "@AB.012", "123.X01"; OCR sometimes drops the dot ("123045").
const STOP_ID = String.raw`[0-9@][0-9A-Za-z]{2}\.?[0-9A-Za-z]{3}`;

function fixId(id: string): string {
  return id.includes(".") ? id : `${id.slice(0, 3)}.${id.slice(3)}`;
}

function readLoad(s: string): number | null {
  const n = Number(s.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1"));
  return Number.isFinite(n) ? n : null;
}

// Words a stop line ends on; anything after the last one with a digit in it is
// load or stop-id columns the reader garbled ("ELM WAY 12 3 39112").
const LINE_END =
  /^(.*\b(?:rd|road|st|street|dr|drive|ln|lane|pkwy|parkway|ave|avenue|ct|court|blvd|boulevard|cir|circle|pl|place|trl|trail|ter|terrace|way|hwy|xing|loop|run|pt|sq|hs|es|ms|elem|school))\b\s+(.+)$/i;

function dropJunkTail(text: string): string {
  const m = text.match(LINE_END);
  if (!m || !/\d/.test(m[2]) || /&/.test(m[2])) return text;
  if (/\b(rd|st|dr|ln|ave|way|ct|blvd|pkwy|hwy)\b/i.test(m[2])) return text;
  return m[1].trim();
}

function peelTail(raw: string): {
  text: string;
  stopLoad: number | null;
  runLoad: number | null;
  stopId: string | null;
} {
  const s = trimCrumbs(raw);
  const full = s.match(new RegExp(String.raw`^(.*?)(?:\s+-)?\s+(\S{1,3})\s+(\S{1,3})\s+(${STOP_ID})\s*$`));
  if (full && full[1].trim()) {
    return { text: dropJunkTail(full[1].trim()), stopLoad: readLoad(full[2]), runLoad: readLoad(full[3]), stopId: fixId(full[4]) };
  }
  const idOnly = s.match(/^(.*\D)\s+([0-9@][0-9A-Za-z]{2}\.[0-9A-Za-z]{3})\s*$/);
  if (idOnly) return { text: dropJunkTail(idOnly[1].trim()), stopLoad: null, runLoad: null, stopId: idOnly[2] };
  return { text: dropJunkTail(s.trim()), stopLoad: null, runLoad: null, stopId: null };
}

function parseManeuver(line: string): Maneuver | null {
  const s = line.replace(/[.]+\s*$/, "").trim();
  let m = s.match(/^(?:proceed|continue)\s+on(?:to)?\s+(.+)$/i);
  if (m) return { kind: "proceed", street: tidyStreet(m[1]) };
  m = s.match(/^(?:right|rt)\s*(?:turn\s*)?(?:onto|on|to)\s+(.+)$/i);
  if (m) return { kind: "right", street: tidyStreet(m[1]) };
  m = s.match(/^(?:left|lt)\s*(?:turn\s*)?(?:onto|on|to)\s+(.+)$/i);
  if (m) return { kind: "left", street: tidyStreet(m[1]) };
  m = s.match(/^(?:turn\s*around|u[\s-]?turn)\s+on\s+(.+)$/i);
  if (m) return { kind: "turnaround", street: tidyStreet(m[1]) };
  return null;
}

function tidyStreet(s: string): string {
  return trimCrumbs(s.replace(/\s+\d{3}\.\d{3}\s*$/, "").replace(/[.,;:]+$/, "").trim());
}

export function classifyLocation(description: string): StopLocation {
  let d = description.replace(/\s+/g, " ").trim();
  d = d.replace(/^\s*deadhead\s*-?\s*/i, "").trim();
  // "- DOORSIDE", "(DOORSIDE)", or "DOORSIDE" wrapped onto its own line.
  d = d.replace(/\s*-?\s*\(?\bdoorside\b\)?.*$/i, "").replace(/\s*-\s*$/, "").trim();
  const school = d.match(/^(?:school\s*:\s*)(.+)$/i);
  if (school) return { kind: "school", name: school[1].trim() };
  // "1 OAK HS": a campus written with a street number.
  const campus = d.replace(/^\d+\s+/, "");
  if (campus !== d && looksLikePlace(campus)) return { kind: "school", name: campus };
  // "OAK HS 16 (DB)": a campus with its bell number and a note.
  if (!/[&@]/.test(d) && looksLikePlace(campus)) return { kind: "school", name: campus };
  if (/@/.test(d) || /end of(?: the)? (sidewalk|road|street|court)/i.test(d)) {
    const street = d.split("@")[0].replace(/\bend of\b.*$/i, "").trim();
    if (street) return { kind: "end", street };
  }
  const parts = d.split(/\s+&\s+|\s+\band\b\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2) return { kind: "intersection", a: parts[0], b: parts[1] };
  if (d) return { kind: "street", street: d };
  return { kind: "unknown" };
}

type ParsingStop = Stop & { wrapped?: number };

/** "Run 900.101 - OAK HS 01" (dashes are normalized by cleanLine; raw text may still have en dashes). */
export const RUN_HEADING = /^\s*run\s+(\d{3}\.\d{3})\s*[-\u2013\u2014]\s*(.+?)\s*$/im;
export const ROUTE_HEADING = /^\s*route\s+([A-Za-z0-9.]+)\s*[-\u2013\u2014]/im;

/** "- SCHOOL: OAK HS (start)": the field dash and a start/end note are not part of the place. */
function stripStopNotes(description: string): string {
  return description
    .replace(/^\s*-+\s*/, "")
    .replace(/\s*\((?:start|end)\)\s*$/i, "")
    .trim();
}

function emptyStop(time: string, description: string): ParsingStop {
  const peeled = peelTail(stripStopNotes(description));
  return {
    time,
    description: peeled.text,
    stopLoad: peeled.stopLoad,
    runLoad: peeled.runLoad,
    stopId: peeled.stopId,
    maneuvers: [],
  };
}

/**
 * Read a Driver Directions sheet from OCR text or a paste.
 * Unknown lines are kept out of the maneuver list; the driver can fix the result.
 */
export function parseSheet(raw: string): Sheet {
  const text = raw.replace(/\r/g, "");
  // A converted sheet titles each run "Run 900.101 - OAK HS 01" and the
  // page "Route DEMO42 - Trip Sheet Directions" instead of "Run:" fields.
  const runHeading = text.match(RUN_HEADING);
  const route =
    text.match(/route\s*:\s*([A-Za-z0-9.-]+)/i)?.[1]?.trim() ?? text.match(ROUTE_HEADING)?.[1]?.trim() ?? "";
  const run = text.match(/\brun\s*:\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1]?.trim() ?? runHeading?.[1]?.trim() ?? "";
  const description =
    text.match(/description\s*:\s*([^\n]+?)(?=\s+run\s*:|\s*$)/im)?.[1]?.trim() ?? runHeading?.[2]?.trim() ?? "";

  const stops: ParsingStop[] = [];
  let current: ParsingStop | null = null;

  const pushManeuver = (kind: ManeuverKind, street: string) => {
    if (!current) {
      current = emptyStop("", "");
      stops.push(current);
    }
    current.maneuvers.push({ kind, street });
  };

  for (const original of text.split("\n")) {
    const line = cleanLine(original);
    if (!line) continue;
    if (BOILER.test(line)) continue;
    if (/^(route|description|run)\s*:/i.test(line) && !/\d{1,2}:\d{2}/.test(line)) continue;
    if (RUN_HEADING.test(line) || ROUTE_HEADING.test(line)) continue;

    const time = line.match(/^(\d{1,2}:\d{2})\s*([AP]M)\b\s*(.*)$/i);
    if (time) {
      const [hour, minute] = time[1].split(":");
      const printed = `${Number(hour)}:${minute} ${time[2].toUpperCase()}`;
      current = emptyStop(printed, time[3] ?? "");
      stops.push(current);
      continue;
    }

    const maneuver = parseManeuver(line);
    if (maneuver) {
      pushManeuver(maneuver.kind, maneuver.street);
      continue;
    }

    const loads = line.match(/^(\d+)\s+(\d+)\s+(\d{3}\.\d{3})$/);
    if (loads && current && current.stopId == null) {
      current.stopLoad = Number(loads[1]);
      current.runLoad = Number(loads[2]);
      current.stopId = loads[3];
      continue;
    }
    const onlyId = line.match(/^(\d{3}\.\d{3})$/);
    if (onlyId && current && current.stopId == null) {
      current.stopId = onlyId[1];
      continue;
    }

    // A wrapped description line right after the stop line, before any maneuvers.
    if (current && current.maneuvers.length === 0 && (current.wrapped ?? 0) < 1 && looksLikeDescription(line)) {
      current.wrapped = (current.wrapped ?? 0) + 1;
      const peeled = peelTail(line);
      current.description = `${current.description} ${peeled.text}`.trim();
      if (peeled.stopId && current.stopId == null) {
        current.stopId = peeled.stopId;
        current.stopLoad = peeled.stopLoad;
        current.runLoad = peeled.runLoad;
      }
    }
  }

  // Drop a trailing empty stop created from a stray time, but keep real stops with no maneuvers (end of run).
  return {
    route,
    description: description.replace(/\s+run\s*:.*$/i, "").replace(/\s+run\s*$/i, "").trim(),
    run,
    stops: expandStopNames(
      stops
        .filter((s) => s.description || s.maneuvers.length || s.time)
        .map((stop) => {
          delete stop.wrapped;
          return stop as Stop;
        }),
    ),
  };
}

const STREET_SUFFIX = /^(rd|road|st|street|dr|drive|ln|lane|pkwy|parkway|ave|avenue|ct|court|blvd|boulevard|cir|circle|pl|place|trl|trail|ter|terrace|way|hwy|xing|loop)$/i;

/**
 * The sheet cuts long street names short in stop lines ("LAKE OF T" for
 * LAKE OF THE PINES, "MAPLEWOOD ME RD" for MAPLEWOOD MEADOW RD). When exactly
 * one street in the directions starts the same way, use its full name.
 */
export function expandShortName(part: string, streets: string[]): string {
  const words = part.trim().toUpperCase().split(/\s+/);
  if (!words.length || words.some((w) => !/^[A-Z0-9]+$/.test(w))) return part;
  const hasSuffix = words.length > 1 && STREET_SUFFIX.test(words.at(-1)!);
  const head = hasSuffix ? words.slice(0, -1) : words;
  const fits = (full: string) => {
    const fw = full.toUpperCase().split(/\s+/);
    if (full.toUpperCase() === part.trim().toUpperCase()) return false;
    if (hasSuffix) {
      if (fw.length !== words.length || fw.at(-1) !== words.at(-1)) return false;
    } else if (fw.length < head.length) return false;
    return head.every((w, i) => (i === head.length - 1 ? fw[i].startsWith(w) && fw[i].length > w.length || (fw[i] === w && fw.length > head.length) : fw[i] === w));
  };
  const known = [...new Set(streets.map((s) => s.trim().toUpperCase()))];
  if (known.includes(part.trim().toUpperCase())) return part;
  const hits = known.filter(fits);
  return hits.length === 1 && head.length >= 2 ? hits[0] : part;
}

function expandStopNames(stops: Stop[]): Stop[] {
  const streets = stops.flatMap((s) => s.maneuvers.map((m) => m.street)).filter(Boolean);
  return stops.map((stop) => {
    const loc = classifyLocation(stop.description);
    if (loc.kind !== "intersection") return stop;
    const a = expandShortName(loc.a, streets);
    const b = expandShortName(loc.b, streets);
    if (a === loc.a && b === loc.b) return stop;
    const lead = /^\s*deadhead\s*-?\s*/i.exec(stop.description)?.[0] ?? "";
    return { ...stop, description: `${lead ? "Deadhead - " : ""}${a} & ${b}` };
  });
}

export function flattenManeuvers(sheet: Sheet): { stopIndex: number; maneuverIndex: number; maneuver: Maneuver }[] {
  const out: { stopIndex: number; maneuverIndex: number; maneuver: Maneuver }[] = [];
  sheet.stops.forEach((stop, stopIndex) => {
    stop.maneuvers.forEach((maneuver, maneuverIndex) => {
      out.push({ stopIndex, maneuverIndex, maneuver });
    });
  });
  return out;
}
