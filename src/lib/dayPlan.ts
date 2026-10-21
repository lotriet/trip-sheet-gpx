import { appendLine, polylineMeters } from "./engine/geo";
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
};

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
  const title = runs.map((r) => r.run || r.route).filter(Boolean).join(", ") || "School bus day";
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="Trip Sheet GPX" xmlns="http://www.topografix.com/GPX/1/1">`,
    `<metadata><name>${esc(`Day ${title}`)}</name><desc>${esc(
      "Runs in driving order as one track. A waypoint named DEADHEAD marks the start of the drive from the end of one run to the start of the next. That connection is a normal street drive, not a line from a trip sheet.",
    )}</desc></metadata>`,
  ];

  const track: LonLat[] = [];
  runs.forEach((run, i) => {
    const label = [run.route, run.run ? `run ${run.run}` : ""].filter(Boolean).join(" ");
    run.stops.forEach((stop, s) => {
      const name = `Run ${i + 1} ${stop.time} ${prettySheetText(stop.description)}`.replace(/\s+/g, " ").trim();
      lines.push(
        `<wpt lat="${stop.lat.toFixed(6)}" lon="${stop.lon.toFixed(6)}"><name>${esc(name)}</name><desc>${esc(label)}</desc><sym>Flag, Blue</sym></wpt>`,
      );
    });
    appendLine(track, run.coords, 0.4);
    const link = deadheads[i];
    if (i < runs.length - 1 && link && link.coords.length) {
      const at = link.coords[0];
      const how = link.routed
        ? "Normal street drive to the next run. Not printed on a trip sheet."
        : "The map had no drivable connection, so this is a straight line. Check it before you drive.";
      lines.push(
        `<wpt lat="${at[1].toFixed(6)}" lon="${at[0].toFixed(6)}"><name>${esc(`DEADHEAD to run ${i + 2}`)}</name><desc>${esc(how)}</desc><sym>Flag, Blue</sym></wpt>`,
      );
      appendLine(track, link.coords, 0.4);
    }
  });

  const miles = (polylineMeters(track) / 1609.344).toFixed(2);
  lines.push(`<trk><name>${esc(`Day ${title}`)}</name><desc>${esc(`${runs.length} runs, ${miles} mi including deadheads`)}</desc><type>Car</type><trkseg>`);
  for (const [lon, lat] of track) lines.push(`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`);
  lines.push(`</trkseg></trk></gpx>`);
  return lines.join("\n") + "\n";
}
