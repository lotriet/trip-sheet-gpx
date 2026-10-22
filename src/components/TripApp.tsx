"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EXAMPLE_SHEET_TEXT } from "@/lib/exampleSheet";
import { buildDayGpx, runFileName, type DeadheadLeg } from "@/lib/dayPlan";
import { driveBetween } from "@/lib/engine/drive";
import { buildGpx } from "@/lib/engine/gpx";
import { classifyLocation, parseSheet } from "@/lib/engine/parseSheet";
import { routeSheet } from "@/lib/engine/route";
import type { LonLat, Maneuver, ManeuverKind, RouteOverrides, RouteSuccess, Sheet, TurnaroundPin } from "@/lib/engine/types";
import { loadAround, loadCorridor, loadMap, lookupName, mergeMaps, type MapData } from "@/lib/mapfetch";
import { canonicalKey, looksLikePlace, schoolSig } from "@/lib/engine/names";
import { matchPlace } from "@/lib/engine/route";
import { readSheetPhotos } from "@/lib/ocr";
import { isPdf, pdfToPageImages } from "@/lib/pdfPages";
import { osrmRouter } from "@/lib/osrm";
import { RETAKE_MESSAGE } from "@/lib/ocr/quality";
import { loadDay, saveDay, type SavedRun } from "@/lib/storage";
import { autoGroup, buildTrips, describePage, dropDuplicatePages, gpxFileName, mergeIntoDay, newTripKey, sortStopsByTime, splitRuns, type PageInfo, type PageRead, type Trip } from "@/lib/batch";
import { canShareFiles, shareOrDownload } from "@/lib/shareFiles";
import { buildStreetIndex, checkStop, checkStreet, looseName, sheetStyle, suggestFor as suggestNames } from "@/lib/streetCheck";

const RouteMap = dynamic(() => import("@/components/RouteMap"), {
  ssr: false,
  loading: () => <div className="h-[min(70vh,520px)] w-full animate-pulse rounded-xl bg-neutral-200" />,
});

type View = "day" | "edit" | "preview" | "review";

type TripState = { state: "building" | "added" | "failed"; message?: string };

const KINDS: ManeuverKind[] = ["proceed", "left", "right", "turnaround"];
const KIND_LABEL: Record<ManeuverKind, string> = {
  proceed: "Proceed on",
  left: "Left onto",
  right: "Right onto",
  turnaround: "Turn around on",
};

function emptySheet(): Sheet {
  return { route: "", description: "", run: "", stops: [] };
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const noSubscribe = () => () => {};

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
  const [ready, setReady] = useState(false);
  const [stored, setStored] = useState(true);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [area, setArea] = useState("Wake County, North Carolina");
  const [text, setText] = useState("");
  const [sheet, setSheet] = useState<Sheet>(emptySheet());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [loadedArea, setLoadedArea] = useState("");
  const [route, setRoute] = useState<RouteSuccess | null>(null);
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
  // Fresh lookups of names the loaded map doesn't have, keyed by the typed text.
  const [lookups, setLookups] = useState<Record<string, { state: "looking" | "found" | "none"; name?: string }>>({});
  const [recheckTick, setRecheckTick] = useState(0);
  const [undo, setUndo] = useState<{ stop: Sheet["stops"][number]; at: number } | null>(null);
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
    setUndo({ stop, at: si });
  }

  function undoDelete() {
    if (!undo) return;
    const stops = sheet.stops.slice();
    stops.splice(Math.min(undo.at, stops.length), 0, undo.stop);
    setSheet({ ...sheet, stops });
    setUndo(null);
  }

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 10000);
    return () => clearTimeout(t);
  }, [undo]);

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
    loadDay().then((saved) => {
      setRuns(saved);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    saveDay(runs).then(setStored);
  }, [runs, ready]);

  const warnCount = (run: SavedRun) => run.warnings.filter((w) => w.level === "warn").length;

  function openNew() {
    setEditingId(null);
    setText("");
    setSheet(emptySheet());
    setRoute(null);
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
    setText(run.sheetText);
    setArea(run.area || area);
    const parsed = parseSheet(run.sheetText);
    setSheet(parsed.stops.length ? parsed : emptySheet());
    setRoute(null);
    setMapData(null);
    setOverrides({ vias: run.vias ?? [] });
    setError("");
    setView("edit");
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
      warnings: result.warnings.map((w) => ({ level: w.level, message: w.message })),
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

  async function generate(nextOverrides = overrides) {
    setError("");
    let current = sheet;
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
    setStatus("Building the route…");
    try {
      const data = mapData && loadedArea === area ? mapData : await cachedMap(current, area, setStatus);
      setMapData(data);
      setLoadedArea(area);
      setStatus("Following the printed streets…");
      const result = await routeSheet(current, data, nextOverrides, osrmRouter);
      if (!result.ok) {
        setError(result.error);
        setStatus("");
        return;
      }
      setRoute(result);
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
      setError(err instanceof Error ? err.message : "The route could not be built.");
      setStatus("");
    }
  }

  function onMapClick(lat: number, lon: number) {
    if (!route || !tapMode || status) return;
    if (tapMode === "turn" && pick) {
      const next = { ...overrides, turnarounds: { ...overrides.turnarounds, [pick]: { lat, lon } } };
      void generate(next);
      return;
    }
    if (tapMode === "via") {
      const vias = [...(overrides.vias ?? []), { lat, lon }];
      const next = { ...overrides, vias };
      setOverrides(next);
      void generate(next);
    }
  }

  function saveToDay() {
    if (!route) return;
    const saved = savedRunFrom(editingId ?? newId(), text, sheet, route, overrides.vias ?? []);
    setMapRun(saved.id);
    if (reviewKey) {
      // Built from the review list: add it to the day by time and go back to the other trips.
      const key = reviewKey;
      const states = { ...tripStates, [key]: { state: "added" as const } };
      setRuns((prev) => mergeIntoDay(prev, [saved]));
      setTripStates(states);
      setTripEdits((prev) => ({ ...prev, [key]: { text, sheet } }));
      setReviewKey(null);
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
    setView("day");
  }

  function move(index: number, dir: -1 | 1) {
    setRuns((prev) => {
      const j = index + dir;
      if (j < 0 || j >= prev.length) return prev;
      const copy = prev.slice();
      [copy[index], copy[j]] = [copy[j], copy[index]];
      return copy;
    });
  }

  async function shareAll() {
    if (!runs.length) return;
    setError("");
    const used = new Set<string>();
    const files = runs.map((run, i) => ({ name: gpxFileName(run.run, i, used), text: run.gpx }));
    await shareOrDownload(files, `${files.length} runs`);
  }

  async function exportDay() {
    if (!runs.length) return;
    setError("");
    const deadheads: DeadheadLeg[] = [];
    for (let i = 0; i < runs.length - 1; i++) {
      const a = runs[i].coords.at(-1);
      const b = runs[i + 1].coords[0];
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
    const gpx = buildDayGpx(runs, deadheads);
    downloadBlob(`day_${runs.length}_runs.gpx`, new Blob([gpx], { type: "application/gpx+xml" }));
  }

  const previewStops = useMemo(
    () => route?.stops.map((s) => ({ lat: s.lat, lon: s.lon, label: `${s.time} ${s.description}` })) ?? [],
    [route],
  );

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col bg-[#f6f3ea] text-[#142033]">
      <header className="border-b border-[#d9d2c3] bg-[#0f2744] px-4 py-4 text-white">
        <p className="text-xs font-semibold tracking-wide text-[#f5c451]">WCPSS trip sheets</p>
        <h1 className="text-2xl font-semibold leading-tight">Streets into an OsmAnd track</h1>
        <p className="mt-1 text-sm text-[#d6deea]">
          Photos stay on this phone. Nothing is saved on a server.
          {stored ? "" : " This browser will forget the day list when you leave."}
        </p>
      </header>

      {status && <p className="bg-[#f5c451] px-4 py-2 text-sm font-medium text-[#142033]">{status}</p>}
      {error && (
        <p className="bg-[#7f1d1d] px-4 py-2 text-sm text-white" role="alert">
          {error}
        </p>
      )}

      {view === "day" && (
        <section className="flex flex-1 flex-col gap-3 px-4 py-4 pb-40">
          {!ready && <p className="text-sm">Opening today’s list…</p>}
          {ready && runs.length === 0 && (
            <div className="rounded-xl bg-white p-4 ring-1 ring-[#d9d2c3]">
              <p className="text-lg font-semibold">No runs yet today</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed">
                <li>Photograph each trip sheet, choose a PDF, or paste the text.</li>
                <li>Fix anything the reader got wrong.</li>
                <li>Add the run to this list, in the order you drive them.</li>
                <li>Download one track for the day, or a zip of separate tracks.</li>
              </ol>
            </div>
          )}
          {runs.map((run, i) => (
            <article key={run.id} className="rounded-xl bg-white p-3 ring-1 ring-[#d9d2c3]">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold text-[#0f2744]">Run {i + 1}</p>
                  <h2 className="text-lg font-semibold leading-tight">
                    {run.route || "Route"} {run.run && <span className="text-base font-medium">{run.run}</span>}
                  </h2>
                  <p className="text-sm">{run.description || "Untitled sheet"}</p>
                  <p className="text-sm text-[#3d4b63]">
                    {run.firstTime} · {run.miles.toFixed(2)} mi
                    {warnCount(run) > 0 ? ` · ${warnCount(run)} to check` : ""}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <Button type="button" variant="outline" className="h-10 px-3" onClick={() => move(i, -1)} disabled={i === 0}>
                    Up
                  </Button>
                  <Button type="button" variant="outline" className="h-10 px-3" onClick={() => move(i, 1)} disabled={i === runs.length - 1}>
                    Down
                  </Button>
                </div>
              </div>
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
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" className="h-10" onClick={() => setMapRun(mapRun === run.id ? null : run.id)} disabled={run.coords.length < 2}>
                  {mapRun === run.id ? "Hide map" : "Map"}
                </Button>
                <Button type="button" variant="outline" className="h-10" onClick={() => openEdit(run)}>
                  Edit
                </Button>
                <Button type="button" variant="outline" className="h-10" onClick={() => downloadBlob(runFileName(i, run), new Blob([run.gpx], { type: "application/gpx+xml" }))}>
                  This GPX
                </Button>
                <Button type="button" variant="destructive" className="h-10" onClick={() => setRuns((prev) => prev.filter((r) => r.id !== run.id))}>
                  Remove
                </Button>
              </div>
            </article>
          ))}
          <div className="fixed inset-x-0 bottom-0 border-t border-[#d9d2c3] bg-[#f6f3ea] p-3">
            <div className="mx-auto flex max-w-lg flex-col gap-2">
              <Button type="button" className="h-12 bg-[#0f2744] text-base text-white" onClick={openNew}>
                Add a run
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" className="h-12 text-sm" disabled={!runs.length} onClick={() => void exportDay()}>
                  One GPX for the day
                </Button>
                <Button type="button" variant="outline" className="h-12 text-sm" disabled={!runs.length} onClick={() => void shareAll()}>
                  {canShare ? "Share all" : "Download all"}
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}

      {view === "review" && (
        <section className="flex flex-col gap-3 px-4 py-4 pb-36">
          <p className="text-lg font-semibold">
            {trips.length} trips found. Check them, then build.
          </p>
          <p className="-mt-2 text-sm text-[#3d4b63]">Tap a trip to see its stops and directions.</p>
          <ul className="space-y-2">
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
                    className="block w-full touch-manipulation rounded-xl bg-white p-3 text-left ring-1 ring-[#d9d2c3] active:bg-[#eef2f7]"
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
          <div className="fixed inset-x-0 bottom-0 border-t border-[#d9d2c3] bg-[#f6f3ea] p-3">
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
        <section className="flex flex-col gap-3 px-4 py-4 pb-48">
          {reviewTrip && (
            <div className="rounded-xl bg-white p-3 ring-1 ring-[#d9d2c3]" data-trip-open={reviewTrip.run || reviewTrip.key}>
              <p className="text-lg font-semibold">
                Run {reviewTrip.run || "?"} · {reviewTrip.pages.length === 1 ? "1 page" : `${reviewTrip.pages.length} pages`}
              </p>
              <p className="text-sm text-[#3d4b63]">Check the streets: a red ? means the map doesn’t know that name. Tap it for close matches.</p>
              <PageThumbs pages={reviewTrip.pages} onOpen={setBigThumb} />
            </div>
          )}
          <Tucked away={!!reviewTrip}>
          <label className="text-sm font-medium">
            Area
            <Input className="mt-1 h-12 bg-white text-base" value={area} onChange={(e) => setArea(e.target.value)} />
          </label>
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
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={readPasted}>
              Read the text
            </Button>
            {!reviewTrip && (
              <Button type="button" variant="outline" className="h-11 flex-1" onClick={() => applyText(EXAMPLE_SHEET_TEXT)}>
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
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Input className="h-12 bg-white text-base" value={sheet.route} placeholder="Route" aria-label="Route" onChange={(e) => setSheet({ ...sheet, route: e.target.value })} />
                <Input className="h-12 bg-white text-base" value={sheet.run} placeholder="Run" aria-label="Run" onChange={(e) => setSheet({ ...sheet, run: e.target.value })} />
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
                  <div key={si} className="rounded-xl bg-white p-3 ring-1 ring-[#d9d2c3]" data-stop={si}>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold">Stop {si + 1}</p>
                      <button
                        type="button"
                        className="h-11 touch-manipulation rounded-lg border border-[#d9d2c3] bg-white px-3 text-base text-[#7f1d1d]"
                        aria-label={`Delete stop ${si + 1}`}
                        onClick={() => deleteStop(si)}
                      >
                        Delete
                      </button>
                    </div>
                    <div className="flex items-end gap-2">
                      <Input className="h-12 w-32 shrink-0 bg-white text-base" value={stop.time} aria-label="Stop time" onChange={(e) => setSheet({ ...sheet, stops: sheet.stops.map((s, i) => (i === si ? { ...s, time: e.target.value } : s)) })} />
                      <StreetMark state={stopCheck.state} open={suggestFor === sid} onTap={() => void tapMark(sid, stopCheck.missing)} />
                    </div>
                    <WrapField
                      className="mt-2"
                      value={stop.description}
                      label="Stop place"
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
                    <ul className="mt-2 space-y-2">
                      {stop.maneuvers.map((m, mi) => {
                        const st = streetState(m.street);
                        const mid = `${si}-${mi}`;
                        return (
                          <li key={mi} className="rounded-lg bg-[#f6f3ea] p-2">
                            <div className="flex items-center gap-2">
                              <select
                                className="h-12 min-w-0 flex-1 rounded-lg border border-[#d9d2c3] bg-white px-2 text-base"
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
                              <StreetMark state={st.state} open={suggestFor === mid} onTap={() => void tapMark(mid, st.state === "found" ? [] : [m.street])} />
                              <button
                                type="button"
                                className="h-12 touch-manipulation rounded-lg border border-[#d9d2c3] bg-white px-3 text-base"
                                aria-label="Delete this direction"
                                onClick={() => setSheet({ ...sheet, stops: sheet.stops.map((s, i) => (i === si ? { ...s, maneuvers: s.maneuvers.filter((_, j) => j !== mi) } : s)) })}
                              >
                                ✕
                              </button>
                            </div>
                            <WrapField
                              className="mt-2"
                              value={m.street}
                              label="Street"
                              onChange={(street) => updateManeuver(si, mi, { street })}
                              onBlur={() => void recheckSoon()}
                            />
                            {st.label && <p className="mt-1 text-xs text-[#15803d]">On the map: {st.label}</p>}
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
                      className="mt-2 h-10"
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
          {undo && (
            <div className="fixed inset-x-0 bottom-20 z-40 px-3" role="status">
              <div className="mx-auto flex max-w-lg items-center justify-between gap-2 rounded-lg bg-[#142033] px-3 py-2 text-sm text-white shadow-lg">
                <span>Stop deleted.</span>
                <button type="button" className="h-10 rounded-md bg-[#f5c451] px-4 font-semibold text-[#142033]" onClick={undoDelete}>
                  Undo
                </button>
              </div>
            </div>
          )}
          <div className="fixed inset-x-0 bottom-0 border-t border-[#d9d2c3] bg-[#f6f3ea] p-3">
            <div className="mx-auto flex max-w-lg flex-col gap-2">
              {status && <p className="text-sm font-medium">{status}</p>}
              {error && <p className="text-sm text-[#7f1d1d]">{error}</p>}
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="h-12 flex-1" onClick={() => (reviewTrip ? backToTrips() : setView("day"))}>
                  {reviewTrip ? "Back to trips" : "Back"}
                </Button>
                <Button type="button" className="h-12 flex-[2] bg-[#0f2744] text-base text-white disabled:opacity-100" disabled={(!sheet.stops.length && !text.trim()) || !!status} onClick={() => void generate()}>
                  {status ? "Building…" : "Build the route"}
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}

      {view === "preview" && route && (
        <section className="flex flex-col gap-3 px-4 py-4 pb-56">
          <p className="text-lg font-semibold">
            {route.miles.toFixed(2)} miles · {sheet.route} {sheet.run}
          </p>
          <div className="relative">
            <RouteMap
              coords={route.coords}
              stops={previewStops}
              turnarounds={route.turnarounds}
              vias={overrides.vias ?? []}
              selectedTurnaround={pick}
              picking={tapMode === "via"}
              onMapClick={onMapClick}
            />
            {tapMode === "via" && (
              <p className="pointer-events-none absolute inset-x-2 top-2 rounded-lg bg-[#0f2744] px-3 py-2 text-sm font-medium text-white">
                Tap the road. A blue dot is a point the track must pass.
              </p>
            )}
          </div>
          <p className="text-sm text-[#3d4b63]">
            {tapMode === "turn" && pick
              ? "Tap the map where the bus actually turns around."
              : tapMode === "via"
                ? "Tap the road. A blue dot is added and the track is rebuilt through it."
                : "A via point pulls the track through a spot you tap. Blue dots stay on the line. Orange dots are guessed turnarounds."}
          </p>
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
                void generate(next);
              }}
            >
              Clear {overrides.vias?.length} via {overrides.vias?.length === 1 ? "point" : "points"}
            </Button>
          )}
          <ul className="space-y-2">
            {route.warnings.map((w, i) => (
              <li key={i} className={`rounded-lg px-3 py-2 text-sm ${w.level === "warn" ? "bg-[#ffedd5]" : "bg-white ring-1 ring-[#d9d2c3]"}`}>
                {w.message}
              </li>
            ))}
          </ul>
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
                    }}
                  >
                    Move
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[#d9d2c3] bg-[#f6f3ea] p-3">
            <div className="mx-auto flex max-w-lg flex-col gap-2">
              <Button
                type="button"
                className={`h-12 text-base ${tapMode === "via" ? "bg-[#f5c451] text-[#142033]" : "bg-[#0f2744] text-white"}`}
                onClick={() => setTapMode(tapMode === "via" ? null : "via")}
              >
                {tapMode === "via" ? "Tap the road on the map" : "Add a via point"}
              </Button>
              <Button type="button" className="h-12 bg-[#0f2744] text-base text-white" onClick={saveToDay}>
                Add to today’s list
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" className="h-12" onClick={() => setView("edit")}>
                  Edit directions
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-12"
                  onClick={() =>
                    downloadBlob(
                      runFileName(0, {
                        run: sheet.run,
                        description: sheet.description,
                        firstTime: sheet.stops[0]?.time ?? "",
                      }),
                      new Blob([buildGpx(sheet, route.coords, route.stops)], { type: "application/gpx+xml" }),
                    )
                  }
                >
                  Download GPX
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}
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
      className={`block w-full resize-none overflow-hidden rounded-lg border border-[#d9d2c3] bg-white px-3 py-2.5 text-base leading-snug break-words whitespace-pre-wrap ${multiline ? "min-h-36" : ""} ${className}`}
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
function Tucked({ away, children }: { away: boolean; children: React.ReactNode }) {
  if (!away) return <>{children}</>;
  return (
    <details className="rounded-xl bg-white p-3 ring-1 ring-[#d9d2c3]">
      <summary className="cursor-pointer text-sm font-medium">Sheet text and area</summary>
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
    <div className="w-full rounded-lg bg-[#fef2f2] p-2" data-suggest>
      {names.map((part) => {
        const options = looking ? [] : suggest(part);
        return (
          <div key={part} className="mb-1">
            <p className="text-sm">
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
                  className="h-11 touch-manipulation rounded-lg border border-[#d9d2c3] bg-white px-3 text-left text-base"
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
      <span className="flex h-11 w-9 items-center justify-center text-lg font-bold text-[#15803d]" aria-label="Street found on the map">
        ✓
      </span>
    );
  }
  if (state === "missing") {
    return (
      <button
        type="button"
        className={`h-11 w-9 rounded-lg text-lg font-bold text-white ${open ? "bg-[#7f1d1d]" : "bg-[#dc2626]"}`}
        aria-label="Street not found. Show close matches"
        onClick={onTap}
      >
        ?
      </button>
    );
  }
  if (state === "looking") {
    return (
      <span className="flex h-11 w-9 items-center justify-center" aria-label="Looking up the name">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#d9d2c3] border-t-[#0f2744]" />
      </span>
    );
  }
  if (state === "checking") {
    return <span className="flex h-11 w-9 items-center justify-center text-[#9ca3af]" aria-label="Checking the street">…</span>;
  }
  return <span className="w-9" aria-hidden />;
}
