import type { LonLat, PlacedStop, Sheet, TurnMark } from "./types";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ABBR: Record<string, string> = {
  LN: "Ln",
  DR: "Dr",
  CT: "Ct",
  RD: "Rd",
  ST: "St",
  AVE: "Ave",
  BLVD: "Blvd",
  PKWY: "Pkwy",
  CIR: "Cir",
  PL: "Pl",
  HWY: "Hwy",
  HS: "HS",
  ES: "ES",
  MS: "MS",
  NC: "NC",
  US: "US",
  AM: "AM",
  PM: "PM",
};

/** Light cleanup of sheet capitals for a waypoint name. */
export function prettySheetText(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => {
      const bare = word.replace(/[^A-Za-z0-9]/g, "");
      const upper = bare.toUpperCase();
      if (ABBR[upper] && bare.length === upper.length && word === word.toUpperCase()) {
        return word.replace(bare, ABBR[upper]);
      }
      if (word === word.toUpperCase() && /^(OF|AND|AT|TO|ON|BY|OR|THE)$/.test(upper)) {
        return word.charAt(0) + word.slice(1).toLowerCase();
      }
      if (word === word.toUpperCase() && /[A-Z]{3,}/.test(word)) {
        return word.charAt(0) + word.slice(1).toLowerCase();
      }
      return word;
    })
    .join(" ");
}

function maneuverPhrase(kind: string, street: string): string {
  const name = prettySheetText(street);
  if (kind === "proceed") return `Proceed on ${name}`;
  if (kind === "left") return `Left on ${name}`;
  if (kind === "right") return `Right on ${name}`;
  return `Turn around on ${name}`;
}

/** GPX `<type>` for a track point where a printed turn happens. */
export const TURN_TYPE = "turn";
/** The router could not confirm this turn's spot; a follower should treat it as approximate. */
export const TURN_UNCONFIRMED_TYPE = "turn-unconfirmed";

/**
 * One `<trkpt>`. A turn point carries the printed maneuver as its name, so a
 * follower knows exactly where on the track the turn is. GPX apps that do not
 * read point names ignore it.
 */
export function trackPointXml(point: LonLat, turn?: Pick<TurnMark, "kind" | "street" | "confirmed">): string {
  const attrs = `lat="${point[1].toFixed(6)}" lon="${point[0].toFixed(6)}"`;
  if (!turn) return `<trkpt ${attrs}/>`;
  const type = turn.confirmed ? TURN_TYPE : TURN_UNCONFIRMED_TYPE;
  return `<trkpt ${attrs}><name>${esc(maneuverPhrase(turn.kind, turn.street))}</name><type>${type}</type></trkpt>`;
}

export function buildGpx(sheet: Sheet, track: LonLat[], stops: PlacedStop[], turns: TurnMark[] = []): string {
  const titleBits = [sheet.route, sheet.run ? `Run ${sheet.run}` : "", sheet.description ? prettySheetText(sheet.description) : ""]
    .map((s) => s.trim())
    .filter(Boolean);
  const title = titleBits.join(" ") || "School bus run";
  const meta =
    "Trip-sheet street sequence (not optimized). Built from OpenStreetMap data. One-way directions may be missing from named-road map data. Bus restrictions are not checked; follow the trip sheet and road signs. Turnaround spots are estimated.";

  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="Trip Sheet GPX" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">`,
    `<metadata><name>${esc(title)}</name><desc>${esc(meta)}</desc></metadata>`,
  ];

  stops.forEach((stop, i) => {
    const sheetStop = sheet.stops[stop.index] ?? sheet.stops[i];
    const name = `${i + 1} - ${stop.time} ${prettySheetText(stop.description)}`.replace(/\s+/g, " ").trim();
    const bits: string[] = [];
    if (stop.stopId) bits.push(`Stop ${stop.stopId}.`);
    if (stop.stopLoad != null) bits.push(`Stop load ${stop.stopLoad}.`);
    if (stop.runLoad != null) bits.push(`Run load ${stop.runLoad}.`);
    const moves = sheetStop?.maneuvers.map((m) => maneuverPhrase(m.kind, m.street)).join(", ");
    if (moves) bits.push(moves + ".");
    lines.push(
      `<wpt lat="${stop.lat.toFixed(6)}" lon="${stop.lon.toFixed(6)}"><name>${esc(name)}</name><desc>${esc(bits.join(" "))}</desc><sym>Flag, Blue</sym></wpt>`,
    );
  });

  const streetList = sheet.stops
    .flatMap((s) => s.maneuvers.map((m) => prettySheetText(m.street)))
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .join(", ");
  lines.push(
    `<trk><name>${esc(title)}</name><desc>${esc(streetList || title)}</desc><type>Car</type><trkseg>`,
  );
  const turnAt = new Map<number, TurnMark>();
  for (const turn of turns) {
    if (turn.trackIndex >= 0 && turn.trackIndex < track.length && !turnAt.has(turn.trackIndex)) turnAt.set(turn.trackIndex, turn);
  }
  track.forEach((point, i) => lines.push(trackPointXml(point, turnAt.get(i))));
  lines.push(`</trkseg></trk></gpx>`);
  return lines.join("\n") + "\n";
}
