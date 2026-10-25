"use client";

import dynamic from "next/dynamic";
import { ArrowUp, CornerUpLeft, CornerUpRight, House, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EXAMPLE_SHEET_TEXT } from "@/lib/exampleSheet";
import { buildDayGpx, runFileName, type DeadheadLeg } from "@/lib/dayPlan";
import { driveBetween } from "@/lib/engine/drive";
import { buildGpx } from "@/lib/engine/gpx";
import { classifyLocation, parseSheet } from "@/lib/engine/parseSheet";
import { routeSheet } from "@/lib/engine/route";
import type { LonLat, Maneuver, ManeuverKind, RawLine, RouteOverrides, RouteSuccess, Sheet, TurnaroundPin, Warning } from "@/lib/engine/types";
import { loadAround, loadCorridor, loadMap, lookupName, mergeMaps, type MapData } from "@/lib/mapfetch";
import { canonicalKey, looksLikePlace, schoolSig } from "@/lib/engine/names";
import { matchPlace } from "@/lib/engine/route";
import { readSheetPhotos } from "@/lib/ocr";
import { isPdf, pdfToPageImages } from "@/lib/pdfPages";
import { osrmRouter } from "@/lib/osrm";
import { RETAKE_MESSAGE } from "@/lib/ocr/quality";
import { loadDay, saveDay, type SavedRun } from "@/lib/storage";
import { autoGroup, buildTrips, describePage, dropDuplicatePages, gpxFileName, mergeIntoDay, newTripKey, sortStopsByTime, splitRuns, type PageInfo, type PageRead, type Trip } from "@/lib/batch";
import { canShareFiles, sendNativeGpx, shareOrDownload, type TextFile } from "@/lib/shareFiles";
import { buildStreetIndex, checkStop, checkStreet, looseName, sheetStyle, suggestFor as suggestNames } from "@/lib/streetCheck";

const RouteMap = dynamic(() => import("@/components/RouteMap"), {
  ssr: false,
  loading: () => <div className="h-[min(70vh,520px)] w-full animate-pulse rounded-xl bg-neutral-200" />,
});

type View = "day" | "edit" | "preview" | "review";

type TripState = { state: "building" | "added" | "failed"; message?: string };
type EditorDraft = {
  id: string;
  editingId: string | null;
  text: string;
  sheet: Sheet;
  area: string;
  overrides: RouteOverrides;
  warnings: Warning[];
  updatedAt: number;
};
type GpxNotice = {
  files: TextFile[];
  title: string;
  source: "added" | "single" | "day" | "all";
  state: "ready" | "sharing" | "shared" | "downloaded" | "cancelled";
};
const EDITOR_DRAFTS_KEY = "trip-sheet-gpx-editor-drafts-v1";

function nearbyStreetLines(lines: RawLine[], street: string, lat: number, lon: number): { lines: RawLine[]; point: LonLat; distance: number } | null {
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

const KINDS: ManeuverKind[] = ["proceed", "left", "right", "turnaround"];
const KIND_LABEL: Record<ManeuverKind, string> = {
  proceed: "Proceed on",
  left: "Left onto",
  right: "Right onto",
  turnaround: "Turn around on",
};

function ManeuverArrow({ kind }: { kind: ManeuverKind }) {
  const Icon = kind === "left"
    ? CornerUpLeft
    : kind === "right"
      ? CornerUpRight
      : kind === "turnaround"
        ? RotateCcw
        : ArrowUp;
  return <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[#315d8c]" strokeWidth={2.5} />;
}

function RouteBuildStatus({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[#cbd9eb] bg-[#f3f7fc] px-3 py-2 text-xs text-[#34445c]" role="status" aria-live="polite">
      <LoaderCircle aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-[#315d8c]" />
      <span className="min-w-0"><strong className="mr-1">Building your route.</strong>{message || "Finding roads and connecting stops…"}</span>
    </div>
  );
}

function emptySheet(): Sheet {
  return { route: "", description: "", run: "", stops: [] };
}

const noSubscribe = () => () => {};

function canOfferHomeScreenInstall() {
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isInstalled = window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  return isIos && !isInstalled;
}

/** Map data already loaded this session, by area and the sheet's streets. */
const mapCache = new Map<string, MapData>();

function mapCacheKey(sheet: Sheet, area: string): string {
  const streets = [...new Set(sheet.stops.flatMap((s) => s.maneuvers.map((m) => m.street.trim().toUpperCase())))].sort();
  return `${area.trim().toLowerCase()}|${streets.slice(0, 8).join("|")}`;
}

async function cachedMap(sheet: Sheet, area: string, onStatus?: (s: string) => void): Promise<MapData> {
  const key = mapCacheKey(sheet, area);
  const hit = mapCache.get(key);
  if (hit) return hit;
  const data = await loadMap(sheet, area, onStatus);
  mapCache.set(key, data);
  return data;
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

export function TripApp() {
  const [view, setView] = useState<View>("day");
  const [runs, setRuns] = useState<SavedRun[]>([]);
  const [drafts, setDrafts] = useState<EditorDraft[]>([]);
  const [draftsReady, setDraftsReady] = useState(false);
  const [draftId, setDraftId] = useState("");
  const [draftActive, setDraftActive] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [stored, setStored] = useState(true);
  const [gpxNotice, setGpxNotice] = useState<GpxNotice | null>(null);
  const saveRevision = useRef(0);
  const [status, setStatus] = useState("");
  const [routeBuilding, setRouteBuilding] = useState(false);
  const [error, setError] = useState("");
  const [area, setArea] = useState("Wake County, North Carolina");
  const [text, setText] = useState("");
  const [sheet, setSheet] = useState<Sheet>(emptySheet());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [loadedArea, setLoadedArea] = useState("");
  const [route, setRoute] = useState<RouteSuccess | null>(null);
  const [editWarnings, setEditWarnings] = useState<Warning[]>([]);
  const [overrides, setOverrides] = useState<RouteOverrides>({});
  const [pick, setPick] = useState<string | null>(null);
  const [tapMode, setTapMode] = useState<"turn" | "via" | null>(null);
  // Several photos covering several runs: one row per trip to check before building.
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [pageKeys, setPageKeys] = useState<string[]>([]);
  const [fixing, setFixing] = useState(false);
  const [tripStates, setTripStates] = useState<Record<string, TripState>>({});
  // A trip opened from the review list, and the fixes made to trips before building.
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const [tripEdits, setTripEdits] = useState<Record<string, { text: string; sheet: Sheet; map?: MapData }>>({});
  const [bigThumb, setBigThumb] = useState<string | null>(null);
  const [mapRun, setMapRun] = useState<string | null>(null);
  const [directionMapStop, setDirectionMapStop] = useState<number | null>(null);
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const [warningCursor, setWarningCursor] = useState(0);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const offerHomeScreenInstall = useSyncExternalStore(noSubscribe, canOfferHomeScreenInstall, () => false);
  const [warningFix, setWarningFix] = useState<{
    stopIndex: number;
    maneuverIndex: number;
    kind: ManeuverKind;
    street: string;
  } | null>(null);
  const [mapFocus, setMapFocus] = useState<{ lat: number; lon: number; key: number }>();
  const [mapFixContext, setMapFixContext] = useState<{ stopIndex: number; message: string; street?: string } | null>(null);
  const mapFocusKey = useRef(0);
  const [exportingDay, setExportingDay] = useState(false);
  const exportLock = useRef(false);
  const movePanel = useRef<HTMLDivElement>(null);
  // Server render says "Download all"; the phone switches to "Share all" if it can.
  const canShare = useSyncExternalStore(noSubscribe, canShareFiles, () => false);
  const trips = useMemo(() => buildTrips(pages, pageKeys), [pages, pageKeys]);
  // Street names in the form, checked against the map around the stops.
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [suggestFor, setSuggestFor] = useState<string | null>(null);
  const streetIndex = useMemo(
    () => (mapData && loadedArea === area ? buildStreetIndex(mapData.lines.filter((l) => l.kind === "named"), mapData.places) : null),
    [mapData, loadedArea, area],
  );
  const hasStops = sheet.stops.length > 0;
  const hasDraftContent = hasStops || text.trim().length > 0;
  const currentDraft = drafts.find((draft) => draft.id === draftId && draft.editingId === editingId);
  const draftIsSaved = !!currentDraft && currentDraft.text === text && currentDraft.area === area &&
    JSON.stringify(currentDraft.sheet) === JSON.stringify(sheet) &&
    JSON.stringify(currentDraft.overrides) === JSON.stringify(overrides) &&
    JSON.stringify(currentDraft.warnings) === JSON.stringify(editWarnings);
  const editingRun = editingId ? runs.find((run) => run.id === editingId) : undefined;
  // Fresh lookups of names the loaded map doesn't have, keyed by the typed text.
  const [lookups, setLookups] = useState<Record<string, { state: "looking" | "found" | "none"; name?: string }>>({});
  const [recheckTick, setRecheckTick] = useState(0);
  const [undo, setUndo] = useState<
    | { type: "stop"; stop: Sheet["stops"][number]; at: number }
    | { type: "direction"; stopIndex: number; maneuver: Maneuver; at: number; rebuild?: boolean }
    | null
  >(null);
  const scrollRestoreRef = useRef<number | null>(null);
  const warningAdvanceRef = useRef<{ order: string[]; active: string } | null>(null);
  const lookKey = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, " ");
  const runCenter = useMemo(() => {
    if (!mapData) return null;
    const pts = mapData.lines.filter((l) => l.kind === "named").map((l) => l.coords[0]);
    if (!pts.length) return null;
    const lats = pts.map((p) => p[1]).sort((a, b) => a - b);
    const lons = pts.map((p) => p[0]).sort((a, b) => a - b);
    return { lat: lats[Math.floor(lats.length / 2)], lon: lons[Math.floor(lons.length / 2)] };
  }, [mapData]);

  /** Is one name (a street or a school) on the loaded map? */
  function nameOnMap(raw: string): boolean {
    if (!streetIndex || !raw.trim()) return false;
    if (looksLikePlace(raw)) return !!matchPlace(raw, streetIndex.places);
    return checkStreet(streetIndex, raw) === "found";
  }

  type FieldState = { state: string; missing: string[]; label?: string };

  function streetState(raw: string): FieldState {
    if (!raw.trim()) return { state: "unknown", missing: [] };
    if (!streetIndex) return { state: checking ? "checking" : "unknown", missing: [] };
    if (nameOnMap(raw)) {
      const place = looksLikePlace(raw) ? matchPlace(raw, streetIndex.places) : null;
      return { state: "found", missing: [], label: place?.name ?? looseName(streetIndex, raw) ?? undefined };
    }
    const lk = lookups[lookKey(raw)];
    return { state: lk?.state === "looking" ? "looking" : "missing", missing: [raw] };
  }

  function stopState(description: string): FieldState {
    if (!description.trim()) return { state: "unknown", missing: [] };
    if (!streetIndex) return { state: checking ? "checking" : "unknown", missing: [] };
    const check = checkStop(streetIndex, description);
    if (check.status === "empty") return { state: "unknown", missing: [] };
    if (check.status === "found") {
      const loc = classifyLocation(description);
      const place = loc.kind === "school" ? matchPlace(loc.name, streetIndex.places) : null;
      return { state: "found", missing: [], label: place?.name };
    }
    const looking = check.missing.some((m) => lookups[lookKey(m)]?.state === "looking");
    return { state: looking ? "looking" : "missing", missing: check.missing };
  }

  /** Close matches for a missing name: what the fresh lookup found, then names on the map near the run. */
  function optionsFor(part: string): string[] {
    const lk = lookups[lookKey(part)];
    const out: string[] = [];
    if (lk?.state === "found" && lk.name) {
      const styled = looksLikePlace(part) ? sheetStyle(lk.name) : sheetStyle(lk.name);
      if (canonicalKey(styled) !== canonicalKey(part)) out.push(styled);
    }
    for (const n of streetIndex ? suggestNames(streetIndex, part) : []) if (!out.includes(n)) out.push(n);
    return out.slice(0, 5);
  }

  /**
   * Look names up again right now, near this run: the built-in school list,
   * then the geocoder. A hit adds the map around it, so the field turns green
   * and the route builder can use it.
   */
  async function resolveNames(parts: string[], force = false) {
    const todo = [...new Set(parts.filter((p) => p.trim()))].filter((p) => force || !lookups[lookKey(p)]);
    if (!todo.length || !runCenter) return;
    setLookups((prev) => ({ ...prev, ...Object.fromEntries(todo.map((p) => [lookKey(p), { state: "looking" as const }])) }));
    for (const part of todo) {
      let result: { state: "found" | "none"; name?: string } = { state: "none" };
      try {
        const hit = await lookupName(part, runCenter);
        if (hit) {
          const extra = await loadAround({ lat: hit.lat, lon: hit.lon });
          const places = hit.place && !extra.places.some((p) => p.name === hit.name) ? [{ name: hit.name, lat: hit.lat, lon: hit.lon, ...schoolSig(hit.name) }] : [];
          setMapData((prev) => (prev ? mergeMaps(prev, { lines: extra.lines, places: [...extra.places, ...places] }) : prev));
          result = { state: "found", name: hit.name };
        }
      } catch {
        result = { state: "none" };
      }
      setLookups((prev) => ({ ...prev, [lookKey(part)]: result }));
    }
  }

  function tapMark(id: string, parts: string[]) {
    const open = suggestFor !== id;
    setSuggestFor(open ? id : null);
    if (open && parts.length) void resolveNames(parts, true);
  }

  function recheckSoon() {
    setRecheckTick((t) => t + 1);
  }

  function deleteStop(si: number) {
    const stop = sheet.stops[si];
    setSheet({ ...sheet, stops: sheet.stops.filter((_, i) => i !== si) });
    setSuggestFor(null);
    setUndo({ type: "stop", stop, at: si });
  }

  function deleteManeuver(si: number, mi: number) {
    const maneuver = sheet.stops[si]?.maneuvers[mi];
    if (!maneuver) return;
    setSheet({ ...sheet, stops: sheet.stops.map((stop, i) => i === si ? { ...stop, maneuvers: stop.maneuvers.filter((_, j) => j !== mi) } : stop) });
    setSuggestFor(null);
    setUndo({ type: "direction", stopIndex: si, maneuver, at: mi });
  }

  function undoDelete() {
    if (!undo) return;
    if (undo.type === "stop") {
      const stops = sheet.stops.slice();
      stops.splice(Math.min(undo.at, stops.length), 0, undo.stop);
      setSheet({ ...sheet, stops });
    } else {
      const stop = sheet.stops[undo.stopIndex];
      if (stop) {
        const maneuvers = stop.maneuvers.slice();
        maneuvers.splice(Math.min(undo.at, maneuvers.length), 0, undo.maneuver);
        const nextSheet = { ...sheet, stops: sheet.stops.map((item, i) => i === undo.stopIndex ? { ...item, maneuvers } : item) };
        setSheet(nextSheet);
        if (undo.rebuild) {
          scrollRestoreRef.current = window.scrollY;
          void generate(overrides, nextSheet);
        }
      }
    }
    setUndo(null);
  }

  useEffect(() => {
    if (!undo || routeBuilding) return;
    const t = setTimeout(() => setUndo(null), 10000);
    return () => clearTimeout(t);
  }, [undo, routeBuilding]);

  useEffect(() => {
    // After typing settles (or a field loses focus), look up names the map doesn't have.
    if (view !== "edit" || !streetIndex || !runCenter) return;
    const timer = setTimeout(() => {
      const missing: string[] = [];
      for (const stop of sheet.stops) {
        missing.push(...stopState(stop.description).missing);
        for (const m of stop.maneuvers) missing.push(...streetState(m.street).missing);
      }
      void resolveNames(missing.slice(0, 12));
    }, 900);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, streetIndex, runCenter, view, recheckTick]);
  const reviewTrip = reviewKey ? (trips.find((t) => t.key === reviewKey) ?? null) : null;
  const editingLockedRun = editingId != null && runs.some((run) => run.id === editingId && run.locked);

  useEffect(() => {
    // Load the map quietly once the form has stops, after typing settles.
    if (view !== "edit" || !hasStops || streetIndex || status || checkFailed) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setChecking(true);
      cachedMap(sheet, area)
        .then((data) => {
          if (cancelled) return;
          setMapData(data);
          setLoadedArea(area);
        })
        .catch(() => {
          // No check marks without the map; say so, so the driver can try again.
          if (!cancelled) setCheckFailed(true);
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, 1200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // The sheet is read when the timer fires; re-running on every edit would reload the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, hasStops, streetIndex, status, area, checkFailed]);


  useEffect(() => {
    let active = true;
    loadDay().then((saved) => {
      if (!active) return;
      setRuns(saved);
      setReady(true);
    }).catch(() => {
      if (active) setLoadError(true);
    });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem(EDITOR_DRAFTS_KEY);
        const parsed: unknown = saved ? JSON.parse(saved) : [];
        if (Array.isArray(parsed)) setDrafts(parsed as EditorDraft[]);
      } catch {
        // A corrupt draft cache should not prevent opening saved runs.
      } finally {
        setDraftsReady(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!draftsReady) return;
    try {
      localStorage.setItem(EDITOR_DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      // Keep drafts in memory when browser storage is full or disabled.
    }
  }, [drafts, draftsReady]);

  useEffect(() => {
    if (!draftsReady || !draftActive || (!sheet.stops.length && !text.trim())) return;
    const timer = setTimeout(() => {
      const draft: EditorDraft = {
        id: draftId || newId(), editingId, text, sheet, area, overrides,
        warnings: editWarnings, updatedAt: Date.now(),
      };
      setDrafts((prev) => [draft, ...prev.filter((item) => item.id !== draft.id)]);
    }, 500);
    return () => clearTimeout(timer);
  }, [draftsReady, draftActive, draftId, editingId, text, sheet, area, overrides, editWarnings]);

  useEffect(() => {
    if (!ready) return;
    const revision = ++saveRevision.current;
    saveDay(runs).then((saved) => {
      if (revision === saveRevision.current) setStored(saved);
    });
  }, [runs, ready]);

  useEffect(() => {
    const top = scrollRestoreRef.current;
    if (top === null || view !== "preview" || routeBuilding) return;
    scrollRestoreRef.current = null;
    const frame = requestAnimationFrame(() => window.scrollTo({ top, behavior: "auto" }));
    return () => cancelAnimationFrame(frame);
  }, [route, view, routeBuilding]);

  useEffect(() => {
    const pending = warningAdvanceRef.current;
    if (!pending || !route || view !== "preview" || routeBuilding) return;
    warningAdvanceRef.current = null;
    const remaining = route.warnings.filter((warning) => warning.level === "warn");
    const activeIndex = pending.order.indexOf(pending.active);
    for (let offset = 1; offset <= pending.order.length; offset++) {
      const candidate = pending.order[(activeIndex + offset) % pending.order.length];
      const nextIndex = remaining.findIndex((warning) => `${warning.stopIndex}:${warning.message}` === candidate);
      if (nextIndex < 0) continue;
      setWarningCursor((nextIndex + 1) % remaining.length);
      scrollRestoreRef.current = null;
      const frame = requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-route-warning="${nextIndex}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return () => cancelAnimationFrame(frame);
    }
    scrollRestoreRef.current = null;
    if (remaining.length > 0) {
      setWarningCursor(remaining.length === 1 ? 0 : 1);
      const frame = requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-route-warning="0"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return () => cancelAnimationFrame(frame);
    }
    // The rebuild cleared every remaining issue.
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [route, view, routeBuilding]);

  function openNew() {
    setEditingId(null);
    setDraftId(newId());
    setDraftActive(true);
    setDirectionMapStop(null);
    setText("");
    setSheet(emptySheet());
    setRoute(null);
    setEditWarnings([]);
    setMapData(null);
    setOverrides({});
    setPick(null);
    setTapMode(null);
    setError("");
    setStatus("");
    setView("edit");
  }

  function openEdit(run: SavedRun) {
    setEditingId(run.id);
    setDraftId(`run-${run.id}`);
    setDraftActive(true);
    setDirectionMapStop(null);
    setText(run.sheetText);
    setArea(run.area || area);
    const parsed = parseSheet(run.sheetText);
    setSheet(parsed.stops.length ? parsed : emptySheet());
    setRoute(null);
    setEditWarnings((run.warnings ?? []).flatMap((w) => {
      if (w.level !== "warn") return [];
      if (typeof w.stopIndex === "number" && typeof w.maneuverIndex === "number") {
        return [{ level: "warn" as const, stopIndex: w.stopIndex, maneuverIndex: w.maneuverIndex, message: w.message }];
      }
      // Older saved runs stored the warning text without its direction indexes.
      const needle = w.message.toLocaleLowerCase();
      const match = parsed.stops.flatMap((stop, stopIndex) => stop.maneuvers.map((maneuver, maneuverIndex) => ({ stopIndex, maneuverIndex, street: maneuver.street })))
        .find((item) => item.street.trim() && needle.includes(item.street.trim().toLocaleLowerCase()));
      return match ? [{ level: "warn" as const, stopIndex: match.stopIndex, maneuverIndex: match.maneuverIndex, message: w.message }] : [];
    }));
    setMapData(null);
    setOverrides({ vias: run.vias ?? [] });
    setError("");
    setView("edit");
  }

  function saveDraftAndBack() {
    if (reviewTrip) {
      backToTrips();
      return;
    }
    if (draftActive && (sheet.stops.length > 0 || text.trim())) {
      const draft: EditorDraft = {
        id: draftId || newId(), editingId, text, sheet, area, overrides,
        warnings: editWarnings, updatedAt: Date.now(),
      };
      setDrafts((prev) => [draft, ...prev.filter((item) => item.id !== draft.id)]);
      setDraftId(draft.id);
      setDraftActive(false);
    }
    setView("day");
    window.scrollTo(0, 0);
  }

  function goHome() {
    if (view === "edit" || view === "preview") {
      if (reviewKey) {
        backToTrips();
        setView("day");
      } else {
        saveDraftAndBack();
      }
      return;
    }
    setView("day");
    window.scrollTo(0, 0);
  }

  function resumeDraft(draft: EditorDraft) {
    setDrafts((prev) => prev.filter((item) => item.id !== draft.id));
    setDraftId(draft.id);
    setDraftActive(true);
    setEditingId(draft.editingId);
    setText(draft.text);
    setSheet(draft.sheet);
    setArea(draft.area);
    setOverrides(draft.overrides);
    setEditWarnings(draft.warnings);
    setRoute(null);
    setMapData(null);
    setWarningFix(null);
    setDirectionMapStop(null);
    setError("");
    setStatus("");
    setView("edit");
    window.scrollTo(0, 0);
  }

  function discardDraft(draft: EditorDraft) {
    if (!window.confirm("Discard this unfinished trip-sheet draft? This cannot be undone.")) return;
    setDrafts((prev) => prev.filter((item) => item.id !== draft.id));
  }

  /** Text from photos or a paste: one run goes to the editor, several to the review list. */
  function takeText(reads: PageRead[], note = ""): boolean {
    const all = reads.flatMap((r) => splitRuns(r.text).map((text) => ({ ...r, text }))).map(describePage);
    const { pages: read, dropped } = dropDuplicatePages(all);
    const dupNote = dropped.length
      ? `Photo ${[...new Set(dropped.map((p) => p.photo + 1))].join(", ")} is the same page as another photo, so it was used once.`
      : "";
    const keys = autoGroup(read);
    const found = buildTrips(read, keys);
    if (found.length > 1) {
      setPages(read);
      setPageKeys(keys);
      setTripStates({});
      setTripEdits({});
      setReviewKey(null);
      setFixing(false);
      setView("review");
      setError([note, dupNote].filter(Boolean).join(" "));
      return true;
    }
    return false;
  }

  function readPasted() {
    if (!takeText([{ photo: -1, name: "Pasted text", text }])) applyText(text);
  }

  function applyText(raw: string) {
    setText(raw);
    const parsed = sortStopsByTime(parseSheet(raw));
    if (!parsed.stops.length) {
      setError("No stops were found in that text. Check the times and street lines, then try again.");
      return;
    }
    setError("");
    setSheet(parsed);
  }

  async function onPhotos(input: HTMLInputElement) {
    const picked = input.files ? Array.from(input.files) : [];
    // Let the same photo be picked again after a retake.
    input.value = "";
    if (!picked.length) return;
    setError("");
    const files: File[] = [];
    try {
      for (const file of picked) {
        if (isPdf(file)) files.push(...(await pdfToPageImages(file, setStatus)));
        else files.push(file);
      }
    } catch (err) {
      setStatus("");
      setError(err instanceof Error ? err.message : "Couldn't open that PDF.");
      return;
    }
    if (!files.length) return;
    let results: Awaited<ReturnType<typeof readSheetPhotos>> = [];
    try {
      results = await readSheetPhotos(files, setStatus);
    } catch {
      setStatus("");
      setError("The text reader didn't load. Check the internet connection and try again, or type the directions.");
      return;
    }
    setStatus("");
    const good = results.flatMap((r, i) => (r.ok ? [{ photo: i, name: r.name, text: r.text, thumb: r.thumb }] : []));
    const bad = results.flatMap((r, i) => (r.ok ? [] : [{ photo: i, reason: r.reason }]));
    const badNote = bad.length
      ? results.length === 1
        ? bad[0].reason
        : `Couldn't read ${bad.map((b) => results[b.photo]?.name || `page ${b.photo + 1}`).join(", ")}. ${RETAKE_MESSAGE.replace("Couldn't read this photo. ", "")}`
      : "";
    if (takeText(good, badNote)) return;
    if (good.length) {
      // One run: put its pages in order (first page before the continuation).
      const read = good.map(describePage);
      const one = buildTrips(read, autoGroup(read))[0];
      applyText([text, one?.text ?? ""].filter(Boolean).join("\n"));
    }
    if (badNote) setError(badNote);
  }

  function movePage(page: PageInfo, key: string) {
    const at = pages.indexOf(page);
    const from = pageKeys[at];
    const target = key === "new" ? newTripKey(pageKeys) : key;
    setPageKeys(pageKeys.map((k, i) => (i === at ? target : k)));
    // Both trips change, so fixes typed into either are read again from the pages.
    setTripEdits((prev) => {
      const next = { ...prev };
      delete next[from];
      delete next[target];
      return next;
    });
    setTripStates({});
    if (reviewKey === from) setReviewKey(null);
  }

  function savedRunFrom(id: string, sheetText: string, built: Sheet, result: RouteSuccess, vias: { lat: number; lon: number; street?: string }[] = []): SavedRun {
    return {
      id,
      area,
      sheetText: sheetText || prettyText(built),
      route: built.route,
      description: built.description,
      run: built.run,
      firstTime: built.stops.find((s) => s.time)?.time ?? "",
      miles: result.miles,
      gpx: result.gpx,
      coords: result.coords,
      stops: result.stops.map((s) => ({ time: s.time, description: s.description, lat: s.lat, lon: s.lon })),
      warnings: result.warnings.map((w) => ({ ...w })),
      vias,
    };
  }

  async function buildAllTrips() {
    setError("");
    const added: SavedRun[] = [];
    let failed = 0;
    const states: Record<string, TripState> = {};
    for (const [i, trip] of trips.entries()) {
      if (tripStates[trip.key]?.state === "added") continue;
      const prefix = `Trip ${i + 1} of ${trips.length}`;
      states[trip.key] = { state: "building" };
      setTripStates({ ...tripStates, ...states });
      setStatus(`${prefix}: building…`);
      try {
        const edit = tripEdits[trip.key];
        const tripSheet = edit?.sheet ?? trip.sheet;
        if (!tripSheet.stops.length) throw new Error("No stops were read from these photos.");
        // A trip opened and fixed keeps the map it was checked on, with any names looked up.
        const data = edit?.map ?? (await cachedMap(tripSheet, area, (s) => setStatus(`${prefix}: ${s}`)));
        const result = await routeSheet(tripSheet, data, {}, osrmRouter);
        if (!result.ok) throw new Error(result.error);
        added.push(savedRunFrom(newId(), edit ? prettyText(tripSheet) : trip.text, tripSheet, result));
        states[trip.key] = { state: "added" };
      } catch (err) {
        failed++;
        states[trip.key] = { state: "failed", message: err instanceof Error ? err.message : "The route could not be built." };
      }
      setTripStates({ ...tripStates, ...states });
    }
    setStatus("");
    if (added.length) setRuns((prev) => mergeIntoDay(prev, added));
    if (!failed) {
      setPages([]);
      setPageKeys([]);
      setTripEdits({});
      setReviewKey(null);
      setView("day");
    } else {
      setError(`${failed} trip${failed > 1 ? "s" : ""} couldn't be built. Open ${failed > 1 ? "them" : "it"} to fix the directions.`);
    }
  }

  /** Open one trip's stops and directions from the review list, before or after building. */
  function openTrip(trip: Trip) {
    const edit = tripEdits[trip.key];
    setEditingId(null);
    setDraftActive(false);
    setReviewKey(trip.key);
    setSuggestFor(null);
    setLookups({});
    setUndo(null);
    setText(edit?.text ?? trip.text);
    setSheet(edit?.sheet ?? trip.sheet);
    setRoute(null);
    setMapData(edit?.map ?? null);
    if (edit?.map) setLoadedArea(area);
    setOverrides({});
    setError("");
    setView("edit");
    window.scrollTo(0, 0);
  }

  /** Keep the fixes made to an opened trip and go back to the list. */
  function backToTrips() {
    if (reviewKey) setTripEdits((prev) => ({ ...prev, [reviewKey]: { text, sheet, map: mapData && loadedArea === area ? mapData : undefined } }));
    setReviewKey(null);
    setRoute(null);
    setView("review");
    window.scrollTo(0, 0);
  }

  function updateManeuver(si: number, mi: number, patch: Partial<Maneuver>) {
    setSheet((prev) => {
      const stops = prev.stops.map((stop, i) =>
        i === si
          ? { ...stop, maneuvers: stop.maneuvers.map((m, j) => (j === mi ? { ...m, ...patch } : m)) }
          : stop,
      );
      return { ...prev, stops };
    });
  }

  async function generate(nextOverrides = overrides, requestedSheet = sheet) {
    setError("");
    let current = requestedSheet;
    if (!current.stops.length && text.trim()) {
      // Pasted text that was never read: read it now.
      const parsed = parseSheet(text);
      if (parsed.stops.length) {
        current = parsed;
        setSheet(parsed);
      }
    }
    if (!current.stops.length) {
      setError("Add at least one stop before building the route.");
      return;
    }
    if (!warningAdvanceRef.current) setWarningCursor(0);
    setRouteBuilding(true);
    setStatus("Building the route…");
    try {
      const data = mapData && loadedArea === area ? mapData : await cachedMap(current, area, setStatus);
      setMapData(data);
      setLoadedArea(area);
      setStatus("Following the printed streets…");
      const result = await routeSheet(current, data, nextOverrides, osrmRouter);
      if (!result.ok) {
        warningAdvanceRef.current = null;
        setError(result.error);
        setStatus("");
        return;
      }
      setRoute(result);
      setWarningAcknowledged(false);
      setOverrides({
        ...nextOverrides,
        vias: (nextOverrides.vias ?? []).map((v, i) => {
          const street = result.viaStreets[i] || v.street;
          return street ? { lat: v.lat, lon: v.lon, street } : { lat: v.lat, lon: v.lon };
        }),
      });
      setView("preview");
      setStatus("");
    } catch (err) {
      scrollRestoreRef.current = null;
      warningAdvanceRef.current = null;
      setError(err instanceof Error ? err.message : "The route could not be built.");
      setStatus("");
    } finally {
      setRouteBuilding(false);
      setStatus("");
    }
  }

  function focusWarning(stopIndex: number, message: string, street?: string) {
    const stop = route?.stops.find((s) => s.index === stopIndex);
    if (!stop) return;
    queueWarningAdvance(stopIndex, undefined, message);
    setMapFocus({ lat: stop.lat, lon: stop.lon, key: ++mapFocusKey.current });
    setMapFixContext({ stopIndex, message, street });
    setTapMode("via");
    document.querySelector("[data-route-map]")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function editWarning(stopIndex: number, maneuverIndex: number) {
    const maneuver = sheet.stops[stopIndex]?.maneuvers[maneuverIndex];
    if (!maneuver) return;
    queueWarningAdvance(stopIndex, maneuverIndex);
    setTapMode(null);
    setMapFixContext(null);
    setWarningFix({ stopIndex, maneuverIndex, kind: maneuver.kind, street: maneuver.street });
    requestAnimationFrame(() => document.querySelector(`[data-stop-row="${stopIndex}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  function queueWarningAdvance(stopIndex: number, maneuverIndex?: number, message?: string) {
    const warnings = route?.warnings.filter((warning) => warning.level === "warn") ?? [];
    const active = warnings.find((warning) => warning.stopIndex === stopIndex &&
      (maneuverIndex === undefined || warning.maneuverIndex === maneuverIndex) &&
      (message === undefined || warning.message === message));
    if (!active) return;
    warningAdvanceRef.current = {
      order: warnings.map((warning) => `${warning.stopIndex}:${warning.message}`),
      active: `${active.stopIndex}:${active.message}`,
    };
  }

  function rebuildWarningFix() {
    if (!warningFix) return;
    const nextSheet: Sheet = {
      ...sheet,
      stops: sheet.stops.map((stop, si) => si !== warningFix.stopIndex ? stop : {
        ...stop,
        maneuvers: stop.maneuvers.map((maneuver, mi) => mi !== warningFix.maneuverIndex ? maneuver : {
          ...maneuver,
          kind: warningFix.kind,
          street: warningFix.street.trim(),
        }),
      }),
    };
    setSheet(nextSheet);
    setWarningFix(null);
    setTapMode(null);
    setMapFixContext(null);
    scrollRestoreRef.current = window.scrollY;
    void generate(overrides, nextSheet);
  }

  function deleteWarningDirection() {
    if (!warningFix) return;
    const removed = sheet.stops[warningFix.stopIndex]?.maneuvers[warningFix.maneuverIndex];
    if (!removed) return;
    const nextSheet: Sheet = {
      ...sheet,
      stops: sheet.stops.map((stop, si) => si !== warningFix.stopIndex ? stop : {
        ...stop,
        maneuvers: stop.maneuvers.filter((_, mi) => mi !== warningFix.maneuverIndex),
      }),
    };
    setSheet(nextSheet);
    setWarningFix(null);
    setTapMode(null);
    setMapFixContext(null);
    setUndo({ type: "direction", stopIndex: warningFix.stopIndex, maneuver: removed, at: warningFix.maneuverIndex, rebuild: true });
    scrollRestoreRef.current = window.scrollY;
    void generate(overrides, nextSheet);
  }

  function renderUndoToast() {
    if (!undo) return null;
    const bottom = view === "preview" ? "bottom-[13rem]" : "bottom-20";
    return (
      <div className={`fixed inset-x-0 ${bottom} z-[1300] px-3`} role="status">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 rounded-xl bg-[#142033] px-3 py-2 text-sm text-white shadow-lg">
          <span>{undo.type === "stop" ? "Stop deleted." : "Direction deleted."}</span>
          <button type="button" className="h-9 rounded-lg bg-[#f5c451] px-3 font-semibold text-[#142033]" onClick={undoDelete}>Undo</button>
        </div>
      </div>
    );
  }

  function renderGpxNotice() {
    if (!gpxNotice) return null;
    const bottom = view === "day" || view === "preview" ? "bottom-[16rem]" : "bottom-20";
    const names = gpxNotice.files.length <= 2
      ? gpxNotice.files.map((file) => file.name).join(" · ")
      : `${gpxNotice.files.slice(0, 2).map((file) => file.name).join(" · ")} · +${gpxNotice.files.length - 2} more`;
    const heading = gpxNotice.state === "ready" ? "GPX ready"
      : gpxNotice.state === "sharing" ? "Preparing GPX…"
        : gpxNotice.state === "downloaded" ? "GPX downloaded"
          : gpxNotice.state === "cancelled" ? "Sharing cancelled"
            : "GPX sent";
    const message = gpxNotice.state === "ready"
      ? "The run is on today’s list. Share it to open in OsmAnd or save it to Files."
      : gpxNotice.state === "sharing"
        ? "Opening the phone’s share options…"
        : gpxNotice.state === "downloaded"
          ? "Find the file in Downloads or Files, then open it with OsmAnd."
          : gpxNotice.state === "cancelled"
            ? gpxNotice.source === "single" ? "The route is still available; you can share it again." : "Your run is still saved in today’s list."
            : "Choose OsmAnd to open the track, or Save to Files for later.";
    return (
      <div className={`fixed inset-x-0 ${bottom} z-[1300] px-3`} role="status" aria-live="polite">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 rounded-xl border border-[#cbd9eb] bg-white p-3 text-[#17243a] shadow-xl">
          <div className="min-w-0">
            <p className="text-sm font-bold">{heading}</p>
            <p className="truncate text-xs font-medium text-[#315d8c]">{names}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-[#53627a]">{message}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {(gpxNotice.state === "ready" || gpxNotice.state === "cancelled") && (
              <Button type="button" className="h-9 bg-[#173b64] px-2.5 text-xs font-semibold text-white" onClick={shareGpxNotice}>
                {gpxNotice.state === "ready" ? "Share / open" : "Try again"}
              </Button>
            )}
            {gpxNotice.state === "sharing" && <LoaderCircle aria-label="Preparing GPX" className="h-5 w-5 animate-spin text-[#315d8c]" />}
            <button type="button" className="h-8 w-8 rounded-lg text-sm text-[#53627a] hover:bg-[#edf3fa]" aria-label="Dismiss GPX message" onClick={() => setGpxNotice(null)}>×</button>
          </div>
        </div>
      </div>
    );
  }

  function renderWarnings() {
    if (!route) return null;
    const issueCount = route.warnings.filter((warning) => warning.level === "warn").length;
    let issueIndex = 0;
    return (
      <section aria-label="Route issues" className="space-y-2">
        {issueCount > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-[#f0d28d] bg-[#fff9ea] px-3 py-2">
            <p className="text-sm font-semibold text-[#68470b]">{issueCount} {issueCount === 1 ? "issue" : "issues"} to review</p>
            <Button type="button" variant="outline" className="h-8 shrink-0 border-[#e5c981] bg-white px-2.5 text-xs font-semibold text-[#68470b]" onClick={() => {
              const target = warningCursor % issueCount;
              document.querySelector<HTMLElement>(`[data-route-warning="${target}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              setWarningCursor((current) => (current + 1) % issueCount);
            }}>
              Next issue {warningCursor % issueCount + 1}/{issueCount}
            </Button>
          </div>
        )}
        {route.warnings.map((w, i) => {
          const warningIndex = w.level === "warn" ? issueIndex++ : undefined;
          const stop = route.stops.find((s) => s.index === w.stopIndex);
          const destinationWarning = w.message.startsWith("Couldn't reach the last stop");
          const maneuver = destinationWarning ? undefined : sheet.stops[w.stopIndex]?.maneuvers[w.maneuverIndex];
          return (
            <div key={`${i}-${w.stopIndex}-${w.maneuverIndex}`} data-route-warning={warningIndex} className={`rounded-lg p-3 text-sm ${w.level === "warn" ? "bg-[#ffedd5]" : "bg-white ring-1 ring-[#d9d2c3]"}`}>
              <p>{w.message}</p>
              {w.level === "warn" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {stop && <Button type="button" variant="outline" className="h-10 bg-white" onClick={() => focusWarning(w.stopIndex, w.message, maneuver?.street)}>Guide on map</Button>}
                  {maneuver && <Button type="button" variant="outline" className="h-10 bg-white" onClick={() => editWarning(w.stopIndex, w.maneuverIndex)}>Edit direction</Button>}
                </div>
              )}
            </div>
          );
        })}
      </section>
    );
  }

  function onMapClick(lat: number, lon: number) {
    if (!route || !tapMode || status) return;
    if (tapMode === "turn" && pick) {
      const next = { ...overrides, turnarounds: { ...overrides.turnarounds, [pick]: { lat, lon } } };
      setTapMode(null);
      setPick(null);
      scrollRestoreRef.current = window.scrollY;
      void generate(next);
      return;
    }
    if (tapMode === "via") {
      const vias = [...(overrides.vias ?? []), { lat, lon }];
      const next = { ...overrides, vias };
      setOverrides(next);
      setTapMode(null);
      setMapFixContext(null);
      scrollRestoreRef.current = window.scrollY;
      void generate(next);
    }
  }

  function saveToDay() {
    if (!route || exportLock.current) return;
    if (editingLockedRun) {
      setError("This GPX is locked. Return to today’s list and unlock it before replacing the saved track.");
      return;
    }
    const saved = savedRunFrom(editingId ?? newId(), text, sheet, route, overrides.vias ?? []);
    const willFinishReview = !reviewKey || trips.every((trip) => trip.key === reviewKey || tripStates[trip.key]?.state === "added");
    const file = {
      name: runFileName(0, { run: saved.run, description: saved.description, firstTime: saved.firstTime }),
      text: saved.gpx,
    };
    const sentToPhone = sendNativeGpx([file], willFinishReview);
    setGpxNotice({ files: [file], title: file.name, source: "added", state: sentToPhone ? "shared" : "ready" });
    setMapRun(saved.id);
    if (reviewKey) {
      // Built from the review list: add it to the day by time and go back to the other trips.
      const key = reviewKey;
      const states = { ...tripStates, [key]: { state: "added" as const } };
      setRuns((prev) => mergeIntoDay(prev, [saved]));
      setTripStates(states);
      setTripEdits((prev) => ({ ...prev, [key]: { text, sheet } }));
      setReviewKey(null);
      setDraftActive(false);
      setView(trips.every((t) => states[t.key]?.state === "added") ? "day" : "review");
      return;
    }
    setRuns((prev) => {
      const idx = prev.findIndex((r) => r.id === saved.id);
      if (idx === -1) return [...prev, saved];
      const copy = prev.slice();
      copy[idx] = saved;
      return copy;
    });
    setDrafts((prev) => prev.filter((draft) => draft.id !== draftId));
    setDraftActive(false);
    setView("day");
  }

  function move(index: number, dir: -1 | 1) {
    if (exportLock.current) return;
    setRuns((prev) => {
      const j = index + dir;
      if (j < 0 || j >= prev.length) return prev;
      const copy = prev.slice();
      [copy[index], copy[j]] = [copy[j], copy[index]];
      return copy;
    });
  }

  function toggleRunLock(id: string) {
    if (exportLock.current) return;
    setRuns((prev) => prev.map((run) => run.id === id ? { ...run, locked: !run.locked } : run));
  }

  function removeRun(run: SavedRun) {
    if (run.locked || exportLock.current) return;
    const label = [run.route, run.run].filter(Boolean).join(" ") || "this GPX";
    if (!window.confirm(`Remove ${label} from today’s list? This also deletes its saved GPX from this phone.`)) return;
    setRuns((prev) => prev.filter((item) => item.id !== run.id));
  }

  async function deliverGpx(files: TextFile[], title: string, source: GpxNotice["source"]) {
    setGpxNotice({ files, title, source, state: "sharing" });
    try {
      const result = await shareOrDownload(files, title);
      setGpxNotice({ files, title, source, state: result });
    } catch (err) {
      setGpxNotice(null);
      setError(err instanceof Error ? err.message : "The GPX could not be shared or downloaded.");
    }
  }

  function shareGpxNotice() {
    if (!gpxNotice || gpxNotice.state === "sharing") return;
    void deliverGpx(gpxNotice.files, gpxNotice.title, gpxNotice.source);
  }

  function shareCurrentRoute() {
    if (!route) return;
    const name = runFileName(0, { run: sheet.run, description: sheet.description, firstTime: sheet.stops[0]?.time ?? "" });
    void deliverGpx([{ name, text: buildGpx(sheet, route.coords, route.stops) }], name, "single");
  }

  async function shareAll() {
    if (!runs.length) return;
    if (!confirmDayOrder()) return;
    setError("");
    const used = new Set<string>();
    const files = runs.map((run, i) => ({ name: gpxFileName(run.run, i, used), text: run.gpx }));
    await deliverGpx(files, `${files.length} runs`, "all");
  }

  async function exportDay() {
    if (!runs.length || exportLock.current) return;
    exportLock.current = true;
    setExportingDay(true);
    const exportRuns = [...runs];
    setError("");
    try {
      const deadheads: DeadheadLeg[] = [];
      for (let i = 0; i < exportRuns.length - 1; i++) {
        const a = exportRuns[i].coords.at(-1);
        const b = exportRuns[i + 1].coords[0];
        if (!a || !b) {
          deadheads.push({ coords: [], routed: false });
          continue;
        }
        setStatus(`Driving the deadhead from run ${i + 1} to run ${i + 2}…`);
        try {
          const corridor = await loadCorridor(a, b, setStatus);
          const driven = driveBetween(corridor.lines, a, b);
          deadheads.push(driven ? { coords: driven.coords, routed: true } : { coords: [a, b], routed: false });
        } catch {
          deadheads.push({ coords: [a, b], routed: false });
        }
      }
      setStatus("");
      if (!confirmDayOrder(deadheads, exportRuns)) return;
      const gpx = buildDayGpx(exportRuns, deadheads);
      const name = `day_${exportRuns.length}_runs.gpx`;
      await deliverGpx([{ name, text: gpx }], name, "day");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The day’s GPX could not be built.");
    } finally {
      setStatus("");
      exportLock.current = false;
      setExportingDay(false);
    }
  }

  function confirmDayOrder(deadheads?: DeadheadLeg[], snapshot = runs) {
    if (!snapshot.length) return false;
    const review = snapshot.map((run, i) => {
      const warningCount = run.warnings.filter((w) => w.level === "warn").length;
      return `${i + 1}. ${run.route || "Route"} ${run.run || ""} — ${run.firstTime || "no time"}${warningCount ? ` — ${warningCount} route warning${warningCount === 1 ? "" : "s"}` : ""}`;
    }).join("\n");
    const connections = deadheads?.map((leg, i) =>
      `Runs ${i + 1} → ${i + 2}: ${leg.routed ? "road route found" : "no road connection found; tracks remain separate"}`,
    ).join("\n");
    return window.confirm(`Review today’s GPX order before export:\n\n${review}${connections ? `\n\nBetween runs:\n${connections}` : ""}\n\nCheck any route warnings and verify the order and connections. Continue?`);
  }

  const previewStops = useMemo(
    () => route?.stops.map((s) => ({ lat: s.lat, lon: s.lon, label: `${s.time} ${s.description}` })) ?? [],
    [route],
  );
  const screenTitle = view === "day"
    ? "Today’s runs"
    : view === "review"
      ? "Review trip sheets"
      : view === "edit"
        ? (sheet.route || sheet.run ? `Edit ${[sheet.route, sheet.run].filter(Boolean).join(" ")}` : "Build a route")
        : "Check your route";

  if (!ready) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col bg-[#f3f5f8] text-[#17243a]">
        <header className="border-b border-[#d9e0ea] bg-[#10233f] px-4 py-3 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#eec85c]">Trip Sheet GPX</p>
          <h1 className="mt-0.5 text-xl font-semibold leading-tight">Opening today’s runs</h1>
        </header>
        <section className="m-4 rounded-xl bg-white p-4 ring-1 ring-[#d9d2c3]" aria-live="polite">
          {loadError ? (
            <div role="alert">
              <p className="font-semibold">Couldn’t open today’s saved runs.</p>
              <p className="mt-1 text-sm">Your saved list has not been replaced. Check storage access and try again.</p>
              <Button type="button" className="mt-3 h-11 bg-[#0f2744] text-white" onClick={() => { setLoadError(false); setLoadAttempt((n) => n + 1); }}>
                Try again
              </Button>
            </div>
          ) : <p className="text-sm">Opening today’s list…</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col bg-[#f3f5f8] text-[#17243a]">
      <header className="border-b border-[#d9e0ea] bg-[#10233f] px-4 py-3 text-white shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {view !== "day" && (
              <button type="button" className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-white/25 bg-white/10 px-2.5 text-xs font-semibold text-white hover:bg-white/15" onClick={goHome} aria-label="Go to today’s runs">
                <House aria-hidden="true" className="h-4 w-4" /> Home
              </button>
            )}
            <div className="min-w-0">
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-[#eec85c]">Trip Sheet GPX</p>
              <h1 className="mt-0.5 truncate text-xl font-semibold leading-tight">{screenTitle}</h1>
            </div>
          </div>
          {view === "day" && runs.length > 0 && (
            <span className="shrink-0 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold text-white">{runs.length} {runs.length === 1 ? "run" : "runs"}</span>
          )}
        </div>
        <details className="mt-2 text-xs text-[#d6deea]">
          <summary className="w-fit cursor-pointer select-none rounded-md px-1 py-0.5 hover:bg-white/10">Privacy, route safety & app info</summary>
          <div className="mt-2 space-y-2 rounded-lg bg-white/10 p-3 leading-relaxed">
            <p>Photos and saved runs stay on this phone. Route lookup sends street names and approximate locations to public map and routing services. Building a route needs internet; downloaded GPX files work offline.</p>
            <p>Check the track against the trip sheet, one-way signs, and bus restrictions before driving.</p>
            {offerHomeScreenInstall && (
              <div>
                <button type="button" className="font-semibold text-white underline underline-offset-2" onClick={() => setShowInstallHelp((open) => !open)} aria-expanded={showInstallHelp}>
                  {showInstallHelp ? "Hide iPhone install steps" : "Add to iPhone Home Screen"}
                </button>
                {showInstallHelp && (
                  <ol className="mt-2 list-decimal space-y-1 pl-5">
                    <li>Open this page in Safari.</li>
                    <li>Tap Safari’s Share button.</li>
                    <li>Choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>
                  </ol>
                )}
              </div>
            )}
          </div>
        </details>
      </header>

      {!stored && <p className="bg-[#fff4d6] px-4 py-2 text-sm font-medium text-[#714b08]" role="alert">This phone couldn’t save the latest changes. Check storage before leaving this page.</p>}

      {status && <p className="bg-[#f5c451] px-4 py-2 text-sm font-medium text-[#142033]">{status}</p>}
      {error && (
        <p className="bg-[#7f1d1d] px-4 py-2 text-sm text-white" role="alert">
          {error}
        </p>
      )}

      {view === "day" && (
        <section className="flex flex-1 flex-col gap-3 px-4 py-5 pb-48 sm:px-6">
          {!ready && <p className="text-sm">Opening today’s list…</p>}
          {ready && runs.length === 0 && (
            <div className="rounded-2xl border border-[#e1e6ed] bg-white p-5 shadow-sm">
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-[#e8eff8] text-xl text-[#173b64]">＋</div>
              <p className="text-lg font-bold tracking-tight">Start with a trip sheet</p>
              <p className="mt-1 text-sm leading-relaxed text-[#586579]">Add photos, a PDF, or copied text. Check the stops and directions, then build a route you can save to OsmAnd.</p>
              <Button type="button" className="mt-4 h-11 bg-[#173b64] px-4 text-white" onClick={openNew}>Add your first run</Button>
            </div>
          )}
          {runs.length > 0 && (
            <div className="flex items-center justify-between gap-3 px-1 pb-1">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#68758a]">Today’s route list</p>
                <p className="text-lg font-bold tracking-tight">{runs.length} {runs.length === 1 ? "run" : "runs"} · {runs.reduce((sum, run) => sum + run.miles, 0).toFixed(1)} mi</p>
              </div>
              <div className="flex items-center gap-2">
                {runs.some((run) => run.warnings.some((warning) => warning.level === "warn")) && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 shrink-0 border-[#e7b85b] bg-[#fff7e5] px-3 text-xs font-semibold text-[#77500a]"
                    onClick={() => document.querySelector<HTMLElement>("[data-warning-run]")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  >
                    Check warnings
                  </Button>
                )}
              </div>
            </div>
          )}
          {draftsReady && drafts.length > 0 && (
            <section aria-label="Unfinished drafts" className="space-y-2">
              {drafts.map((draft) => {
                const title = [draft.sheet.route, draft.sheet.run].filter(Boolean).join(" ");
                return (
                  <article key={draft.id} className="rounded-xl border border-[#d9d2c3] bg-[#fffaf0] p-3">
                    <p className="text-sm font-semibold">Unfinished work{title ? ` · ${title}` : ""}</p>
                    <p className="mt-1 text-xs text-[#3d4b63]">{draft.sheet.stops.length} stops · saved on this phone</p>
                    <div className="mt-2 flex gap-2">
                      <Button type="button" className="h-10 flex-1 bg-[#0f2744] text-white" onClick={() => resumeDraft(draft)}>Resume editing</Button>
                      <Button type="button" variant="outline" className="h-10 px-3 text-[#7f1d1d]" onClick={() => discardDraft(draft)}>Discard</Button>
                    </div>
                  </article>
                );
              })}
            </section>
          )}
          {runs.map((run, i) => {
            const warnings = run.warnings.filter((w) => w.level === "warn");
                return (
            <article key={run.id} data-warning-run={warnings.length ? "true" : undefined} className="rounded-2xl border border-[#dce3ec] bg-white p-3.5 shadow-[0_4px_14px_rgba(24,39,62,0.07)] transition-shadow hover:shadow-[0_7px_20px_rgba(24,39,62,0.1)]">
              <div className="flex items-start gap-3">
                <div className="flex shrink-0 flex-col items-center gap-1">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#173b64] text-sm font-bold text-white">{i + 1}</span>
                  <button type="button" className="h-7 w-8 rounded-md text-xs font-semibold text-[#53627a] hover:bg-[#eef2f7] disabled:opacity-30" onClick={() => move(i, -1)} disabled={exportingDay || i === 0} aria-label={`Move run ${i + 1} earlier`} title="Move earlier">↑</button>
                  <button type="button" className="h-7 w-8 rounded-md text-xs font-semibold text-[#53627a] hover:bg-[#eef2f7] disabled:opacity-30" onClick={() => move(i, 1)} disabled={exportingDay || i === runs.length - 1} aria-label={`Move run ${i + 1} later`} title="Move later">↓</button>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h2 className="text-lg font-bold leading-tight tracking-tight">{run.route || "Route"} {run.run && <span className="font-semibold text-[#53627a]">{run.run}</span>}</h2>
                    {run.locked && <span className="rounded-full bg-[#e7f3eb] px-2 py-0.5 text-[0.68rem] font-bold text-[#216338]">Protected</span>}
                    {!warnings.length && <span className="rounded-full bg-[#e7f3eb] px-2 py-0.5 text-[0.68rem] font-bold text-[#216338]">Ready to review</span>}
                  </div>
                  <p className="mt-0.5 truncate text-sm font-medium text-[#46546a]">{run.description || "Untitled sheet"}</p>
                  <p className="mt-1 text-xs font-medium text-[#68758a]">{run.firstTime} <span className="px-1 text-[#a5afbd]">·</span> {run.miles.toFixed(2)} miles</p>
                </div>
              </div>
              {warnings.length > 0 && (
                <div className="mt-3 rounded-xl border border-[#f0d28d] border-l-4 border-l-[#d28b16] bg-[#fff9ea] p-3" role="alert">
                  <p className="text-xs font-bold uppercase tracking-wide text-[#80540b]">Needs a quick check · {warnings.length} {warnings.length === 1 ? "issue" : "issues"}</p>
                  <p className="mt-1 text-sm leading-relaxed text-[#463716]">{warnings[0].message}</p>
                  {warnings.length > 1 && (
                    <details className="mt-1 text-sm">
                      <summary className="cursor-pointer font-medium">Show {warnings.length - 1} more</summary>
                      <ul className="mt-1 list-disc space-y-1 pl-5">
                        {warnings.slice(1).map((warning, n) => <li key={n}>{warning.message}</li>)}
                      </ul>
                    </details>
                  )}
                  <Button type="button" variant="outline" className="mt-2 h-9 border-[#e5c981] bg-white px-3 text-sm font-semibold text-[#68470b]" onClick={() => openEdit(run)} disabled={exportingDay}>Review this route</Button>
                </div>
              )}
              {(run.vias?.length ?? 0) > 0 && (
                <p className="mt-2 text-sm text-[#3d4b63]">
                  {run.vias?.map((v, n) => v.street || `Waypoint ${n + 1}`).join(", ")}
                </p>
              )}
              {mapRun === run.id && run.coords.length > 1 && (
                <div className="mt-2">
                  <RouteMap
                    coords={run.coords}
                    stops={run.stops.map((s) => ({ lat: s.lat, lon: s.lon, label: `${s.time} ${s.description}` }))}
                    turnarounds={[]}
                    vias={run.vias ?? []}
                  />
                  <p className="mt-1 text-sm text-[#3d4b63]">Blue dots are via points. The dark line bends through each one, then returns to the printed streets.</p>
                </div>
              )}
              <div className="mt-3 grid grid-cols-3 gap-1.5 border-t border-[#edf0f4] pt-2.5">
                <Button type="button" variant="outline" className="h-9 border-[#dce3ed] bg-[#f8fafc] text-xs font-semibold text-[#34445c]" onClick={() => setMapRun(mapRun === run.id ? null : run.id)} disabled={run.coords.length < 2}>
                  {mapRun === run.id ? "Hide map" : "Map"}
                </Button>
                <Button type="button" variant="outline" className="h-9 border-[#dce3ed] bg-[#f8fafc] text-xs font-semibold text-[#34445c]" onClick={() => openEdit(run)} disabled={exportingDay}>
                  Edit
                </Button>
                <Button type="button" variant="outline" className="h-9 border-[#dce3ed] bg-[#f8fafc] text-xs font-semibold text-[#34445c]" onClick={() => void deliverGpx([{ name: runFileName(i, run), text: run.gpx }], runFileName(i, run), "single")}>
                  Download
                </Button>
              </div>
              <details className="mt-2 border-t border-[#edf0f4] pt-2">
                <summary className="w-fit cursor-pointer select-none text-xs font-semibold text-[#68758a]">More options</summary>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" className={`h-8 px-2.5 text-xs ${run.locked ? "border-[#abd0b5] bg-[#f0f8f2] text-[#216338]" : "border-[#dce3ed] bg-white text-[#34445c]"}`} onClick={() => toggleRunLock(run.id)} disabled={exportingDay} aria-pressed={!!run.locked}>
                    {run.locked ? "Unlock GPX" : "Protect GPX"}
                  </Button>
                  <Button type="button" variant="destructive" className="h-8 px-2.5 text-xs" onClick={() => removeRun(run)} disabled={exportingDay || !!run.locked}>
                    {run.locked ? "Protected from removal" : "Remove run"}
                  </Button>
                </div>
              </details>
            </article>
            );
          })}
          <div className="fixed inset-x-0 bottom-0 z-[1200] border-t border-[#dce3ec] bg-white p-3 shadow-[0_-8px_28px_rgba(24,39,62,0.12)]">
            <div className="mx-auto flex max-w-2xl flex-col gap-2">
              <Button type="button" className="h-11 rounded-xl bg-[#173b64] text-sm font-bold text-white shadow-sm" onClick={openNew} disabled={exportingDay}>
                Add a run
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" className="h-10 rounded-xl border-[#dce3ec] bg-[#f8fafc] text-xs font-semibold" disabled={!runs.length || exportingDay} onClick={() => void exportDay()}>
                  {exportingDay ? "Preparing day GPX…" : "One GPX for the day"}
                </Button>
                <Button type="button" variant="outline" className="h-10 rounded-xl border-[#dce3ec] bg-[#f8fafc] text-xs font-semibold" disabled={!runs.length || exportingDay} onClick={() => void shareAll()}>
                  {canShare ? "Share all" : "Download all"}
                </Button>
              </div>
              <p className="text-center text-xs leading-relaxed text-[#3d4b63]">One GPX combines runs in this order. Share all sends a separate file for each run.</p>
            </div>
          </div>
        </section>
      )}

      {view === "review" && (
        <section className="flex flex-col gap-3 px-4 py-5 pb-36 sm:px-6">
          <div className="rounded-2xl border border-[#dce3ec] bg-gradient-to-br from-white to-[#edf3fa] p-4 shadow-sm">
            <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[#718097]">Recognized trip sheets</p>
            <p className="mt-1 text-xl font-bold tracking-tight">{trips.length} {trips.length === 1 ? "trip" : "trips"} found</p>
            <p className="mt-1 text-sm text-[#586579]">Open each trip to check its stops and directions before building the route.</p>
          </div>
          <ul className="space-y-2.5">
            {trips.map((trip) => {
              const st = tripStates[trip.key];
              const edited = !!tripEdits[trip.key];
              const shown = tripEdits[trip.key]?.sheet;
              const stops = shown ? shown.stops.length : trip.stops;
              const turns = shown ? shown.stops.reduce((n, x) => n + x.maneuvers.length, 0) : trip.turns;
              return (
                <li key={trip.key} data-trip={trip.run || trip.key}>
                  <button
                    type="button"
                    className="block w-full touch-manipulation rounded-2xl border border-[#dce3ec] bg-white p-3.5 text-left shadow-[0_3px_12px_rgba(24,39,62,0.06)] transition-shadow active:bg-[#f5f8fc] active:shadow-sm"
                    onClick={() => openTrip(trip)}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-lg font-semibold">Run {trip.run || "?"}</span>
                      <span className="text-base">{trip.firstTime || "no time"} ›</span>
                    </span>
                    <span className="block text-sm text-[#3d4b63]">
                      {stops} stops · {turns} turns · {trip.pages.length === 1 ? "1 page" : `${trip.pages.length} pages`}
                      {edited ? " · fixed" : ""}
                      {st?.state === "building" ? " · building…" : st?.state === "added" ? " · added" : ""}
                    </span>
                    <PageThumbs pages={trip.pages} />
                    {st?.state === "failed" && <span className="mt-2 block text-sm text-[#7f1d1d]">{st.message} Tap to fix it.</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="h-11 touch-manipulation rounded-lg border border-[#d9d2c3] bg-white text-sm font-medium"
            aria-expanded={fixing}
            onClick={() => {
              const open = !fixing;
              setFixing(open);
              if (open) setTimeout(() => movePanel.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
            }}
          >
            {fixing ? "Done moving photos" : "A photo is in the wrong trip"}
          </button>
          {fixing && (
            <div ref={movePanel} className="scroll-mt-4 space-y-2 rounded-xl bg-white p-3 ring-1 ring-[#d9d2c3]" data-move-panel>
              <p className="text-sm">Pick the trip each photo belongs to.</p>
              {pages.map((p, i) => (
                <div key={i} className="flex items-center gap-2" data-move-page={i}>
                  {p.thumb ? (
                    <button type="button" className="shrink-0" aria-label="Show this photo bigger" onClick={() => setBigThumb(p.thumb ?? null)}>
                      <img src={p.thumb} alt="" className="h-16 w-12 rounded object-cover object-top ring-1 ring-[#d9d2c3]" />
                    </button>
                  ) : null}
                  <span className="min-w-0 flex-1 text-sm">
                    {p.photo < 0 ? p.name : `Photo ${p.photo + 1}`}
                    <span className="block text-[#3d4b63]">{pageTimes(p)}</span>
                  </span>
                  <select
                    className="h-11 rounded-lg border border-[#d9d2c3] bg-white px-2 text-base"
                    aria-label={`Trip for ${p.photo < 0 ? p.name : `photo ${p.photo + 1}`}`}
                    value={pageKeys[i]}
                    onChange={(e) => movePage(p, e.target.value)}
                  >
                    {trips.map((t) => (
                      <option key={t.key} value={t.key}>
                        Run {t.run || "?"}
                      </option>
                    ))}
                    <option value="new">New trip</option>
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="fixed inset-x-0 bottom-0 z-[1200] border-t border-[#dce3ec] bg-white p-3 shadow-[0_-8px_28px_rgba(24,39,62,0.12)]">
            <div className="mx-auto flex max-w-lg flex-col gap-2">
              {status && <p className="text-sm font-medium">{status}</p>}
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="h-12 flex-1" onClick={() => setView("edit")}>
                  Back
                </Button>
                <Button type="button" className="h-12 flex-[2] bg-[#0f2744] text-base text-white disabled:opacity-100" disabled={!!status} onClick={() => void buildAllTrips()}>
                  {status ? "Building…" : `Build ${trips.filter((t) => tripStates[t.key]?.state !== "added").length} trips`}
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}

      {bigThumb && (
        <button type="button" className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/80 p-2" aria-label="Close the photo" onClick={() => setBigThumb(null)}>
          <img src={bigThumb} alt="The page as it was read" className="w-full max-w-lg rounded" />
        </button>
      )}

      {view === "edit" && (
        <section className="flex flex-col gap-3 px-3 py-4 pb-48 sm:px-5">
          {!reviewTrip && (
            <div className="rounded-2xl border border-[#dce3ec] bg-gradient-to-br from-white via-white to-[#edf3fa] px-4 py-3 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[#718097]">Trip sheet setup</p>
                  <p className="mt-0.5 text-base font-bold text-[#17243a]">Add a sheet, then check the details</p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  {sheet.stops.length > 0 && <span className="rounded-full bg-[#173b64] px-2.5 py-1 text-xs font-bold text-white">{sheet.stops.length} stops</span>}
                  {draftActive && hasDraftContent && (
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${draftIsSaved ? "bg-[#e7f3eb] text-[#216338]" : "bg-[#fff4d6] text-[#80540b]"}`}>
                      {draftIsSaved ? "Saved on this phone" : "Saving draft…"}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
          {reviewTrip && (
            <div className="rounded-xl bg-white p-3 ring-1 ring-[#d9d2c3]" data-trip-open={reviewTrip.run || reviewTrip.key}>
              <p className="text-lg font-semibold">
                Run {reviewTrip.run || "?"} · {reviewTrip.pages.length === 1 ? "1 page" : `${reviewTrip.pages.length} pages`}
              </p>
              <p className="text-sm text-[#3d4b63]">Street checks confirm the name is on the map. Route warnings below flag turn connections. Tap a red ? for close matches.</p>
              <PageThumbs pages={reviewTrip.pages} onOpen={setBigThumb} />
            </div>
          )}
          <Tucked
            away={!!reviewTrip || hasStops}
            summary={hasStops
              ? `Edit original scan & trip-sheet text · ${sheet.stops.length} stops`
              : "Original scan, sheet text & area"}
          >
          <label className="text-sm font-medium">
            Area
            <Input className="mt-1 h-9 bg-white text-sm" value={area} onChange={(e) => setArea(e.target.value)} />
          </label>
          {editWarnings.length > 0 && (
            <p className="rounded-lg border border-[#b93816] bg-[#fff7ed] px-3 py-2 text-sm text-[#7f1d1d]">
              A green street check confirms the name exists on the map. The route warning below means the turn connection needs review.
            </p>
          )}
          {!reviewTrip && pages.length > 0 && trips.length > 1 && (
            <Button type="button" variant="outline" className="h-11" onClick={() => setView("review")}>
              Back to the {trips.length} trips found
            </Button>
          )}
          {!reviewTrip && <div className="grid grid-cols-2 gap-2">
            <label className="flex h-12 cursor-pointer items-center justify-center rounded-lg bg-[#0f2744] text-sm font-medium text-white">
              Take photos
              <input className="sr-only" type="file" accept="image/*,.heic,.heif" capture="environment" multiple onChange={(e) => void onPhotos(e.currentTarget)} />
            </label>
            <label className="flex h-12 cursor-pointer items-center justify-center rounded-lg bg-white text-sm font-medium ring-1 ring-[#d9d2c3]">
              Photos or PDF
              <input className="sr-only" type="file" accept="image/*,.heic,.heif,application/pdf,.pdf" multiple onChange={(e) => void onPhotos(e.currentTarget)} />
            </label>
          </div>}
          <label className="text-sm font-medium">
            Sheet text
            <WrapField className="mt-1 font-mono" multiline value={text} label="Sheet text" placeholder="Paste the trip sheet, or it will fill in from the photos." onChange={setText} />
          </label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-9 flex-1 text-sm" onClick={readPasted}>
              Read the text
            </Button>
            {!reviewTrip && (
              <Button type="button" variant="outline" className="h-9 flex-1 text-sm" onClick={() => applyText(EXAMPLE_SHEET_TEXT)}>
                Load a fake example
              </Button>
            )}
          </div>
          </Tucked>
          {checkFailed && !streetIndex && sheet.stops.length > 0 && (
            <p className="flex items-center justify-between gap-2 rounded-lg bg-[#ffedd5] px-3 py-2 text-sm">
              Couldn’t check the street names right now.
              <Button type="button" variant="outline" className="h-10" onClick={() => setCheckFailed(false)}>
                Try again
              </Button>
            </p>
          )}
          {(overrides.vias?.length ?? 0) > 0 && (
            <div className="rounded-xl bg-[#dbeafe] p-3 ring-1 ring-[#93c5fd]" data-waypoints>
              <p className="text-base font-semibold">
                {overrides.vias?.length} waypoint{overrides.vias?.length === 1 ? "" : "s"} on this run
              </p>
              <p className="mt-1 text-sm text-[#1e3a8a]">Not a stop. The track bends through each one, and that bend is in the GPX. Build the route again after a change.</p>
              <ul className="mt-2 space-y-1">
                {overrides.vias?.map((via, i) => (
                  <li key={`${via.lat.toFixed(5)}-${via.lon.toFixed(5)}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-1">
                    <span className="min-w-0 text-base">Waypoint {i + 1}{via.street ? ` · ${via.street}` : ""}</span>
                    <button
                      type="button"
                      className="h-11 touch-manipulation rounded-lg px-3 text-base text-[#7f1d1d]"
                      aria-label={`Remove waypoint ${i + 1}`}
                      onClick={() => setOverrides({ ...overrides, vias: (overrides.vias ?? []).filter((_, j) => j !== i) })}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {sheet.stops.length > 0 && (
              <div className="space-y-1.5">
              <div className="grid grid-cols-2 gap-2">
                <Input className="h-9 bg-white text-sm" value={sheet.route} placeholder="Route" aria-label="Route" onChange={(e) => setSheet({ ...sheet, route: e.target.value })} />
                <Input className="h-9 bg-white text-sm" value={sheet.run} placeholder="Run" aria-label="Run" onChange={(e) => setSheet({ ...sheet, run: e.target.value })} />
              </div>
              <WrapField
                value={sheet.description}
                label="Description"
                placeholder="Description"
                onChange={(description) => setSheet({ ...sheet, description })}
              />
              {sheet.stops.map((stop, si) => {
                const stopCheck = stopState(stop.description);
                const sid = `stop-${si}`;
                return (
                  <div key={si} className="rounded-2xl border border-[#dce3ec] border-l-[3px] border-l-[#315d8c] bg-white p-3 shadow-[0_3px_12px_rgba(24,39,62,0.06)]" data-stop={si}>
                    <div className="mb-2 flex items-center justify-between gap-2 border-b border-[#ece7dc] pb-1.5">
                      <p className="rounded-full bg-[#e9eff7] px-2.5 py-1 text-xs font-bold tracking-wide text-[#0f2744]">STOP {si + 1}</p>
                      <button
                        type="button"
                        className="h-9 touch-manipulation rounded-lg border border-[#efd6d2] bg-[#fff8f6] px-2.5 text-sm font-medium text-[#8f2c1c]"
                        aria-label={`Delete stop ${si + 1}`}
                        onClick={() => deleteStop(si)}
                      >
                        Delete
                      </button>
                    </div>
                    <div className="flex items-end gap-2">
                      <Input className="h-9 w-28 shrink-0 bg-white text-sm" value={stop.time} aria-label="Stop time" onChange={(e) => setSheet({ ...sheet, stops: sheet.stops.map((s, i) => (i === si ? { ...s, time: e.target.value } : s)) })} />
                      <StreetMark state={stopCheck.state} open={suggestFor === sid} onTap={() => void tapMark(sid, stopCheck.missing)} />
                    </div>
                    <WrapField
                      className="mt-1 border-[#c9c1b2]"
                      value={stop.description}
                      label="Stop place"
                      placeholder="Stop intersection, school, or address"
                      onChange={(description) => setSheet({ ...sheet, stops: sheet.stops.map((s, i) => (i === si ? { ...s, description } : s)) })}
                      onBlur={() => void recheckSoon()}
                    />
                    {stopCheck.label && <p className="mt-1 text-xs text-[#15803d]">On the map: {stopCheck.label}</p>}
                    {suggestFor === sid && (
                      <SuggestPanel
                        names={stopCheck.missing}
                        looking={stopCheck.state === "looking"}
                        suggest={optionsFor}
                        onPick={(part, name) => {
                          setSheet({
                            ...sheet,
                            stops: sheet.stops.map((s, i) => (i === si ? { ...s, description: s.description.replace(part, name) } : s)),
                          });
                          setSuggestFor(null);
                        }}
                      />
                    )}
                    <div className="mb-1 mt-2 flex items-center gap-2">
                      <span className="text-[0.68rem] font-bold uppercase tracking-[0.12em] text-[#596579]">Directions</span>
                      <span className="h-px flex-1 bg-[#e3e8ef]" />
                    </div>
                    <ul className="space-y-2 rounded-xl bg-[#f4f7fb] p-2 ring-1 ring-inset ring-[#e7edf5]">
                      {stop.maneuvers.map((m, mi) => {
                        const st = streetState(m.street);
                        const mid = `${si}-${mi}`;
                        const warned = editWarnings.some((w) => w.stopIndex === si && w.maneuverIndex === mi);
                        const savedStop = editingRun?.stops[si];
                        const targetRoad = warned && savedStop && mapData && loadedArea === area
                          ? nearbyStreetLines(mapData.lines, st.label ?? m.street, savedStop.lat, savedStop.lon)
                          : null;
                        const nearbyTargetRoad = targetRoad && targetRoad.distance <= 0.015 ? targetRoad : null;
                        return (
                          <li key={mi} className="grid grid-cols-[9rem_1.75rem_1.9rem] items-center gap-1 rounded-lg border border-[#e1e7ef] bg-white p-1.5 shadow-[0_1px_2px_rgba(24,39,62,0.04)] sm:grid-cols-[9rem_minmax(0,1fr)_1.75rem_1.9rem]">
                              <div className="flex h-8 min-w-0 items-center rounded-md border border-[#cbd5e1] bg-[#f8fafc] pl-2 focus-within:ring-2 focus-within:ring-[#9bb4ff]">
                                <ManeuverArrow kind={m.kind} />
                                <select
                                  className="h-full min-w-0 flex-1 border-0 bg-transparent px-1 text-[13px] font-medium leading-tight text-[#17243a] outline-none"
                                  value={m.kind}
                                  aria-label="Direction"
                                  onChange={(e) => updateManeuver(si, mi, { kind: e.target.value as ManeuverKind })}
                                >
                                  {KINDS.map((k) => (
                                    <option key={k} value={k}>
                                      {KIND_LABEL[k]}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <WrapField
                                className="col-span-3 row-start-2 min-h-8 px-2 py-1 text-[13px] leading-tight sm:col-span-1 sm:row-auto"
                                value={m.street}
                                label="Street"
                                placeholder="Street name"
                                onChange={(street) => updateManeuver(si, mi, { street })}
                                onBlur={() => void recheckSoon()}
                              />
                              <div className="col-start-2 row-start-1 sm:col-auto sm:row-auto">
                                <StreetMark state={st.state} open={suggestFor === mid} onTap={() => void tapMark(mid, st.state === "found" ? [] : [m.street])} />
                              </div>
                              <button
                                type="button"
                                className="col-start-3 row-start-1 h-8 w-8 touch-manipulation rounded-md border border-[#edd5d2] bg-white text-xs text-[#8f2c1c] sm:col-auto sm:row-auto"
                                aria-label="Delete this direction"
                                onClick={() => deleteManeuver(si, mi)}
                              >
                                ✕
                              </button>
                            {st.label && <p className="col-span-3 px-1 text-[0.7rem] leading-tight text-[#15803d] sm:col-span-4">On the map: {st.label}</p>}
                            {editWarnings.filter((w) => w.stopIndex === si && w.maneuverIndex === mi).map((w, wi) => (
                              <div key={`route-warning-${wi}`} className="col-span-3 rounded-lg border border-[#f0c36d] bg-[#fff6e5] p-2.5 text-sm text-[#7f1d1d] sm:col-span-4">
                                <p role="alert">Route warning: {w.message}</p>
                                {editingRun && editingRun.coords.length > 1 && (
                                  <>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      className="mt-2 h-10 border-[#d9d2c3] bg-white text-[#142033]"
                                      aria-expanded={directionMapStop === si}
                                      onClick={() => {
                                        const opening = directionMapStop !== si;
                                        setDirectionMapStop(opening ? si : null);
                                        if (opening) requestAnimationFrame(() => document.querySelector("[data-direction-map]")?.scrollIntoView({ behavior: "smooth", block: "center" }));
                                      }}
                                    >
                                      {directionMapStop === si ? "Hide map" : `See stop ${si + 1} on map`}
                                    </Button>
                                    {directionMapStop === si && (
                                      <div className="mt-2 rounded-lg bg-white p-2" data-direction-map>
                                        <div className="mb-2 space-y-1 text-xs text-[#3d4b63]">
                                          <p><span className="font-semibold text-[#be123c]">Pink dashed lines:</span> map match for {m.street}</p>
                                          <p><span className="font-semibold text-[#0f2744]">Dark line:</span> saved route · <span className="font-semibold text-[#b91c1c]">Red ring:</span> this stop</p>
                                          {nearbyTargetRoad && canonicalKey(m.street).includes("GREEN LEVEL WEST")
                                            ? <p>Here the map labels this corridor High House Road; the trip sheet calls it Green Level West Road. Check that the highlighted road is the intended turn.</p>
                                            : nearbyTargetRoad && <p>Map labels can use another name for a shared road; the pink line is the routing data’s match for the trip-sheet name.</p>}
                                          {!mapData || loadedArea !== area
                                            ? <p>Loading street data…</p>
                                            : !nearbyTargetRoad && <p className="text-[#7f1d1d]">The named road isn’t in the local map data near this stop, so it can’t be highlighted. Zoom out to inspect nearby roads.</p>}
                                        </div>
                                        <RouteMap
                                          coords={editingRun.coords}
                                          stops={editingRun.stops.map((savedStop, stopIndex) => ({ lat: savedStop.lat, lon: savedStop.lon, label: `Stop ${stopIndex + 1}: ${savedStop.description}` }))}
                                          turnarounds={[]}
                                          warningStops={editingRun.stops[si] ? [{ lat: editingRun.stops[si].lat, lon: editingRun.stops[si].lon, label: `Check stop ${si + 1}` }] : []}
                                          highlightedLines={nearbyTargetRoad ? nearbyTargetRoad.lines.map((line) => line.coords) : []}
                                          focusArea={savedStop && nearbyTargetRoad ? [[savedStop.lon, savedStop.lat], nearbyTargetRoad.point] : undefined}
                                        />
                                        {savedStop && (
                                          <a
                                            className="mt-2 inline-flex min-h-10 items-center rounded-md border border-[#d9d2c3] px-3 text-sm font-medium text-[#142033] underline"
                                            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${m.street} near ${savedStop.description}, ${area}`)}`}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            Compare this road in Google Maps
                                          </a>
                                        )}
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            ))}
                            {suggestFor === mid && (
                              <SuggestPanel
                                names={st.state === "found" ? [] : [m.street]}
                                looking={st.state === "looking"}
                                suggest={optionsFor}
                                onPick={(_, name) => {
                                  updateManeuver(si, mi, { street: name });
                                  setSuggestFor(null);
                                }}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <Button
                      type="button"
                      variant="outline"
                              className="mt-1 h-8 border-dashed border-[#9aabc1] bg-[#f8fbff] px-2 text-xs text-[#173b64]"
                      onClick={() =>
                        setSheet({
                          ...sheet,
                          stops: sheet.stops.map((s, i) => (i === si ? { ...s, maneuvers: [...s.maneuvers, { kind: "right", street: "" }] } : s)),
                        })
                      }
                    >
                      Add a direction
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          {renderUndoToast()}
          <div className="fixed inset-x-0 bottom-0 z-[1200] border-t border-[#dce3ec] bg-white p-3 shadow-[0_-8px_28px_rgba(24,39,62,0.12)]">
            <div className="mx-auto flex max-w-2xl flex-col gap-2">
              {routeBuilding ? <RouteBuildStatus message={status} /> : status && <p className="text-sm font-medium">{status}</p>}
              {error && <p className="text-sm text-[#7f1d1d]">{error}</p>}
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="h-11 flex-1 rounded-xl border-[#dce3ec] bg-[#f8fafc] text-sm font-semibold" onClick={saveDraftAndBack}>
                  {reviewTrip ? "Back to trips" : draftActive && (sheet.stops.length > 0 || text.trim()) ? "Save draft & back" : "Back"}
                </Button>
                <Button type="button" className="h-11 flex-[2] rounded-xl bg-[#173b64] text-sm font-bold text-white shadow-sm disabled:opacity-100" disabled={(!sheet.stops.length && !text.trim()) || routeBuilding || !!status} onClick={() => void generate()}>
                  {routeBuilding && <LoaderCircle aria-hidden="true" className="mr-2 inline h-4 w-4 animate-spin" />}
                  {routeBuilding ? "Building route…" : "Build the route"}
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}

      {view === "preview" && route && (
        <section className="flex flex-col gap-3 px-3 py-4 pb-60 sm:px-5">
          <div className="flex items-end justify-between gap-3 rounded-2xl border border-[#dce3ec] bg-gradient-to-br from-white to-[#edf3fa] px-4 py-3 shadow-sm">
            <div className="min-w-0">
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[#718097]">Route preview</p>
              <p className="mt-0.5 truncate text-lg font-bold tracking-tight">{sheet.route} {sheet.run}</p>
            </div>
            <span className="shrink-0 rounded-xl bg-[#173b64] px-3 py-2 text-sm font-bold text-white">{route.miles.toFixed(2)} mi</span>
          </div>
          <p className="rounded-xl border border-[#f0d28d] bg-[#fff9ea] px-3 py-2.5 text-sm leading-relaxed text-[#463716]">
            Check this track before driving. One-way directions and bus restrictions may be missing from map data; turnaround points are estimates. Follow the trip sheet and road signs.
          </p>
          {renderWarnings()}
          <div className="relative overflow-hidden rounded-2xl border border-[#dce3ec] bg-white p-1.5 shadow-[0_5px_18px_rgba(24,39,62,0.1)]" data-route-map>
            <RouteMap
              coords={route.coords}
              stops={previewStops}
              turnarounds={route.turnarounds}
              warningStops={route.warnings.filter((w) => w.level === "warn").flatMap((w) => {
                const stop = route.stops.find((s) => s.index === w.stopIndex);
                return stop ? [{ lat: stop.lat, lon: stop.lon, label: `Check stop ${w.stopIndex + 1}` }] : [];
              })}
              focusPoint={mapFocus}
              vias={overrides.vias ?? []}
              selectedTurnaround={pick}
              picking={tapMode !== null}
              onMapClick={onMapClick}
            />
            {tapMode !== null && (
              <div className="pointer-events-none absolute left-12 right-3 top-3 z-[1100] rounded-lg border-2 border-[#0f2744] bg-white/95 p-3 text-sm shadow-lg" role="status">
                {tapMode === "turn" ? (
                  <>
                    <p className="font-bold">Move the turnaround</p>
                    <p className="mt-1">Tap the road where the bus should turn around. The route rebuilds after your tap.</p>
                  </>
                ) : (
                  <>
                    <p className="font-bold">
                      {mapFixContext ? `Guide stop ${mapFixContext.stopIndex + 1} on the map` : "Add a point the route must pass"}
                    </p>
                    <p className="mt-1">
                      {mapFixContext?.street
                        ? <>Tap the road near stop {mapFixContext.stopIndex + 1}{" "}where the bus should enter <strong>{mapFixContext.street}</strong>. Tap the road, not the numbered stop marker. The route rebuilds after your tap.</>
                        : "Tap the road the bus should use. The route rebuilds after your tap."}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          <details open className="rounded-2xl border border-[#dce3ec] bg-white p-3 shadow-sm">
            <summary className="cursor-pointer text-sm font-bold">Stops and turns <span className="ml-1 rounded-full bg-[#edf3fa] px-2 py-0.5 text-xs text-[#315d8c]">{sheet.stops.length}</span></summary>
            <ol className="mt-3 space-y-2.5">
              {sheet.stops.map((stop, i) => {
                const warning = route.warnings.some((w) => w.level === "warn" && w.stopIndex === i);
                const directions = stop.maneuvers
                  .filter((m) => m.street.trim())
                  .map((m) => `${KIND_LABEL[m.kind]} ${m.street}`);
                const stopWarning = route.warnings.find((w) => w.level === "warn" && w.stopIndex === i);
                const warningManeuver = stopWarning && !stopWarning.message.startsWith("Couldn't reach the last stop")
                  ? sheet.stops[i]?.maneuvers[stopWarning.maneuverIndex]
                  : undefined;
                const editingStop = warningFix?.stopIndex === i;
                return (
                  <li key={`${stop.time}-${i}`} data-stop-row={i} className={`rounded-xl border p-2.5 text-sm ${warning ? "border-[#e9ad66] bg-[#fff8ec] shadow-[0_2px_8px_rgba(178,105,13,0.08)]" : "border-[#e8edf3] bg-[#f7f9fc]"}`}>
                    <div className="flex gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#0f2744] text-xs font-bold text-white">{i + 1}</span>
                      <span className="min-w-0">
                        <span className="font-semibold">{stop.time} · {stop.description || "Stop"}</span>
                        <span className="block text-[#3d4b63]">{directions.length ? directions.join(" → ") : "No turn listed"}</span>
                      </span>
                    </div>
                    {warning && stopWarning && (
                      <div className="mt-2">
                        <div className="flex flex-wrap gap-2">
                          {warningManeuver && <Button type="button" variant="outline" className="h-10 bg-white" onClick={() => editWarning(i, stopWarning.maneuverIndex)}>Edit direction</Button>}
                          <Button type="button" variant="outline" className="h-10 bg-white" onClick={() => focusWarning(i, stopWarning.message, warningManeuver?.street)}>Guide on map</Button>
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-[#3d4b63]">Edit the direction if it differs from the trip sheet. If the sheet is right, guide the route on the map instead.</p>
                      </div>
                    )}
                    {editingStop && warningFix && (
                      <div className="mt-3 space-y-2 rounded-md bg-white p-3 ring-1 ring-[#d9d2c3]">
                        <div>
                          <p className="text-xs font-semibold">Correct the direction to match the printed trip sheet.</p>
                          <p className="mt-1 text-xs leading-relaxed text-[#3d4b63]">If the printed direction is already right, cancel this edit and use Guide on map to move the route onto the correct road.</p>
                        </div>
                        <select className="h-11 w-full rounded-md border border-[#d9d2c3] bg-white px-3 text-base" aria-label="Direction" value={warningFix.kind} onChange={(e) => setWarningFix({ ...warningFix, kind: e.target.value as ManeuverKind })}>
                          {KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}
                        </select>
                        <Input aria-label="Correct street name" value={warningFix.street} onChange={(e) => setWarningFix({ ...warningFix, street: e.target.value })} placeholder="Street name from the trip sheet" />
                        <div className="flex gap-2">
                          <Button type="button" variant="outline" className="h-10 flex-1" onClick={() => { setWarningFix(null); warningAdvanceRef.current = null; }}>Cancel</Button>
                          <Button type="button" className="h-10 flex-1 bg-[#0f2744] text-white" disabled={!warningFix.street.trim() || !!status} onClick={rebuildWarningFix}>Save and rebuild</Button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <Button type="button" variant="destructive" className="h-10 px-2 text-xs" disabled={!!status} onClick={deleteWarningDirection} aria-label="Delete this direction and rebuild">
                            Delete direction
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-10 px-2 text-xs"
                            disabled={!!status}
                            onClick={() => {
                              setWarningFix(null);
                              setView("edit");
                              window.scrollTo(0, 0);
                            }}
                          >
                            Edit sheet text
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </details>
          <p className="text-sm text-[#3d4b63]">Blue dots are required route points. Orange dots are estimated turnarounds. Tap a warning above to fix a direction or guide the route.</p>
          {(overrides.vias?.length ?? 0) > 0 && (
            <p className="text-sm font-medium">
              This track passes through {overrides.vias?.map((v, n) => v.street || `waypoint ${n + 1}`).join(", ")}. The blue {overrides.vias?.length === 1 ? "dot is" : "dots are"} on the map.
            </p>
          )}
          {(overrides.vias?.length ?? 0) > 0 && (
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => {
                const next = { ...overrides, vias: [] };
                setOverrides(next);
                setTapMode(null);
                setMapFixContext(null);
                void generate(next);
              }}
            >
              Clear {overrides.vias?.length} via {overrides.vias?.length === 1 ? "point" : "points"}
            </Button>
          )}
          {route.turnarounds.length > 0 && (
            <ul className="space-y-2">
              {route.turnarounds.map((t: TurnaroundPin) => (
                <li key={t.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-[#d9d2c3]">
                  <span>
                    Turnaround on {t.street}
                    {t.how === "fallback" || t.how === "capped" ? " — please check" : ""}
                  </span>
                  <Button
                    type="button"
                    variant={pick === t.id ? "default" : "outline"}
                    className="h-10"
                    onClick={() => {
                      setPick(t.id);
                      setTapMode("turn");
                      requestAnimationFrame(() => document.querySelector("[data-route-map]")?.scrollIntoView({ behavior: "smooth", block: "center" }));
                    }}
                  >
                    Move
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {renderUndoToast()}
          <div className="fixed inset-x-0 bottom-0 z-[1200] border-t border-[#dce3ec] bg-white p-3 shadow-[0_-8px_28px_rgba(24,39,62,0.12)]">
            <div className="mx-auto flex max-w-2xl flex-col gap-2">
              {routeBuilding && <RouteBuildStatus message={status} />}
              {route.warnings.some((warning) => warning.level === "warn") && (
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[#e5bd77] bg-[#fff8e9] px-2.5 py-2 text-xs text-[#59451f]">
                  <input type="checkbox" className="h-4 w-4 shrink-0 accent-[#173b64]" checked={warningAcknowledged} onChange={(e) => setWarningAcknowledged(e.target.checked)} />
                  <span><strong>Review {route.warnings.filter((warning) => warning.level === "warn").length} warning{route.warnings.filter((warning) => warning.level === "warn").length === 1 ? "" : "s"}</strong><span className="ml-1">to enable GPX export.</span></span>
                </label>
              )}
              {tapMode !== null ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-12 w-full bg-white text-base"
                  onClick={() => { setTapMode(null); setMapFixContext(null); setPick(null); warningAdvanceRef.current = null; }}
                >
                  Cancel map fix
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    className="h-11 rounded-xl bg-[#173b64] text-sm font-bold text-white shadow-sm"
                    disabled={routeBuilding}
                    onClick={() => { setTapMode("via"); setMapFixContext(null); }}
                  >
                    Add a point on map
                  </Button>
                  {editingLockedRun ? (
                    <Button type="button" variant="outline" className="h-9 border-[#abd0b5] bg-[#f0f8f2] text-xs font-semibold text-[#216338]" disabled={routeBuilding} onClick={goHome}>
                      Go Home to unlock this GPX
                    </Button>
                  ) : (
                    <Button type="button" className="h-11 rounded-xl bg-[#173b64] text-sm font-bold text-white shadow-sm" disabled={routeBuilding || !!status || (route.warnings.some((w) => w.level === "warn") && !warningAcknowledged)} onClick={saveToDay}>
                      Add to today’s list
                    </Button>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <Button type="button" variant="outline" className="h-12" onClick={() => setView("edit")}>
                      Edit directions
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-12"
                      disabled={routeBuilding || !!status || (route.warnings.some((w) => w.level === "warn") && !warningAcknowledged)}
                      onClick={shareCurrentRoute}
                    >
                      Download GPX
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      )}
      {renderGpxNotice()}
    </main>
  );
}

/**
 * A field that grows with its text. The phone scrolls the page, not the inside
 * of the box, so a long stop or street can be read and edited in place.
 */
function WrapField({
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

function prettyText(sheet: Sheet): string {
  const head = [`Route: ${sheet.route} Description: ${sheet.description} Run: ${sheet.run}`];
  for (const stop of sheet.stops) {
    head.push(`${stop.time} ${stop.description}`);
    for (const m of stop.maneuvers) head.push(`${KIND_LABEL[m.kind]} ${m.street}`);
  }
  return head.join("\n");
}

/** In a trip opened from the review list the stops come first; the raw text folds away. */
function Tucked({ away, summary, children }: { away: boolean; summary: string; children: React.ReactNode }) {
  if (!away) return <>{children}</>;
  return (
    <details className="rounded-xl bg-white p-3 ring-1 ring-[#d9d2c3]">
      <summary className="cursor-pointer text-sm font-medium">{summary}</summary>
      <div className="mt-2 flex flex-col gap-3">{children}</div>
    </details>
  );
}

function pageTimes(p: PageInfo): string {
  const t = (m: number | null) => (m == null ? "" : `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${m >= 720 ? "PM" : "AM"}`);
  if (p.first == null) return p.run ? `Run ${p.run}` : "no times";
  return `${p.run ? `Run ${p.run} · ` : ""}${t(p.first)}${p.last != null && p.last !== p.first ? `–${t(p.last)}` : ""}`;
}

/** Small pictures of a trip's pages, so a page from another run stands out. */
function PageThumbs({ pages, onOpen }: { pages: PageInfo[]; onOpen?: (src: string) => void }) {
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

function SuggestPanel({
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

function StreetMark({ state, open, onTap }: { state: string; open: boolean; onTap: () => void }) {
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
    return <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-[#f0f2f4] text-xs text-[#657084]" aria-label="Checking the street">…</span>;
  }
  return <span className="w-9" aria-hidden />;
}
