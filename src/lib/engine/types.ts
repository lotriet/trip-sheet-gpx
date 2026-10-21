/** Shared types for the trip-sheet router. Coordinates are [lon, lat]. */

export type LonLat = [number, number];

export type ManeuverKind = "proceed" | "left" | "right" | "turnaround";

export type Maneuver = {
  kind: ManeuverKind;
  /** Street or place text as printed on the sheet. */
  street: string;
};

export type StopLocation =
  | { kind: "intersection"; a: string; b: string }
  | { kind: "school"; name: string }
  | { kind: "end"; street: string }
  | { kind: "street"; street: string }
  | { kind: "unknown" };

export type Stop = {
  time: string;
  description: string;
  stopLoad: number | null;
  runLoad: number | null;
  stopId: string | null;
  maneuvers: Maneuver[];
};

export type Sheet = {
  route: string;
  description: string;
  run: string;
  stops: Stop[];
};

export type RawLine = {
  name: string;
  /** Routing keys this geometry may be followed as. */
  keys: string[];
  coords: LonLat[];
  kind: "named" | "service";
  oneway: number;
};

export type RawPlace = {
  name: string;
  lat: number;
  lon: number;
  tokens: string;
  level: string;
};

export type Warning = {
  level: "info" | "warn";
  stopIndex: number;
  maneuverIndex: number;
  message: string;
};

export type PlacedStop = {
  index: number;
  time: string;
  description: string;
  stopId: string | null;
  stopLoad: number | null;
  runLoad: number | null;
  lat: number;
  lon: number;
  /** Index into the track coordinate array. */
  trackIndex: number;
};

export type TurnaroundPin = {
  /** `${stopIndex}:${maneuverIndex}` */
  id: string;
  stopIndex: number;
  maneuverIndex: number;
  street: string;
  lat: number;
  lon: number;
  how: "deadend" | "loop" | "override" | "capped" | "fallback";
};

export type ViaPin = {
  id: string;
  lat: number;
  lon: number;
};

export type RouteOverrides = {
  /** Move a guessed turnaround. Key is TurnaroundPin.id. */
  turnarounds?: Record<string, { lat: number; lon: number }>;
  /** Extra points the track must pass, in order. */
  vias?: { lat: number; lon: number }[];
};

export type RouteLeg = {
  stopIndex: number;
  maneuverIndex: number;
  kind: ManeuverKind;
  street: string;
  meters: number;
};

export type RouteSuccess = {
  ok: true;
  coords: LonLat[];
  meters: number;
  miles: number;
  stops: PlacedStop[];
  warnings: Warning[];
  turnarounds: TurnaroundPin[];
  legs: RouteLeg[];
  gpx: string;
};

export type RouteFailure = {
  ok: false;
  error: string;
  warnings: Warning[];
};

export type RouteResult = RouteSuccess | RouteFailure;
