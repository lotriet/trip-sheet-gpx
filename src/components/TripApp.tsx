"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EXAMPLE_SHEET_TEXT } from "@/lib/exampleSheet";
import { buildDayGpx, runFileName, type DeadheadLeg } from "@/lib/dayPlan";
import { driveBetween } from "@/lib/engine/drive";
import { buildGpx } from "@/lib/engine/gpx";
import { parseSheet } from "@/lib/engine/parseSheet";
import { routeSheet } from "@/lib/engine/route";
import type { LonLat, Maneuver, ManeuverKind, RouteOverrides, RouteSuccess, Sheet, TurnaroundPin } from "@/lib/engine/types";
import { loadCorridor, loadMap, type MapData } from "@/lib/mapfetch";
import { readSheetPhotos } from "@/lib/ocr";
import { RETAKE_MESSAGE } from "@/lib/ocr/quality";
import { loadDay, saveDay, type SavedRun } from "@/lib/storage";
import { zipStore } from "@/lib/zipStore";

const RouteMap = dynamic(() => import("@/components/RouteMap"), {
  ssr: false,
  loading: () => <div className="h-[min(70vh,520px)] w-full animate-pulse rounded-xl bg-neutral-200" />,
});

type View = "day" | "edit" | "preview";

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
    setOverrides({});
    setError("");
    setView("edit");
  }

  function applyText(raw: string) {
    setText(raw);
    const parsed = parseSheet(raw);
    if (!parsed.stops.length) {
      setError("No stops were found in that text. Check the times and street lines, then try again.");
      return;
    }
    setError("");
    setSheet(parsed);
  }

  async function onPhotos(input: HTMLInputElement) {
    const files = input.files ? Array.from(input.files) : [];
    // Let the same photo be picked again after a retake.
    input.value = "";
    if (!files.length) return;
    setError("");
    let results: Awaited<ReturnType<typeof readSheetPhotos>> = [];
    try {
      results = await readSheetPhotos(files, setStatus);
    } catch {
      setStatus("");
      setError("The text reader didn't load. Check the internet connection and try again, or type the directions.");
      return;
    }
    setStatus("");
    const good = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    if (good.length) applyText([text, ...good.map((r) => r.text)].filter(Boolean).join("\n"));
    const notes: string[] = [];
    if (bad.length) {
      notes.push(
        results.length === 1
          ? bad[0].reason
          : `Couldn't read ${bad.length} of ${results.length} photos (${bad.map((r) => r.name).join(", ")}). ${RETAKE_MESSAGE.replace("Couldn't read this photo. ", "")}`,
      );
    }
    const runNumbers = [...new Set(good.map((r) => r.text.match(/\brun\s*:\s*([0-9]{3}\s?\.\s?[0-9]{2,3})/i)?.[1]?.replace(/\s/g, "")).filter(Boolean))];
    if (runNumbers.length > 1) {
      notes.push(`These photos are from ${runNumbers.length} different runs (${runNumbers.join(", ")}). Add each run on its own so each gets its own track.`);
    }
    if (notes.length) setError(notes.join(" "));
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
      const data = mapData && loadedArea === area ? mapData : await loadMap(current, area, setStatus);
      setMapData(data);
      setLoadedArea(area);
      setStatus("Following the printed streets…");
      const result = routeSheet(current, data, nextOverrides);
      if (!result.ok) {
        setError(result.error);
        setStatus("");
        return;
      }
      setRoute(result);
      setOverrides(nextOverrides);
      setView("preview");
      setStatus("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The route could not be built.");
      setStatus("");
    }
  }

  function onMapClick(lat: number, lon: number) {
    if (!route || !tapMode) return;
    if (tapMode === "turn" && pick) {
      const next = { ...overrides, turnarounds: { ...overrides.turnarounds, [pick]: { lat, lon } } };
      void generate(next);
      return;
    }
    if (tapMode === "via") {
      const vias = [...(overrides.vias ?? []), { lat, lon }];
      void generate({ ...overrides, vias });
    }
  }

  function saveToDay() {
    if (!route) return;
    const saved: SavedRun = {
      id: editingId ?? newId(),
      area,
      sheetText: text || prettyText(sheet),
      route: sheet.route,
      description: sheet.description,
      run: sheet.run,
      firstTime: sheet.stops[0]?.time ?? "",
      miles: route.miles,
      gpx: route.gpx,
      coords: route.coords,
      stops: route.stops.map((s) => ({ time: s.time, description: s.description, lat: s.lat, lon: s.lon })),
      warnings: route.warnings.map((w) => ({ level: w.level, message: w.message })),
    };
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

  async function exportDay(kind: "gpx" | "zip") {
    if (!runs.length) return;
    setError("");
    if (kind === "zip") {
      const files = runs.map((run, i) => ({
        name: runFileName(i, run),
        text: run.gpx,
      }));
      const bytes = zipStore(files);
      downloadBlob(`day_${runs.length}_runs.zip`, new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" }));
      return;
    }
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
                <li>Photograph each trip sheet, or paste the text.</li>
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
              <div className="mt-2 flex gap-2">
                <Button type="button" variant="outline" className="h-10 flex-1" onClick={() => openEdit(run)}>
                  Edit
                </Button>
                <Button type="button" variant="outline" className="h-10 flex-1" onClick={() => downloadBlob(runFileName(i, run), new Blob([run.gpx], { type: "application/gpx+xml" }))}>
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
                <Button type="button" variant="outline" className="h-12 text-sm" disabled={!runs.length} onClick={() => void exportDay("gpx")}>
                  One GPX for the day
                </Button>
                <Button type="button" variant="outline" className="h-12 text-sm" disabled={!runs.length} onClick={() => void exportDay("zip")}>
                  Zip of separate GPX
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}

      {view === "edit" && (
        <section className="flex flex-col gap-3 px-4 py-4 pb-36">
          <label className="text-sm font-medium">
            Area
            <Input className="mt-1 h-12 bg-white text-base" value={area} onChange={(e) => setArea(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex h-12 cursor-pointer items-center justify-center rounded-lg bg-[#0f2744] text-sm font-medium text-white">
              Take photos
              <input className="sr-only" type="file" accept="image/*,.heic,.heif" capture="environment" multiple onChange={(e) => void onPhotos(e.currentTarget)} />
            </label>
            <label className="flex h-12 cursor-pointer items-center justify-center rounded-lg bg-white text-sm font-medium ring-1 ring-[#d9d2c3]">
              Choose photos
              <input className="sr-only" type="file" accept="image/*,.heic,.heif" multiple onChange={(e) => void onPhotos(e.currentTarget)} />
            </label>
          </div>
          <label className="text-sm font-medium">
            Sheet text
            <Textarea className="mt-1 min-h-36 bg-white font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the trip sheet, or it will fill in from the photos." />
          </label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={() => applyText(text)}>
              Read the text
            </Button>
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={() => applyText(EXAMPLE_SHEET_TEXT)}>
              Load a fake example
            </Button>
          </div>
          {sheet.stops.length > 0 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Input className="h-11 bg-white text-base" value={sheet.route} placeholder="Route" onChange={(e) => setSheet({ ...sheet, route: e.target.value })} />
                <Input className="h-11 bg-white text-base" value={sheet.run} placeholder="Run" onChange={(e) => setSheet({ ...sheet, run: e.target.value })} />
                <Input className="col-span-2 h-11 bg-white text-base" value={sheet.description} placeholder="Description" onChange={(e) => setSheet({ ...sheet, description: e.target.value })} />
              </div>
              {sheet.stops.map((stop, si) => (
                <div key={si} className="rounded-xl bg-white p-3 ring-1 ring-[#d9d2c3]">
                  <div className="flex gap-2">
                    <Input className="h-11 w-28 bg-white text-base" value={stop.time} onChange={(e) => setSheet({ ...sheet, stops: sheet.stops.map((s, i) => (i === si ? { ...s, time: e.target.value } : s)) })} />
                    <Input className="h-11 flex-1 bg-white text-base" value={stop.description} onChange={(e) => setSheet({ ...sheet, stops: sheet.stops.map((s, i) => (i === si ? { ...s, description: e.target.value } : s)) })} />
                  </div>
                  <ul className="mt-2 space-y-2">
                    {stop.maneuvers.map((m, mi) => (
                      <li key={mi} className="flex gap-2">
                        <select
                          className="h-11 rounded-lg border border-[#d9d2c3] bg-white px-2 text-sm"
                          value={m.kind}
                          onChange={(e) => updateManeuver(si, mi, { kind: e.target.value as ManeuverKind })}
                        >
                          {KINDS.map((k) => (
                            <option key={k} value={k}>
                              {KIND_LABEL[k]}
                            </option>
                          ))}
                        </select>
                        <Input className="h-11 flex-1 bg-white text-base" value={m.street} onChange={(e) => updateManeuver(si, mi, { street: e.target.value })} />
                        <Button type="button" variant="outline" className="h-11" onClick={() => setSheet({ ...sheet, stops: sheet.stops.map((s, i) => (i === si ? { ...s, maneuvers: s.maneuvers.filter((_, j) => j !== mi) } : s)) })}>
                          ✕
                        </Button>
                      </li>
                    ))}
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
              ))}
            </div>
          )}
          <div className="fixed inset-x-0 bottom-0 border-t border-[#d9d2c3] bg-[#f6f3ea] p-3">
            <div className="mx-auto flex max-w-lg gap-2">
              <Button type="button" variant="outline" className="h-12 flex-1" onClick={() => setView("day")}>
                Back
              </Button>
              <Button type="button" className="h-12 flex-[2] bg-[#0f2744] text-base text-white" disabled={(!sheet.stops.length && !text.trim()) || !!status} onClick={() => void generate()}>
                Build the route
              </Button>
            </div>
          </div>
        </section>
      )}

      {view === "preview" && route && (
        <section className="flex flex-col gap-3 px-4 py-4 pb-40">
          <p className="text-lg font-semibold">
            {route.miles.toFixed(2)} miles · {sheet.route} {sheet.run}
          </p>
          <RouteMap
            coords={route.coords}
            stops={previewStops}
            turnarounds={route.turnarounds}
            selectedTurnaround={pick}
            onMapClick={onMapClick}
          />
          <p className="text-sm text-[#3d4b63]">
            {tapMode === "turn" && pick
              ? "Tap the map where the bus actually turns around."
              : tapMode === "via"
                ? "Tap the map to add a point the track must pass."
                : "Orange dots are guessed turnarounds. Move one if the bus turns around somewhere else."}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant={tapMode === "via" ? "default" : "outline"} className="h-11 flex-1" onClick={() => setTapMode(tapMode === "via" ? null : "via")}>
              Add a via point
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11 flex-1"
              onClick={() => {
                setOverrides({ ...overrides, vias: [] });
                void generate({ ...overrides, vias: [] });
              }}
              disabled={!overrides.vias?.length}
            >
              Clear via points
            </Button>
          </div>
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
          <div className="fixed inset-x-0 bottom-0 border-t border-[#d9d2c3] bg-[#f6f3ea] p-3">
            <div className="mx-auto flex max-w-lg flex-col gap-2">
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

function prettyText(sheet: Sheet): string {
  const head = [`Route: ${sheet.route} Description: ${sheet.description} Run: ${sheet.run}`];
  for (const stop of sheet.stops) {
    head.push(`${stop.time} ${stop.description}`);
    for (const m of stop.maneuvers) head.push(`${KIND_LABEL[m.kind]} ${m.street}`);
  }
  return head.join("\n");
}
