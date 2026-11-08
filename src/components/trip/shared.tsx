"use client";

import dynamic from "next/dynamic";
import { ArrowUp, CornerUpLeft, CornerUpRight, LoaderCircle, RotateCcw } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { type TurnPin } from "@/lib/dayPlan";
import { maneuverPhrase } from "@/lib/engine/gpx";
import type { LonLat, ManeuverKind, RawLine, RouteOverrides, RouteSuccess, Sheet, Stop, Warning } from "@/lib/engine/types";
import { loadMap, type MapData } from "@/lib/mapfetch";
import { canonicalKey } from "@/lib/engine/names";
import { type SavedRun } from "@/lib/storage";
import { type PageInfo } from "@/lib/batch";
import { type TextFile } from "@/lib/shareFiles";

export const RouteMap = dynamic(() => import("@/components/RouteMap"), {
  ssr: false,
  loading: () => <div className="h-[min(70vh,520px)] w-full animate-pulse rounded-xl bg-neutral-200" />,
});

export type View = "day" | "edit" | "preview" | "review";

export type TripState = { state: "building" | "added" | "failed"; message?: string };
export type EditorDraft = {
  id: string;
  editingId: string | null;
  text: string;
  sheet: Sheet;
  area: string;
  overrides: RouteOverrides;
  warnings: Warning[];
  updatedAt: number;
};
export type GpxNotice = {
  files: TextFile[];
  title: string;
  source: "added" | "single" | "day" | "all";
  state: "ready" | "sharing" | "shared" | "downloaded" | "cancelled";
  /** Shown under the file name while the GPX waits to be sent. */
  note?: string;
  /** iPhone opens several files in another app only one at a time; how many have gone. */
  sent?: number;
};
export const EDITOR_DRAFTS_KEY = "trip-sheet-gpx-editor-drafts-v1";

export function nearbyStreetLines(lines: RawLine[], street: string, lat: number, lon: number): { lines: RawLine[]; point: LonLat; distance: number } | null {
  const key = canonicalKey(street);
  const candidates = lines.filter((line) => canonicalKey(line.name) === key || line.keys.some((lineKey) => canonicalKey(lineKey) === key));
  const matches: { line: RawLine; point: LonLat; distance: number }[] = [];
  for (const line of candidates) {
    let closest: { line: RawLine; point: LonLat; distance: number } | null = null;
    for (const point of line.coords) {
      const dx = (point[0] - lon) * Math.cos((lat * Math.PI) / 180);
      const dy = point[1] - lat;
      const distance = Math.hypot(dx, dy);
      if (!closest || distance < closest.distance) closest = { line, point, distance };
    }
    if (closest) matches.push(closest);
  }
  matches.sort((a, b) => a.distance - b.distance);
  const nearest = matches[0];
  if (!nearest) return null;
  const linesNearStop = matches.filter((match) => match.distance <= 0.015).map((match) => match.line);
  return { lines: linesNearStop, point: nearest.point, distance: nearest.distance };
}

export const KINDS: ManeuverKind[] = ["proceed", "left", "right", "turnaround"];
export const KIND_LABEL: Record<ManeuverKind, string> = {
  proceed: "Proceed on",
  left: "Left onto",
  right: "Right onto",
  turnaround: "Turn around on",
};

export function ManeuverArrow({ kind }: { kind: ManeuverKind }) {
  const Icon = kind === "left"
    ? CornerUpLeft
    : kind === "right"
      ? CornerUpRight
      : kind === "turnaround"
        ? RotateCcw
        : ArrowUp;
  return <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[#315d8c]" strokeWidth={2.5} />;
}

export function RouteBuildStatus({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[#cbd9eb] bg-[#f3f7fc] px-3 py-2 text-xs text-[#34445c]" role="status" aria-live="polite">
      <LoaderCircle aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-[#315d8c]" />
      <span className="min-w-0"><strong className="mr-1">Building your route.</strong>{message || "Finding roads and connecting stops…"}</span>
    </div>
  );
}

export function emptySheet(): Sheet {
  return { route: "", description: "", run: "", stops: [] };
}

export const noSubscribe = () => () => {};

export function canOfferHomeScreenInstall() {
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isInstalled = window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  return isIos && !isInstalled;
}

/** Map data already loaded this session, by area and the sheet's streets. */
export const mapCache = new Map<string, MapData>();

export function mapCacheKey(sheet: Sheet, area: string): string {
  const streets = [...new Set(sheet.stops.flatMap((s) => s.maneuvers.map((m) => m.street.trim().toUpperCase())))].sort();
  return `${area.trim().toLowerCase()}|${streets.slice(0, 8).join("|")}`;
}

/** Saved stop pins still on the same stops of this sheet, as the engine takes them. */
export function pinsFor(sheet: Sheet, pins: SavedRun["stopPins"]): RouteOverrides["stops"] {
  const out: NonNullable<RouteOverrides["stops"]> = {};
  for (const [k, p] of Object.entries(keptPins(sheet, pins) ?? {})) out[Number(k)] = { lat: p.lat, lon: p.lon };
  return out;
}

/** Drop pins whose stop was edited away or moved to another place on the sheet. */
export function keptPins(sheet: Sheet, pins: SavedRun["stopPins"]): SavedRun["stopPins"] {
  if (!pins) return undefined;
  const kept = Object.fromEntries(Object.entries(pins).filter(([k, p]) => sheet.stops[Number(k)]?.description === p.description));
  return Object.keys(kept).length ? kept : undefined;
}

export async function cachedMap(sheet: Sheet, area: string, onStatus?: (s: string) => void): Promise<MapData> {
  const key = mapCacheKey(sheet, area);
  const hit = mapCache.get(key);
  if (hit) return hit;
  const data = await loadMap(sheet, area, onStatus);
  mapCache.set(key, data);
  return data;
}

export function newId() {
  return Math.random().toString(36).slice(2, 10);
}


/**
 * A field that grows with its text. The phone scrolls the page, not the inside
 * of the box, so a long stop or street can be read and edited in place.
 */
export function WrapField({
  value,
  onChange,
  onBlur,
  label,
  placeholder,
  multiline = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  function fit(el: HTMLTextAreaElement) {
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current);
  }, [value]);
  return (
    <textarea
      ref={ref}
      aria-label={label}
      placeholder={placeholder}
      rows={multiline ? 6 : 1}
      value={value}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      enterKeyHint={multiline ? "enter" : "done"}
      className={`block w-full min-h-9 resize-none overflow-hidden rounded-lg border border-[#d9d2c3] bg-white px-3 py-1.5 text-sm leading-snug whitespace-pre-wrap [overflow-wrap:normal] ${multiline ? "min-h-36" : ""} ${className}`}
      onChange={(e) => {
        onChange(multiline ? e.target.value : e.target.value.replace(/\n/g, " "));
        fit(e.currentTarget);
      }}
      onBlur={onBlur}
    />
  );
}

export function prettyText(sheet: Sheet): string {
  const head = [`Route: ${sheet.route} Description: ${sheet.description} Run: ${sheet.run}`];
  for (const stop of sheet.stops) {
    head.push(`${stop.time} ${stop.description}`);
    for (const m of stop.maneuvers) head.push(`${KIND_LABEL[m.kind]} ${m.street}`);
  }
  return head.join("\n");
}

/** In a trip opened from the review list the stops come first; the raw text folds away. */
export function Tucked({ away, summary, children }: { away: boolean; summary: string; children: React.ReactNode }) {
  if (!away) return <>{children}</>;
  return (
    <details className="rounded-xl bg-white p-3 ring-1 ring-[#d9d2c3]">
      <summary className="cursor-pointer text-sm font-medium">{summary}</summary>
      <div className="mt-2 flex flex-col gap-3">{children}</div>
    </details>
  );
}

export function pageTimes(p: PageInfo): string {
  const t = (m: number | null) => (m == null ? "" : `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${m >= 720 ? "PM" : "AM"}`);
  if (p.first == null) return p.run ? `Run ${p.run}` : "no times";
  return `${p.run ? `Run ${p.run} · ` : ""}${t(p.first)}${p.last != null && p.last !== p.first ? `–${t(p.last)}` : ""}`;
}

/** Small pictures of a trip's pages, so a page from another run stands out. */
export function PageThumbs({ pages, onOpen }: { pages: PageInfo[]; onOpen?: (src: string) => void }) {
  if (!pages.some((p) => p.thumb)) return null;
  return (
    <span className="mt-2 flex gap-2">
      {pages.map((p, i) =>
        p.thumb ? (
          onOpen ? (
            <button key={i} type="button" aria-label={`Show page ${i + 1} bigger`} onClick={() => onOpen(p.thumb as string)}>
              <img src={p.thumb} alt="" className="h-20 w-16 rounded object-cover object-top ring-1 ring-[#d9d2c3]" />
            </button>
          ) : (
            <img key={i} src={p.thumb} alt="" className="h-20 w-16 rounded object-cover object-top ring-1 ring-[#d9d2c3]" />
          )
        ) : null,
      )}
    </span>
  );
}

export function SuggestPanel({
  names,
  looking,
  suggest,
  onPick,
}: {
  names: string[];
  looking: boolean;
  suggest: (part: string) => string[];
  onPick: (part: string, name: string) => void;
}) {
  if (!names.length) return null;
  return (
    <div className="col-span-3 w-full min-w-0 rounded-lg bg-[#fef2f2] p-2 sm:col-span-4" data-suggest>
      {names.map((part) => {
        const options = looking ? [] : suggest(part);
        return (
          <div key={part} className="mb-1">
            <p className="text-xs leading-relaxed">
              {looking
                ? `Looking up ${part} near this run…`
                : options.length
                  ? `${part} isn't on the map near this run. Did you mean:`
                  : `${part} wasn't found near this run. Type it the way the sheet prints it.`}
            </p>
            <div className="mt-1 flex flex-col gap-1">
              {options.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="min-h-9 touch-manipulation rounded-lg border border-[#d9d2c3] bg-white px-2.5 py-1 text-left text-sm leading-snug"
                  onClick={() => onPick(part, name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function StreetMark({ state, open, onTap }: { state: string; open: boolean; onTap: () => void }) {
  if (state === "found") {
    return (
      <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-[#e6f3e9] text-sm font-bold text-[#176b36] ring-1 ring-[#c4e1cc]" aria-label="Street found on the map">
        ✓
      </span>
    );
  }
  if (state === "missing") {
    return (
      <button
        type="button"
        className={`h-9 w-8 rounded-full text-base font-bold text-white shadow-sm ${open ? "bg-[#7f1d1d]" : "bg-[#dc2626]"}`}
        aria-label="Street not found. Show close matches"
        onClick={onTap}
      >
        ?
      </button>
    );
  }
  if (state === "looking") {
    return (
      <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-[#fff5dc]" aria-label="Looking up the name">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#d9d2c3] border-t-[#0f2744]" />
      </span>
    );
  }
  if (state === "checking") {
    // Names are checked once the map for the area has loaded.
    return <span className="mx-auto flex h-7 w-7 items-center justify-center" title="Checked when the map loads" aria-label="Checked when the map loads"><span className="h-2.5 w-2.5 rounded-full bg-[#cfd6df]" /></span>;
  }
  return <span className="w-9" aria-hidden />;
}

/** The route's printed turns as map pins. Turnarounds already have their own pins. */
export function routeTurnPins(route: RouteSuccess): TurnPin[] {
  return route.turnMarks.flatMap((mark) => {
    const point = route.coords[mark.trackIndex];
    if (!point || mark.kind === "turnaround") return [];
    return [{ lat: point[1], lon: point[0], label: maneuverPhrase(mark.kind, mark.street, mark.via), kind: mark.kind, confirmed: mark.confirmed }];
  });
}

/** "Stop 2 · Left onto DAVIS DR" for a warning tied to a printed stop or direction. */
export function warningPlace(stops: Stop[], w: { stopIndex?: number; maneuverIndex?: number }): string {
  if (typeof w.stopIndex !== "number" || w.stopIndex < 0) return "";
  const stop = stops[w.stopIndex];
  const head = `Stop ${w.stopIndex + 1}${stop?.time ? ` (${stop.time})` : ""}`;
  const turn = typeof w.maneuverIndex === "number" && w.maneuverIndex >= 0 ? stop?.maneuvers[w.maneuverIndex] : undefined;
  return turn ? `${head} · ${KIND_LABEL[turn.kind]} ${turn.street}` : head;
}
