import type { Maneuver, ManeuverKind, Sheet, Stop, StopLocation } from "./types";

const BOILER =
  /driver directions|if the directions cannot|this document and information|provided in confidence|stop\s*time|stop\s*load|run\s*ld|may not be disclosed|wcpss students|report name|page\s+\d+|^\d{1,2}\/\d{1,2}\/\d{2,4}$|tims\b|medians in the roadway|one way streets|private streets/i;

function cleanLine(s: string): string {
  return s
    .replace(/[|]/g, " ")
    .replace(/\btum\b/gi, "Turn")
    .replace(/\b0nto\b/gi, "Onto")
    .replace(/\s+/g, " ")
    .trim();
}

function peelTail(s: string): {
  text: string;
  stopLoad: number | null;
  runLoad: number | null;
  stopId: string | null;
} {
  const full = s.match(/^(.*?)(?:\s+(\d+)\s+(\d+)\s+(\d{3}\.\d{3}))\s*$/);
  if (full && full[1].trim()) {
    return { text: full[1].trim(), stopLoad: Number(full[2]), runLoad: Number(full[3]), stopId: full[4] };
  }
  const idOnly = s.match(/^(.*\D)\s+(\d{3}\.\d{3})\s*$/);
  if (idOnly) return { text: idOnly[1].trim(), stopLoad: null, runLoad: null, stopId: idOnly[2] };
  return { text: s.trim(), stopLoad: null, runLoad: null, stopId: null };
}

function parseManeuver(line: string): Maneuver | null {
  const s = line.replace(/[.]+\s*$/, "").trim();
  let m = s.match(/^(?:proceed|continue)\s+on\s+(.+)$/i);
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
  return s.replace(/\s+\d{3}\.\d{3}\s*$/, "").replace(/[.,;:]+$/, "").trim();
}

export function classifyLocation(description: string): StopLocation {
  let d = description.replace(/\s+/g, " ").trim();
  d = d.replace(/^\s*deadhead\s*-?\s*/i, "").trim();
  d = d.replace(/\s*-\s*doorside\b.*$/i, "").trim();
  const school = d.match(/^(?:school\s*:\s*)(.+)$/i);
  if (school) return { kind: "school", name: school[1].trim() };
  if (/@/.test(d) || /end of(?: the)? (sidewalk|road|street|court)/i.test(d)) {
    const street = d.split("@")[0].replace(/\bend of\b.*$/i, "").trim();
    if (street) return { kind: "end", street };
  }
  const parts = d.split(/\s+&\s+|\s+\band\b\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2) return { kind: "intersection", a: parts[0], b: parts[1] };
  if (d) return { kind: "street", street: d };
  return { kind: "unknown" };
}

function emptyStop(time: string, description: string): Stop {
  const peeled = peelTail(description);
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
  const route = text.match(/route\s*:\s*([A-Za-z0-9.-]+)/i)?.[1]?.trim() ?? "";
  const run = text.match(/\brun\s*:\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1]?.trim() ?? "";
  const description =
    text.match(/description\s*:\s*([^\n]+?)(?=\s+run\s*:|\s*$)/im)?.[1]?.trim() ?? "";

  const stops: Stop[] = [];
  let current: Stop | null = null;

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

    // A wrapped description line before any maneuvers.
    if (current && current.maneuvers.length === 0 && !/^\d+$/.test(line)) {
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
    description: description.replace(/\s+run\s*:.*$/i, "").trim(),
    run,
    stops: stops.filter((s) => s.description || s.maneuvers.length || s.time),
  };
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
