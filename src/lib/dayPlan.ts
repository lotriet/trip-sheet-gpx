import { haversine, polylineMeters } from "./engine/geo";
import { prettySheetText } from "./engine/gpx";
import type { LonLat } from "./engine/types";

export type DayStop = {
  time: string;
  description: string;
  lat: number;
  lon: number;
};

export type DayRunTrack = {
  route: string;
  description: string;
  run: string;
  /** First stop time, used in the file name. */
  firstTime: string;
  coords: LonLat[];
  stops: DayStop[];
  /** The run's own GPX. Its stop directions and turn points are carried into the day file. */
  gpx?: string;
  /** The track is a recorded drive, not planned from the sheet. */
  driven?: boolean;
};

type DayPoint = { point: LonLat; turn?: string };

/** A printed turn drawn on a map: where it happens and whether the router confirmed it. */
export type TurnPin = { lat: number; lon: number; label: string; kind: "left" | "right" | "turnaround" | "proceed"; confirmed: boolean };

/** Turn pins from a run's own GPX, for saved runs that no longer carry their route result. */
export function turnPinsFromGpx(gpx: string): TurnPin[] {
  const pins: TurnPin[] = [];
  for (const m of gpx.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"><name>([^<]*)<\/name><type>(turn(?:-unconfirmed)?)<\/type><\/trkpt>/g)) {
    const label = m[3].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    const kind = /^left\b/i.test(label) ? "left" : /^right\b/i.test(label) ? "right" : /^proceed\b/i.test(label) ? "proceed" : "turnaround";
    pins.push({ lat: Number(m[1]), lon: Number(m[2]), label, kind, confirmed: m[4] === "turn" });
  }
  return pins;
}

/**
 * A run GPX saved before turn points were written: it has printed turns but no
 * `<trkpt>` marking where they happen. Building it again adds them.
 */
export function lacksTurnPoints(gpx: string): boolean {
  return /<desc>[^<]*\b(?:Left on|Right on|Turn around on)\b/.test(gpx) && !/<type>turn/.test(gpx);
}

/**
 * Stop directions and turn-point markup from a run GPX built by `buildGpx`.
 * Values stay XML-escaped, as they were written.
 */
export function runGpxParts(gpx: string): { stopDescs: string[]; turns: Map<number, string> } {
  const stopDescs = [...gpx.matchAll(/<wpt\b[^>]*>[\s\S]*?<\/wpt>/g)].map(
    (m) => m[0].match(/<desc>([\s\S]*?)<\/desc>/)?.[1] ?? "",
  );
  const turns = new Map<number, string>();
  let index = 0;
  for (const m of gpx.matchAll(/<trkpt\b[^>]*?(?:\/>|>([\s\S]*?)<\/trkpt>)/g)) {
    if (m[1] && /<type>turn/.test(m[1])) turns.set(index, m[1]);
    index++;
  }
  return { stopDescs, turns };
}

export type DeadheadLeg = {
  coords: LonLat[];
  /** False when the streets did not connect and the line is straight. */
  routed: boolean;
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "2:38 PM" -> "0238PM". */
export function fileTime(time: string): string {
  const m = time.trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return "time";
  return `${m[1].padStart(2, "0")}${m[2]}${m[3].toUpperCase()}`;
}

/** "OAK ACADEMY 2" -> "OakAcademy". */
export function filePlace(description: string): string {
  const words = prettySheetText(description)
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^\d+$/.test(w));
  const joined = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return (joined || "Run").slice(0, 40);
}

/** `01_SAMPLE_OakAcademy_0315PM.gpx` */
export function runFileName(index: number, run: Pick<DayRunTrack, "run" | "description" | "firstTime">): string {
  const n = String(index + 1).padStart(2, "0");
  const id = (run.run || "run").replace(/[^\d.A-Za-z_-]/g, "") || "run";
  return `${n}_${id}_${filePlace(run.description)}_${fileTime(run.firstTime)}.gpx`;
}

/**
 * One GPX for the whole day: a single track, runs in list order, with a deadhead
 * drive between the end of one and the start of the next. No route element.
 */
export function buildDayGpx(runs: DayRunTrack[], deadheads: DeadheadLeg[]): string {
  const runList = runs.map((r) => r.run || r.route).filter(Boolean).join(", ") || "School bus day";
  // A different name keeps a driven day beside the planned one in GPX Nav instead of replacing it.
  const title = runs.some((r) => r.driven) ? `${runList} · recorded drive` : runList;
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="Trip Sheet GPX" xmlns="http://www.topografix.com/GPX/1/1">`,
    `<metadata><name>${esc(`Day ${title}`)}</name><desc>${esc(
      "Runs are in driving order. Routed deadheads connect runs. When no road connection was found, the track resumes in a separate segment and must be checked before driving.",
    )}</desc></metadata>`,
  ];

  const segments: DayPoint[][] = [[]];
  runs.forEach((run, i) => {
    const track = segments[segments.length - 1];
    const label = [run.route, run.run ? `run ${run.run}` : ""].filter(Boolean).join(" ");
    const parts = run.gpx ? runGpxParts(run.gpx) : null;
    // A follower reads directions from each stop's description; without them the day has no turns.
    const descs = parts && parts.stopDescs.length === run.stops.length ? parts.stopDescs : null;
    run.stops.forEach((stop, k) => {
      const name = `Run ${i + 1} ${stop.time} ${prettySheetText(stop.description)}`.replace(/\s+/g, " ").trim();
      const desc = descs?.[k] ? `${esc(label)}. ${descs[k]}` : esc(label);
      lines.push(
        `<wpt lat="${stop.lat.toFixed(6)}" lon="${stop.lon.toFixed(6)}"><name>${esc(name)}</name><desc>${desc}</desc><sym>Flag, Blue</sym></wpt>`,
      );
    });
    appendDay(track, run.coords, parts?.turns);
    const link = deadheads[i];
    if (i < runs.length - 1) {
      const at = link?.coords[0] ?? run.coords.at(-1);
      const routed = !!link?.routed && !!link.coords.length;
      const how = routed
        ? "Normal street drive to the next run. Not printed on a trip sheet."
        : "No drivable connection was found. The track resumes in a separate segment; check the connection before driving.";
      if (at) {
        lines.push(
          `<wpt lat="${at[1].toFixed(6)}" lon="${at[0].toFixed(6)}"><name>${esc(`DEADHEAD to run ${i + 2}`)}</name><desc>${esc(how)}</desc><sym>Flag, Blue</sym></wpt>`,
        );
      }
      if (routed) appendDay(track, link!.coords);
      else segments.push([]);
    }
  });

  const meters = segments.reduce((sum, segment) => sum + polylineMeters(segment.map((p) => p.point)), 0);
  const miles = (meters / 1609.344).toFixed(2);
  lines.push(`<trk><name>${esc(`Day ${title}`)}</name><desc>${esc(`${runs.length} runs, ${miles} mi including deadheads`)}</desc><type>Car</type>`);
  for (const segment of segments) {
    lines.push(`<trkseg>`);
    for (const { point, turn } of segment) {
      const attrs = `lat="${point[1].toFixed(6)}" lon="${point[0].toFixed(6)}"`;
      lines.push(turn ? `<trkpt ${attrs}>${turn}</trkpt>` : `<trkpt ${attrs}/>`);
    }
    lines.push(`</trkseg>`);
  }
  lines.push(`</trk></gpx>`);
  return lines.join("\n") + "\n";
}

/** Like `appendLine`, keeping each source point's turn markup on the point that survives. */
function appendDay(into: DayPoint[], add: LonLat[], turns?: Map<number, string>) {
  add.forEach((p, k) => {
    const turn = turns?.get(k);
    const last = into.at(-1);
    if (!last || haversine(last.point, p) > 0.4) into.push({ point: [p[0], p[1]], ...(turn ? { turn } : {}) });
    else if (turn && !last.turn) last.turn = turn;
  });
}
