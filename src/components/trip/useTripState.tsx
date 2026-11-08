"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { buildDayGpx, runFileName, type DeadheadLeg } from "@/lib/dayPlan";
import { driveBetween } from "@/lib/engine/drive";
import { buildGpx } from "@/lib/engine/gpx";
import { classifyLocation, parseSheet } from "@/lib/engine/parseSheet";
import { routeSheet } from "@/lib/engine/route";
import type { LonLat, Maneuver, ManeuverKind, RouteOverrides, RouteSuccess, Sheet, Warning } from "@/lib/engine/types";
import { loadAround, loadCorridor, lookupName, mergeMaps, type MapData } from "@/lib/mapfetch";
import { canonicalKey, looksLikePlace, schoolSig } from "@/lib/engine/names";
import { matchPlace } from "@/lib/engine/route";
import { readSheetPhotos } from "@/lib/ocr";
import { isPdf, pdfToPageImages } from "@/lib/pdfPages";
import { osrmRouter } from "@/lib/osrm";
import { RETAKE_MESSAGE } from "@/lib/ocr/quality";
import { loadDay, saveDay, type SavedRun } from "@/lib/storage";
import { dwellsOf, recordedFixes, stopsFromRecording } from "@/lib/recording";
import { useNewVersionReload } from "@/lib/newVersion";
import { useOfflineSupport } from "@/lib/offline";
import { useAppBridge } from "@/lib/appBridge";
import { placeNear, routeFromDrive, startsWhereLastEnded } from "@/lib/driven";
import { autoGroup, buildTrips, describePage, dropDuplicatePages, gpxFileName, mergeIntoDay, newTripKey, sheetProblems, sortStopsByTime, splitRuns, type PageInfo, type PageRead, type Trip } from "@/lib/batch";
import { canShareFiles, sendNativeGpx, shareOrDownload, type TextFile } from "@/lib/shareFiles";
import { buildStreetIndex, checkStop, checkStreet, looseName, sheetStyle, suggestFor as suggestNames } from "@/lib/streetCheck";
import { View, TripState, EditorDraft, GpxNotice, EDITOR_DRAFTS_KEY, KIND_LABEL, emptySheet, noSubscribe, canOfferHomeScreenInstall, pinsFor, keptPins, cachedMap, newId, prettyText } from "./shared";
import { createContext, useContext } from "react";

/** Everything the trip sheet screens share: the day list, the editor, the route being checked. */
export function useTripState() {
  const [view, setView] = useState<View>("day");
  const [runs, setRuns] = useState<SavedRun[]>([]);
  const [drafts, setDrafts] = useState<EditorDraft[]>([]);
  const [draftsReady, setDraftsReady] = useState(false);
  const [draftStorageError, setDraftStorageError] = useState("");
  const [draftStorageAttempt, setDraftStorageAttempt] = useState(0);
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
  const [rebuilding, setRebuilding] = useState(false);
  const [notice, setNotice] = useState("");
  /** Stop pins of the saved run open in the editor. */
  const [editPins, setEditPins] = useState<SavedRun["stopPins"]>(undefined);
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
  const [editorWarningCursor, setEditorWarningCursor] = useState(0);
  const pendingEditorWarning = useRef<{ stopIndex: number; maneuverIndex: number } | null>(null);
  const draftReadFailed = useRef(false);
  const [mapFocus, setMapFocus] = useState<{ lat: number; lon: number; key: number }>();
  const [mapFixContext, setMapFixContext] = useState<{ stopIndex: number; message: string; street?: string } | null>(null);
  const mapFocusKey = useRef(0);
  const [exportingDay, setExportingDay] = useState(false);
  const exportLock = useRef(false);
  const movePanel = useRef<HTMLDivElement>(null);
  // Server render says "Download"; the phone switches to "Send to GPX Nav" if it can share files.
  const canShare = useSyncExternalStore(noSubscribe, canShareFiles, () => false);
  const sendLabel = canShare ? "Send to GPX Nav" : "Download GPX";
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
  useOfflineSupport();
  const bridge = useAppBridge();
  useNewVersionReload(view === "day" && !draftActive && !routeBuilding && !rebuilding && !exportingDay && !checking);
  // A run opened to move its turnaround is built once its sheet and map settings are in place.
  const pendingBuild = useRef(false);
  useEffect(() => {
    if (!pendingBuild.current || view !== "edit" || !sheet.stops.length) return;
    pendingBuild.current = false;
    revealMapAfterBuild.current = true;
    void generate();
    // generate reads the state this effect waits for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sheet, overrides]);
  const revealMapAfterBuild = useRef(false);
  // "Save changes" on a saved run: build, then put the result straight back on the list.
  const saveAfterBuild = useRef(false);
  useEffect(() => {
    if (view !== "preview" || !route || !saveAfterBuild.current) return;
    saveAfterBuild.current = false;
    saveToDay();
    // saveToDay reads the route this effect waits for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, route]);
  useEffect(() => {
    if (error) saveAfterBuild.current = false;
  }, [error]);
  // A sent or cancelled notice has nothing left to do; let it go so it stops covering buttons.
  useEffect(() => {
    if (gpxNotice?.state !== "shared" && gpxNotice?.state !== "cancelled") return;
    const timer = setTimeout(() => setGpxNotice((now) => (now === gpxNotice ? null : now)), 8000);
    return () => clearTimeout(timer);
  }, [gpxNotice]);
  useEffect(() => {
    if (view !== "preview" || !revealMapAfterBuild.current) return;
    revealMapAfterBuild.current = false;
    requestAnimationFrame(() => document.querySelector("[data-route-map]")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [view, route]);

  /** The editor holds a run already on today's list, so saving replaces it. */
  const editingSavedRun = !!editingId && !reviewKey && runs.some((run) => run.id === editingId);

  const unreviewedRuns = useMemo(
    () => runs.filter((run) => !run.warningsAcknowledged && run.warnings.some((warning) => warning.level === "warn")),
    [runs],
  );
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
    let active = true;
    const timer = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem(EDITOR_DRAFTS_KEY);
        const parsed: unknown = saved ? JSON.parse(saved) : [];
        if (!Array.isArray(parsed)) throw new Error("Saved drafts have an unexpected format.");
        draftReadFailed.current = false;
        setDrafts(parsed as EditorDraft[]);
        setDraftStorageError("");
      } catch {
        draftReadFailed.current = true;
        setDraftStorageError("Could not load unfinished drafts from this phone. Retry storage before starting another draft.");
      } finally {
        if (active) setDraftsReady(true);
      }
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draftStorageAttempt]);

  useEffect(() => {
    if (!draftsReady || draftReadFailed.current) return;
    let message = "";
    try {
      localStorage.setItem(EDITOR_DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      message = "Unfinished work could not be saved on this phone. It may be lost if you close or reload this page.";
    }
    const timer = window.setTimeout(() => setDraftStorageError(message), 0);
    return () => window.clearTimeout(timer);
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
    if (view !== "edit" || !pendingEditorWarning.current || !editWarnings.length) return;
    const first = pendingEditorWarning.current;
    pendingEditorWarning.current = null;
    const frame = requestAnimationFrame(() => {
      (document.querySelector<HTMLElement>(`[data-direction-row="${first.stopIndex}-${first.maneuverIndex}"]`) ??
        document.querySelector<HTMLElement>(`[data-stop="${first.stopIndex}"]`))
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [view, editWarnings]);

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
    setEditPins(undefined);
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

  /** Open a saved run in the editor. With [build], build it straight away to show the route map. */
  function openEdit(run: SavedRun, build = false) {
    pendingBuild.current = build;
    setEditingId(run.id);
    setDraftId(`run-${run.id}`);
    setDraftActive(true);
    setWarningAcknowledged(run.warningsAcknowledged ?? false);
    setDirectionMapStop(null);
    setText(run.sheetText);
    setArea(run.area || area);
    const parsed = parseSheet(run.sheetText);
    setSheet(parsed.stops.length ? parsed : emptySheet());
    setRoute(null);
    const mappedWarnings = (run.warnings ?? []).flatMap((w) => {
      if (w.level !== "warn") return [];
      if (typeof w.stopIndex === "number" && typeof w.maneuverIndex === "number") {
        return [{ level: "warn" as const, stopIndex: w.stopIndex, maneuverIndex: w.maneuverIndex, message: w.message }];
      }
      // Older saved runs stored the warning text without its direction indexes.
      const needle = w.message.toLocaleLowerCase();
      const match = parsed.stops.flatMap((stop, stopIndex) => stop.maneuvers.map((maneuver, maneuverIndex) => ({ stopIndex, maneuverIndex, street: maneuver.street })))
        .find((item) => item.street.trim() && needle.includes(item.street.trim().toLocaleLowerCase()));
      return match ? [{ level: "warn" as const, stopIndex: match.stopIndex, maneuverIndex: match.maneuverIndex, message: w.message }] : [];
    });
    setEditWarnings(mappedWarnings);
    setEditorWarningCursor(0);
    pendingEditorWarning.current = mappedWarnings.length ? mappedWarnings[0] : null;
    setMapData(null);
    setOverrides({ vias: run.vias ?? [], ...(run.turnarounds ? { turnarounds: run.turnarounds } : {}), stops: pinsFor(parsed, run.stopPins) });
    setEditPins(run.stopPins);
    setError("");
    setView("edit");
  }

  function retryDraftPersistence() {
    if (draftReadFailed.current) {
      setDraftsReady(false);
      setDraftStorageAttempt((attempt) => attempt + 1);
      return;
    }
    if (!hasDraftContent) {
      setDraftsReady(false);
      setDraftStorageAttempt((attempt) => attempt + 1);
      return;
    }
    const draft: EditorDraft = {
      id: draftId || newId(), editingId, text, sheet, area, overrides,
      warnings: editWarnings, updatedAt: Date.now(),
    };
    const next = [draft, ...drafts.filter((item) => item.id !== draft.id)];
    try {
      localStorage.setItem(EDITOR_DRAFTS_KEY, JSON.stringify(next));
      setDrafts(next);
      setDraftId(draft.id);
      setDraftStorageError("");
    } catch {
      setDraftStorageError("Unfinished work could not be saved on this phone. It may be lost if you close or reload this page.");
    }
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
    setEditPins(runs.find((run) => run.id === draft.editingId)?.stopPins);
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
    // A typed or converted sheet (.md or .txt) is read as text: no photo reader.
    const textFiles = picked.filter((file) => /\.(?:md|markdown|txt)$/i.test(file.name) || file.type.startsWith("text/"));
    if (textFiles.length) {
      const read = await Promise.all(textFiles.map(async (file) => ({ name: file.name, text: await file.text() })));
      const joined = read.map((r) => r.text).join("\n\n");
      const pages = read.flatMap((r) => splitRuns(r.text).map((text) => describePage({ photo: -1, name: r.name, text })));
      const problems = sheetProblems(buildTrips(pages, autoGroup(pages)));
      const note = problems.length
        ? `Check ${problems.length === 1 ? "this" : "these"} before building: ${problems.slice(0, 4).join(" ")}${problems.length > 4 ? ` And ${problems.length - 4} more.` : ""}`
        : "";
      setText(joined);
      if (!takeText(read.map((r) => ({ photo: -1, name: r.name, text: r.text })), note)) {
        applyText(joined);
        if (note) setError(note);
      }
      if (textFiles.length === picked.length) return;
    }
    const files: File[] = [];
    try {
      for (const file of picked) {
        if (textFiles.includes(file)) continue;
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
    const good = results.flatMap((r, i) => (r.ok ? [{ photo: i, name: r.name, text: r.text, thumb: r.thumb, incomplete: r.incomplete, missingStops: r.missingStops }] : []));
    const bad = results.flatMap((r, i) => (r.ok ? [] : [{ photo: i, reason: r.reason }]));
    const unreadNote = bad.length
      ? results.length === 1
        ? bad[0].reason
        : `Couldn't read ${bad.map((b) => results[b.photo]?.name || `page ${b.photo + 1}`).join(", ")}. ${RETAKE_MESSAGE.replace("Couldn't read this photo. ", "")}`
      : "";
    // A page whose footer never came through may have lost its last stops and turns.
    const cut = results.flatMap((r, i) => (r.ok && r.incomplete ? [results.length === 1 ? "this photo" : `photo ${i + 1}`] : []));
    const cutNote = cut.length
      ? `The bottom of ${cut.join(", ")} may be cut off: its page footer wasn't read. Check the last stops and turns against the sheet, or retake it flat and well lit.`
      : "";
    // The load column has one row per stop; extra rows mean stop lines were not read.
    const short = results.flatMap((r, i) => (r.ok && r.missingStops ? [`${results.length === 1 ? "this photo" : `photo ${i + 1}`} (${r.missingStops})`] : []));
    const shortNote = short.length
      ? `Some stops may be missing from ${short.join(", ")}: the load column lists more stops than were read. Check the stops against the sheet.`
      : "";
    const badNote = [unreadNote, cutNote, shortNote].filter(Boolean).join(" ");
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

  function savedRunFrom(id: string, sheetText: string, built: Sheet, result: RouteSuccess, vias: { lat: number; lon: number; street?: string }[] = [], warningsAcknowledged = false, turnarounds?: RouteOverrides["turnarounds"], stopPins?: SavedRun["stopPins"]): SavedRun {
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
      warningsAcknowledged,
      vias,
      ...(turnarounds && Object.keys(turnarounds).length ? { turnarounds } : {}),
      ...(stopPins && Object.keys(stopPins).length ? { stopPins } : {}),
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
    setEditPins(undefined);
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
      // Pasted text that was never read: read it now. Several runs go to the
      // review list instead of being built as one route.
      if (takeText([{ photo: -1, name: "Pasted text", text }])) return;
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

  function showWarningOnMap(stopIndex: number) {
    const stop = route?.stops.find((s) => s.index === stopIndex);
    if (!stop) return;
    setMapFocus({ lat: stop.lat, lon: stop.lon, key: ++mapFocusKey.current });
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

  function focusEditorWarning(index: number) {
    const warning = editWarnings[index];
    if (!warning) return;
    setEditorWarningCursor(index);
    requestAnimationFrame(() => {
      (document.querySelector<HTMLElement>(`[data-direction-row="${warning.stopIndex}-${warning.maneuverIndex}"]`) ??
        document.querySelector<HTMLElement>(`[data-stop="${warning.stopIndex}"]`))
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
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
    const count = gpxNotice.files.length;
    const sent = gpxNotice.sent ?? 0;
    const stepwise = sendsOneAtATime(gpxNotice.files);
    const names = stepwise
      ? gpxNotice.files[sent]?.name ?? ""
      : count <= 2
        ? gpxNotice.files.map((file) => file.name).join(" · ")
        : `${gpxNotice.files.slice(0, 2).map((file) => file.name).join(" · ")} · +${count - 2} more`;
    const readyHeading = gpxNotice.source === "added" ? "Saved to today’s list"
      : gpxNotice.source === "day" ? "Day file ready"
        : gpxNotice.source === "all" ? (sent ? `Run ${sent} of ${count} sent` : `${count} run files ready`)
          : "GPX ready";
    const readyMessage = gpxNotice.note
      ?? (gpxNotice.source === "added" ? "It’s kept in this browser. To drive it, send it to GPX Nav."
        : stepwise ? `iPhone sends one file at a time. Tap to send run ${sent + 1} of ${count}.`
          : canShare ? "Tap Send to GPX Nav, then choose GPX Nav in the share sheet." : "Tap Download GPX to save the file.");
    const heading = gpxNotice.state === "ready" ? readyHeading
      : gpxNotice.state === "sharing" ? "Preparing GPX…"
        : gpxNotice.state === "downloaded" ? (count === 1 ? "GPX file downloaded" : `${count} GPX files downloaded`)
          : gpxNotice.state === "cancelled" ? "Not sent"
            : stepwise ? `All ${count} runs sent` : "GPX sent";
    const message = gpxNotice.state === "ready"
      ? readyMessage
      : gpxNotice.state === "sharing"
        ? "In the share sheet, tap GPX Nav. Not in the row? Swipe the apps row and tap More."
        : gpxNotice.state === "downloaded"
          ? "It’s in Downloads (iPhone: Files app › Downloads). Tap it there and choose GPX Nav."
          : gpxNotice.state === "cancelled"
            ? "Nothing was sent. Your runs are still on today’s list."
            : "If you chose GPX Nav, the run is now in its list. If you chose Save to Files, it’s in the Files app where you saved it.";
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
                {gpxNotice.state !== "ready" ? "Try again" : stepwise ? `Send run ${sent + 1} of ${count}` : sendLabel}
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
            <p className="text-sm font-semibold text-[#68470b]">{warningAcknowledged ? `Checked · ${issueCount} warning${issueCount === 1 ? "" : "s"} still on route` : `${issueCount} ${issueCount === 1 ? "warning" : "warnings"} to check`}</p>
            <div className="flex shrink-0 gap-1.5">
            {warningAcknowledged ? (
              <Button type="button" variant="outline" className="h-8 border-[#e5c981] bg-white px-2.5 text-xs font-semibold text-[#68470b]" onClick={() => setWarningAcknowledged(false)}>Undo</Button>
            ) : (
              <Button type="button" className="h-8 bg-[#173b64] px-2.5 text-xs font-semibold text-white" onClick={() => setWarningAcknowledged(true)}>I’ve checked these</Button>
            )}
            <Button type="button" variant="outline" className="h-8 shrink-0 border-[#e5c981] bg-white px-2.5 text-xs font-semibold text-[#68470b]" onClick={() => {
              const target = warningCursor % issueCount;
              document.querySelector<HTMLElement>(`[data-route-warning="${target}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              setWarningCursor((current) => (current + 1) % issueCount);
            }}>
              Next {warningCursor % issueCount + 1}/{issueCount}
            </Button>
            </div>
          </div>
        )}
        {route.warnings.map((w, i) => {
          const warningIndex = w.level === "warn" ? issueIndex++ : undefined;
          const waypointWarning = w.message.startsWith("Couldn't find a drivable connection to the point you added");
          const mapLocationWarning = !!w.location && !waypointWarning;
          const gapWarning = w.message.startsWith("The map has an incomplete connection");
          const stop = route.stops.find((s) => s.index === w.stopIndex);
          const destinationWarning = w.message.startsWith("Couldn't reach the last stop");
          const maneuver = destinationWarning ? undefined : sheet.stops[w.stopIndex]?.maneuvers[w.maneuverIndex];
          return (
            <div key={`${i}-${w.stopIndex}-${w.maneuverIndex}`} data-route-warning={warningIndex} className={`rounded-lg p-3 text-sm ${w.level === "warn" ? "bg-[#ffedd5]" : "bg-white ring-1 ring-[#d9d2c3]"}`}>
              {w.level === "warn" && stop && !waypointWarning && !mapLocationWarning && (
                <div className="mb-1 rounded-md bg-white/70 px-2 py-1.5 text-xs text-[#394861]">
                  <p className="font-semibold">Stop {w.stopIndex + 1}{sheet.stops[w.stopIndex]?.time ? ` · ${sheet.stops[w.stopIndex].time}` : ""}</p>
                  {maneuver && <p className="mt-0.5">{KIND_LABEL[maneuver.kind]} {maneuver.street || "[street missing]"}</p>}
                </div>
              )}
              <p>{w.message}</p>
              {w.level === "warn" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {waypointWarning ? (
                    <Button type="button" variant="outline" className="h-10 bg-white" onClick={() => {
                      setView("edit");
                      window.setTimeout(() => document.querySelector<HTMLElement>("[data-waypoints]")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
                    }}>Review map point</Button>
                  ) : mapLocationWarning ? (
                    <Button type="button" variant="outline" className="h-10 bg-white" onClick={() => {
                      setMapFocus({ lat: w.location![1], lon: w.location![0], key: ++mapFocusKey.current });
                      document.querySelector("[data-route-map]")?.scrollIntoView({ behavior: "smooth", block: "center" });
                    }}>{gapWarning ? "Show gap on map" : "Show road on map"}</Button>
                  ) : (
                    <>
                      {stop && <Button type="button" variant="outline" className="h-10 bg-white" onClick={() => showWarningOnMap(w.stopIndex)}>Show stop on map</Button>}
                      {stop && <Button type="button" variant="outline" className="h-10 bg-white" onClick={() => focusWarning(w.stopIndex, w.message, maneuver?.street)}>Guide on map</Button>}
                      {maneuver && <Button type="button" variant="outline" className="h-10 bg-white" onClick={() => editWarning(w.stopIndex, w.maneuverIndex)}>Edit this turn</Button>}
                    </>
                  )}
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
    const saved = savedRunFrom(editingId ?? newId(), text, sheet, route, overrides.vias ?? [], warningAcknowledged, overrides.turnarounds, keptPins(sheet, editPins));
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
    if (exportLock.current) return;
    const label = [run.route, run.run].filter(Boolean).join(" ") || "this GPX";
    const ask = run.locked
      ? `${label} is protected. Remove it anyway? This also deletes its saved GPX from this phone.`
      : `Remove ${label} from today’s list? This also deletes its saved GPX from this phone.`;
    if (!window.confirm(ask)) return;
    setRuns((prev) => prev.filter((item) => item.id !== run.id));
    dropStaleNotice();
  }

  /** The driver has looked at a run's warnings (or takes them back). */
  function setRunChecked(id: string, checked: boolean) {
    setRuns((prev) => prev.map((run) => (run.id === id ? { ...run, warningsAcknowledged: checked } : run)));
  }

  /** Download one run. Unchecked warnings are listed and confirmed first, not routed through the editor. */
  function downloadRun(run: SavedRun, index: number) {
    const open = !run.warningsAcknowledged ? run.warnings.filter((w) => w.level === "warn") : [];
    if (open.length) {
      const list = open.slice(0, 4).map((w) => `• ${w.message}`).join("\n");
      const more = open.length > 4 ? `\n…and ${open.length - 4} more.` : "";
      if (!window.confirm(`This run has ${open.length} warning${open.length === 1 ? "" : "s"} to check:\n\n${list}${more}\n\nMark them checked and send the GPX?`)) return;
      setRunChecked(run.id, true);
    }
    const name = runFileName(index, run);
    void deliverGpx({ files: [{ name, text: run.gpx }], title: name, source: "single", state: "ready" });
  }

  /**
   * Route every saved run again with the current app, from its own sheet and
   * with the driver's turnarounds and via taps. Protected runs keep their GPX.
   */
  async function rebuildAllRuns(recordings?: string[], fromDrive = false) {
    if (exportLock.current || rebuilding || !runs.length) return;
    // A run made from a recorded drive keeps it; only a new drive replaces it.
    const todo = runs.filter((run) => !run.locked && (fromDrive || !run.driven));
    if (!todo.length) {
      setError("Every run is protected. Unlock a run to rebuild it.");
      return;
    }
    setError("");
    setNotice("");
    setRebuilding(true);
    const dwells = recordings ? recordings.flatMap((gpx) => dwellsOf(recordedFixes(gpx))) : [];
    if (recordings && !dwells.length) {
      setRebuilding(false);
      setError("That file has no timed track points, so there is nothing to match. Pick a GPX recorded on the drive.");
      return;
    }
    const fixes = fromDrive && recordings ? recordings.flatMap((gpx) => recordedFixes(gpx)).sort((a, b) => a.t - b.t) : [];
    const rebuilt = new Map<string, SavedRun>();
    let failed = 0;
    let moved = 0;
    let drivenRuns = 0;
    try {
      // Where the run before ended, for a run whose sheet starts there again.
      let previousEnd: { description: string; lat: number; lon: number } | undefined;
      let previousEndsAt: number | undefined;
      for (const [i, run] of todo.entries()) {
        const prefix = `Rebuilding ${i + 1} of ${todo.length}`;
        setStatus(`${prefix}…`);
        try {
          const parsed = parseSheet(run.sheetText);
          if (!parsed.stops.length) throw new Error("No stops");
          let stopPins = keptPins(parsed, run.stopPins);
          if (dwells.length) {
            // Stops the route couldn't pin down move to where the bus stood still.
            const unsure = new Set(run.warnings.filter((w) => w.level === "warn" && w.maneuverIndex === -1 && typeof w.stopIndex === "number" && w.stopIndex >= 0).map((w) => w.stopIndex as number));
            const found = stopsFromRecording(run.stops, dwells, unsure);
            for (const [k, p] of Object.entries(found)) {
              stopPins = { ...stopPins, [k]: { ...p, description: parsed.stops[Number(k)]?.description ?? "" } };
              moved++;
            }
          }
          const runArea = run.area || area;
          const data = await cachedMap(parsed, runArea, (s) => setStatus(`${prefix}: ${s}`));
          const overrides: RouteOverrides = { vias: run.vias ?? [], ...(run.turnarounds ? { turnarounds: run.turnarounds } : {}), stops: pinsFor(parsed, stopPins) };
          const result = await routeSheet(parsed, data, overrides, osrmRouter);
          if (!result.ok) throw new Error(result.error);
          // A run that starts where the last one ended: its first stop is found
          // on the drive there. Only the drive matching uses it; the router
          // keeps a run's first stop as the map has it.
          const firstStopAt = (fromDrive ? startsWhereLastEnded(parsed.stops[0], previousEnd) : null) ?? undefined;
          const vias = (run.vias ?? []).map((v, n) => ({ ...v, ...(result.viaStreets[n] ? { street: result.viaStreets[n] } : {}) }));
          let drive = fromDrive ? routeFromDrive(parsed, result, fixes, { lines: data.lines, places: data.places, firstStopAt, after: firstStopAt ? previousEndsAt : undefined }) : null;
          if (drive && (drive.start || drive.end)) {
            // Name where the bus set off from and parked, such as the school it waits at.
            const nameOf = async (p?: LonLat) => (p ? placeNear((await loadAround({ lat: p[1], lon: p[0] }).catch(() => ({ places: [] }))).places, p) : undefined);
            const [startName, endName] = await Promise.all([nameOf(drive.start), nameOf(drive.end)]);
            // The drive there can leave the run's map; its turns come from the map along it.
            const stopAt = (s?: { lon: number; lat: number }): LonLat | null => (s ? [s.lon, s.lat] : null);
            const first = stopAt(drive.route.stops[1]);
            const last = stopAt(drive.route.stops.at(-2));
            let lines = data.lines;
            for (const [a, b] of [[drive.start, first], [last, drive.end]] as const) {
              if (a && b) lines = mergeMaps({ lines, places: [] }, await loadCorridor(a, b).catch(() => ({ lines: [], places: [] }))).lines;
            }
            drive = routeFromDrive(parsed, result, fixes, { lines, places: data.places, firstStopAt, after: firstStopAt ? previousEndsAt : undefined, startName, endName }) ?? drive;
          }
          if (drive) drivenRuns++;
          const ended = (drive?.route ?? result).stops.at(-1);
          previousEnd = ended ? { description: ended.description, lat: ended.lat, lon: ended.lon } : undefined;
          previousEndsAt = drive?.endsAt;
          rebuilt.set(run.id, { ...savedRunFrom(run.id, run.sheetText, parsed, drive?.route ?? result, vias, false, run.turnarounds, stopPins), area: runArea, driven: !!drive });
        } catch {
          failed++;
        }
      }
    } finally {
      setStatus("");
      setRebuilding(false);
    }
    if (rebuilt.size) setRuns((prev) => prev.map((run) => rebuilt.get(run.id) ?? run));
    if (fromDrive) setNotice(drivenRuns
      ? `${drivenRuns} run${drivenRuns > 1 ? "s" : ""} now follow${drivenRuns > 1 ? "" : "s"} the recorded drive.${todo.length - drivenRuns - failed > 0 ? ` ${todo.length - drivenRuns - failed} weren't on the recording and kept the sheet's route.` : ""}`
      : "None of the runs are on that recording. Check that it's from these runs.");
    else if (recordings) setNotice(moved ? `Moved ${moved} stop${moved > 1 ? "s" : ""} to where the bus stopped on the recorded drive.` : "No stop with a warning matched a stop on the recorded drive. Check that the recording is from these runs.");
    if (failed) setError(`${failed} run${failed > 1 ? "s" : ""} couldn't be rebuilt and kept ${failed > 1 ? "their" : "its"} old route. Open ${failed > 1 ? "them" : "it"} with Edit.`);
  }

  async function matchRecordings(files: FileList | null, fromDrive = false) {
    if (!files?.length) return;
    const texts = await Promise.all([...files].map((f) => f.text()));
    await rebuildAllRuns(texts, fromDrive);
  }

  /** Clear the day's list. Protected runs stay; remove those one at a time. */
  function removeAllRuns() {
    if (exportLock.current || !runs.length) return;
    const kept = runs.filter((run) => run.locked).length;
    const gone = runs.length - kept;
    if (!gone) {
      setError("Every run is protected. Remove a protected run from its own card.");
      return;
    }
    const keepNote = kept ? ` ${kept} protected ${kept === 1 ? "run stays" : "runs stay"}.` : "";
    if (!window.confirm(`Remove ${gone} ${gone === 1 ? "run" : "runs"} from today’s list? Their saved GPX files are deleted from this phone.${keepNote}`)) return;
    setRuns((prev) => prev.filter((run) => run.locked));
    dropStaleNotice();
  }

  /** A "ready to send" file was made from runs that may now be gone. */
  function dropStaleNotice() {
    setGpxNotice((now) => (now && now.state !== "sharing" ? null : now));
  }

  function allowBatchExport() {
    const first = unreviewedRuns[0];
    if (!first) return true;
    const label = [first.route, first.run].filter(Boolean).join(" ") || "the highlighted run";
    setError(`Check the warnings on ${label}, then tap “I’ve checked these” on its card.`);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-warning-run="${first.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return false;
  }

  /** Several files to another app on iPhone need one share sheet each. */
  function sendsOneAtATime(files: TextFile[]) {
    return canShare && files.length > 1 && typeof window !== "undefined" && !window.TripNavGPX;
  }

  /**
   * Share or download a notice's files. Call it straight from a tap: Safari opens the
   * share sheet only then, so anything slow happens before and ends in a "ready" notice.
   */
  async function deliverGpx(notice: GpxNotice) {
    const sent = notice.sent ?? 0;
    const stepwise = sendsOneAtATime(notice.files);
    const files = stepwise ? [notice.files[sent]] : notice.files;
    setGpxNotice({ ...notice, state: "sharing" });
    try {
      const result = await shareOrDownload(files, files.length === 1 ? files[0].name : notice.title);
      if (result === "blocked") setGpxNotice({ ...notice, state: "ready" });
      else if (result === "shared" && stepwise && sent + 1 < notice.files.length) setGpxNotice({ ...notice, sent: sent + 1, note: undefined, state: "ready" });
      else setGpxNotice({ ...notice, state: result });
    } catch (err) {
      setGpxNotice(null);
      setError(err instanceof Error ? err.message : "The GPX could not be shared or downloaded.");
    }
  }

  function shareGpxNotice() {
    if (!gpxNotice || gpxNotice.state === "sharing") return;
    void deliverGpx(gpxNotice);
  }

  function shareCurrentRoute() {
    if (!route) return;
    // Same rule as a saved run’s send button: list unchecked warnings once and ask.
    const open = warningAcknowledged ? [] : route.warnings.filter((w) => w.level === "warn");
    if (open.length) {
      const list = open.slice(0, 4).map((w) => `• ${w.message}`).join("\n");
      const more = open.length > 4 ? `\n…and ${open.length - 4} more.` : "";
      if (!window.confirm(`This route has ${open.length} warning${open.length === 1 ? "" : "s"} to check:\n\n${list}${more}\n\nMark them checked and send the GPX?`)) return;
      setWarningAcknowledged(true);
    }
    const name = runFileName(0, { run: sheet.run, description: sheet.description, firstTime: sheet.stops[0]?.time ?? "" });
    void deliverGpx({ files: [{ name, text: buildGpx(sheet, route.coords, route.stops, route.turnMarks) }], title: name, source: "single", state: "ready" });
  }

  // No dialog first: it would use up the tap the share sheet needs.
  async function shareAll() {
    if (!runs.length || exportLock.current || !allowBatchExport()) return;
    exportLock.current = true;
    setExportingDay(true);
    setError("");
    try {
      const used = new Set<string>();
      const files = runs.map((run, i) => ({ name: gpxFileName(run.run, i, used), text: run.gpx }));
      await deliverGpx({ files, title: `${files.length} runs`, source: "all", state: "ready" });
    } finally {
      exportLock.current = false;
      setExportingDay(false);
    }
  }

  async function exportDay() {
    if (!runs.length || exportLock.current || !allowBatchExport()) return;
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
          // A gap in the downloaded map can split the corridor; the road router has the whole map.
          const routed = driven?.coords ?? (await osrmRouter([a, b]).catch(() => null));
          deadheads.push(routed ? { coords: routed, routed: true } : { coords: [a, b], routed: false });
        } catch {
          deadheads.push({ coords: [a, b], routed: false });
        }
      }
      setStatus("");
      const gpx = buildDayGpx(exportRuns, deadheads);
      const name = `day_${exportRuns.length}_runs.gpx`;
      const notice: GpxNotice = { files: [{ name, text: gpx }], title: name, source: "day", state: "ready", note: dayNote(deadheads, exportRuns.length) };
      // GPX Nav takes the file without a tap. In a browser, routing the deadheads
      // took too long to share on this tap, so the notice's button sends it.
      if (window.TripNavGPX) await deliverGpx(notice);
      else setGpxNotice(notice);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The day’s GPX could not be built.");
    } finally {
      setStatus("");
      exportLock.current = false;
      setExportingDay(false);
    }
  }

  function dayNote(deadheads: DeadheadLeg[], count: number) {
    const missing = deadheads.filter((leg) => !leg.routed).length;
    const order = `${count} runs in list order.`;
    if (!deadheads.length) return `${order} Tap to send it to GPX Nav.`;
    return missing
      ? `${order} ${missing} of ${deadheads.length} drives between runs had no road route; check those gaps before driving.`
      : `${order} Drives between runs found by road. Tap to send it to GPX Nav.`;
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

  /** The editor's main button: build, and save over the run being edited. */
  function buildFromEditor() {
    saveAfterBuild.current = editingSavedRun;
    void generate();
  }

  return {
    buildFromEditor,
    view,
    setView,
    runs,
    setRuns,
    drafts,
    setDrafts,
    draftsReady,
    setDraftsReady,
    draftStorageError,
    setDraftStorageError,
    draftStorageAttempt,
    setDraftStorageAttempt,
    draftId,
    setDraftId,
    draftActive,
    setDraftActive,
    ready,
    setReady,
    loadError,
    setLoadError,
    loadAttempt,
    setLoadAttempt,
    stored,
    setStored,
    gpxNotice,
    setGpxNotice,
    saveRevision,
    status,
    setStatus,
    routeBuilding,
    setRouteBuilding,
    error,
    setError,
    rebuilding,
    setRebuilding,
    notice,
    setNotice,
    editPins,
    setEditPins,
    area,
    setArea,
    text,
    setText,
    sheet,
    setSheet,
    editingId,
    setEditingId,
    mapData,
    setMapData,
    loadedArea,
    setLoadedArea,
    route,
    setRoute,
    editWarnings,
    setEditWarnings,
    overrides,
    setOverrides,
    pick,
    setPick,
    tapMode,
    setTapMode,
    pages,
    setPages,
    pageKeys,
    setPageKeys,
    fixing,
    setFixing,
    tripStates,
    setTripStates,
    reviewKey,
    setReviewKey,
    tripEdits,
    setTripEdits,
    bigThumb,
    setBigThumb,
    mapRun,
    setMapRun,
    directionMapStop,
    setDirectionMapStop,
    warningAcknowledged,
    setWarningAcknowledged,
    warningCursor,
    setWarningCursor,
    showInstallHelp,
    setShowInstallHelp,
    offerHomeScreenInstall,
    warningFix,
    setWarningFix,
    editorWarningCursor,
    setEditorWarningCursor,
    pendingEditorWarning,
    draftReadFailed,
    mapFocus,
    setMapFocus,
    mapFixContext,
    setMapFixContext,
    mapFocusKey,
    exportingDay,
    setExportingDay,
    exportLock,
    movePanel,
    canShare,
    sendLabel,
    trips,
    checking,
    setChecking,
    checkFailed,
    setCheckFailed,
    suggestFor,
    setSuggestFor,
    streetIndex,
    hasStops,
    hasDraftContent,
    currentDraft,
    draftIsSaved,
    editingRun,
    bridge,
    pendingBuild,
    revealMapAfterBuild,
    saveAfterBuild,
    editingSavedRun,
    unreviewedRuns,
    lookups,
    setLookups,
    recheckTick,
    setRecheckTick,
    undo,
    setUndo,
    scrollRestoreRef,
    warningAdvanceRef,
    lookKey,
    runCenter,
    nameOnMap,
    streetState,
    stopState,
    optionsFor,
    resolveNames,
    tapMark,
    recheckSoon,
    deleteStop,
    deleteManeuver,
    undoDelete,
    reviewTrip,
    editingLockedRun,
    openNew,
    openEdit,
    retryDraftPersistence,
    saveDraftAndBack,
    goHome,
    resumeDraft,
    discardDraft,
    takeText,
    readPasted,
    applyText,
    onPhotos,
    movePage,
    savedRunFrom,
    buildAllTrips,
    openTrip,
    backToTrips,
    updateManeuver,
    generate,
    focusWarning,
    showWarningOnMap,
    editWarning,
    focusEditorWarning,
    queueWarningAdvance,
    rebuildWarningFix,
    deleteWarningDirection,
    renderUndoToast,
    renderGpxNotice,
    renderWarnings,
    onMapClick,
    saveToDay,
    move,
    toggleRunLock,
    removeRun,
    setRunChecked,
    downloadRun,
    rebuildAllRuns,
    matchRecordings,
    removeAllRuns,
    allowBatchExport,
    sendsOneAtATime,
    deliverGpx,
    shareGpxNotice,
    shareCurrentRoute,
    shareAll,
    exportDay,
    dayNote,
    previewStops,
    screenTitle,
  };
}

export type TripAppState = ReturnType<typeof useTripState>;

export const TripContext = createContext<TripAppState | null>(null);

export function useTrip(): TripAppState {
  const app = useContext(TripContext);
  if (!app) throw new Error("useTrip() is only for screens inside <TripApp>.");
  return app;
}
