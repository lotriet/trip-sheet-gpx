import { RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { lacksTurnPoints, turnPinsFromGpx } from "@/lib/dayPlan";
import { parseSheet } from "@/lib/engine/parseSheet";
import { sortStopsByTime } from "@/lib/batch";
import { RouteMap, warningPlace } from "./shared";
import { useTrip } from "./useTripState";

/** Today's runs: the saved list, the day GPX, rebuilding from a recorded drive. */
export function DayScreen() {
  const {
    view,
    runs,
    drafts,
    draftsReady,
    ready,
    rebuilding,
    notice,
    mapRun,
    setMapRun,
    exportingDay,
    canShare,
    sendLabel,
    unreviewedRuns,
    openNew,
    openEdit,
    resumeDraft,
    discardDraft,
    move,
    toggleRunLock,
    removeRun,
    setRunChecked,
    downloadRun,
    rebuildAllRuns,
    matchRecordings,
    removeAllRuns,
    allowBatchExport,
    shareAll,
    exportDay,
  } = useTrip();
  return (
    <>
        {view === "day" && (
          <section className="flex flex-1 flex-col gap-3 px-4 py-5 pb-48 sm:px-6">
            {!ready && <p className="text-sm">Opening today’s list…</p>}
            {ready && runs.length === 0 && (
              <div className="rounded-2xl border border-[#e1e6ed] bg-white p-5 shadow-sm">
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-[#e8eff8] text-xl text-[#173b64]">＋</div>
                <p className="text-lg font-bold tracking-tight">Start with a trip sheet</p>
                <p className="mt-1 text-sm leading-relaxed text-[#586579]">Add photos, a PDF, or copied text. Check the stops and directions, then build a route to open in GPX Nav.</p>
              </div>
            )}
            {runs.length > 0 && (
              <div className="flex items-center justify-between gap-3 px-1 pb-1">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#68758a]">Today’s route list</p>
                  <p className="text-lg font-bold tracking-tight">{runs.length} {runs.length === 1 ? "run" : "runs"} · {runs.reduce((sum, run) => sum + run.miles, 0).toFixed(1)} mi</p>
                  <p className="text-xs leading-relaxed text-[#53627a]">Saved in this browser. GPX Nav gets them when you send them.</p>
                </div>
                <div className="flex items-center gap-2">
                  {runs.some((run) => !run.warningsAcknowledged && run.warnings.some((warning) => warning.level === "warn")) && (
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
            {unreviewedRuns.length > 0 && (
              <div className="rounded-xl border border-[#e5bd77] bg-[#fff8e9] p-3 text-sm text-[#59451f]" role="alert">
                <p className="font-semibold">Check the warnings on {unreviewedRuns.length} run{unreviewedRuns.length === 1 ? "" : "s"} before exporting the day.</p>
                <p className="mt-1 text-xs leading-relaxed">Read each run’s warnings (Show on map helps), then tap “I’ve checked these” on its card.</p>
                <Button type="button" variant="outline" className="mt-2 h-8 bg-white px-2.5 text-xs font-semibold" onClick={() => allowBatchExport()} disabled={exportingDay}>
                  Go to {unreviewedRuns[0].route || "run"} {unreviewedRuns[0].run}
                </Button>
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
              const notes = run.warnings.filter((w) => w.level === "info" && w.message.startsWith("One-way direction data"));
              const runStops = sortStopsByTime(parseSheet(run.sheetText)).stops;
                  return (
              <article key={run.id} data-warning-run={warnings.length && !run.warningsAcknowledged ? run.id : undefined} className="rounded-2xl border border-[#dce3ec] bg-white p-3.5 shadow-[0_4px_14px_rgba(24,39,62,0.07)] transition-shadow hover:shadow-[0_7px_20px_rgba(24,39,62,0.1)]">
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
                      {run.driven && <span className="rounded-full bg-[#fdf0dc] px-2 py-0.5 text-[0.68rem] font-bold text-[#8a5a12]">Recorded drive</span>}
                      {(!warnings.length || run.warningsAcknowledged) && <span className="rounded-full bg-[#e7f3eb] px-2 py-0.5 text-[0.68rem] font-bold text-[#216338]">Ready</span>}
                    </div>
                    <p className="mt-0.5 truncate text-sm font-medium text-[#46546a]">{run.description || "Untitled sheet"}</p>
                    <p className="mt-1 text-xs font-medium text-[#68758a]">{run.firstTime} <span className="px-1 text-[#a5afbd]">·</span> {run.miles.toFixed(2)} miles</p>
                  </div>
                  <button
                    type="button"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#8a2a2a] hover:bg-[#fbeaea] disabled:opacity-30"
                    onClick={() => removeRun(run)}
                    disabled={exportingDay}
                    aria-label={`Remove run ${[run.route, run.run].filter(Boolean).join(" ") || i + 1}`}
                    title={run.locked ? "Remove (protected — asks first)" : "Remove run"}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
                {warnings.length > 0 && (
                  <div className={`mt-3 rounded-xl border border-[#f0d28d] border-l-4 border-l-[#d28b16] p-3 ${run.warningsAcknowledged ? "bg-[#fffdf5]" : "bg-[#fff9ea]"}`} role={run.warningsAcknowledged ? "status" : "alert"}>
                    <p className="text-xs font-bold uppercase tracking-wide text-[#80540b]">{run.warningsAcknowledged ? `Reviewed · ${warnings.length} warning${warnings.length === 1 ? "" : "s"} still on route` : `Needs a quick check · ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`}</p>
                    <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-[#463716]">
                      {warnings.map((warning, n) => {
                        const where = warningPlace(runStops, warning);
                        return <li key={n}>{where && <strong className="font-semibold">{where}: </strong>}{warning.message}</li>;
                      })}
                    </ul>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {run.warningsAcknowledged ? (
                        <Button type="button" variant="outline" className="h-9 border-[#e5c981] bg-white px-3 text-sm font-semibold text-[#68470b]" onClick={() => setRunChecked(run.id, false)} disabled={exportingDay}>
                          Undo checked
                        </Button>
                      ) : (
                        <Button type="button" className="h-9 bg-[#173b64] px-3 text-sm font-semibold text-white" onClick={() => setRunChecked(run.id, true)} disabled={exportingDay}>
                          I’ve checked these
                        </Button>
                      )}
                      <Button type="button" variant="outline" className="h-9 border-[#e5c981] bg-white px-3 text-sm font-semibold text-[#68470b]" onClick={() => setMapRun(mapRun === run.id ? null : run.id)} disabled={run.coords.length < 2}>
                        {mapRun === run.id ? "Hide map" : "Show on map"}
                      </Button>
                      {warnings.some((w) => w.message.startsWith("Turnaround on")) && (
                        <Button type="button" variant="outline" className="h-9 border-[#e5c981] bg-white px-3 text-sm font-semibold text-[#68470b]" onClick={() => openEdit(run, true)} disabled={exportingDay}>
                          Move turnaround
                        </Button>
                      )}
                      <Button type="button" variant="outline" className="h-9 border-[#e5c981] bg-white px-3 text-sm font-semibold text-[#68470b]" onClick={() => openEdit(run)} disabled={exportingDay}>
                        Fix in editor
                      </Button>
                    </div>
                  </div>
                )}
                {notes.map((note, n) => (
                  <p key={`note-${n}`} className="mt-2 text-xs leading-relaxed text-[#68758a]">Note: {note.message}</p>
                ))}
                {lacksTurnPoints(run.gpx) && (
                  <p className="mt-2 rounded-lg border border-[#e5c981] bg-[#fff8e6] px-3 py-2 text-sm text-[#463716]">
                    Built before exact turn points. Tap Edit and build it again so GPX Nav gets each turn’s exact spot.
                  </p>
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
                      turns={turnPinsFromGpx(run.gpx)}
                      warningStops={warnings.flatMap((w) => {
                        if (w.location) return [{ lat: w.location[1], lon: w.location[0], label: w.message }];
                        const stop = typeof w.stopIndex === "number" ? run.stops[w.stopIndex] : undefined;
                        return stop ? [{ lat: stop.lat, lon: stop.lon, label: w.message }] : [];
                      })}
                    />
                    <p className="mt-1 text-sm text-[#3d4b63]">Red circles mark warnings. L, R and U pins are the turns (amber: not confirmed). Blue dots are via points.</p>
                  </div>
                )}
                <div className="mt-3 grid grid-cols-3 gap-1.5 border-t border-[#edf0f4] pt-2.5">
                  <Button type="button" variant="outline" className="h-9 border-[#dce3ed] bg-[#f8fafc] text-xs font-semibold text-[#34445c]" onClick={() => setMapRun(mapRun === run.id ? null : run.id)} disabled={run.coords.length < 2}>
                    {mapRun === run.id ? "Hide map" : "Map"}
                  </Button>
                  <Button type="button" variant="outline" className="h-9 border-[#dce3ed] bg-[#f8fafc] text-xs font-semibold text-[#34445c]" onClick={() => openEdit(run)} disabled={exportingDay}>
                    Edit
                  </Button>
                  <Button type="button" variant="outline" className="h-9 border-[#dce3ed] bg-[#f8fafc] text-xs font-semibold text-[#34445c]" onClick={() => downloadRun(run, i)}>
                    {sendLabel}
                  </Button>
                </div>
                <details className="mt-2 border-t border-[#edf0f4] pt-2">
                  <summary className="w-fit cursor-pointer select-none text-xs font-semibold text-[#68758a]">More options</summary>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button type="button" variant="outline" className={`h-8 px-2.5 text-xs ${run.locked ? "border-[#abd0b5] bg-[#f0f8f2] text-[#216338]" : "border-[#dce3ed] bg-white text-[#34445c]"}`} onClick={() => toggleRunLock(run.id)} disabled={exportingDay} aria-pressed={!!run.locked}>
                      {run.locked ? "Unlock GPX" : "Protect GPX"}
                    </Button>
                    <Button type="button" variant="destructive" className="h-8 px-2.5 text-xs" onClick={() => removeRun(run)} disabled={exportingDay}>
                      Remove run
                    </Button>
                  </div>
                </details>
              </article>
              );
            })}
            {runs.length > 0 && (
              <div className="flex flex-col items-center gap-1">
                <Button type="button" variant="outline" className="h-9 border-[#c9d6ea] bg-white px-3 text-xs font-semibold text-[#173b64]" onClick={() => void rebuildAllRuns()} disabled={exportingDay || rebuilding}>
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${rebuilding ? "animate-spin" : ""}`} aria-hidden />
                  {rebuilding ? "Rebuilding…" : runs.length === 1 ? "Rebuild with latest app" : "Rebuild all with latest app"}
                </Button>
                <label className={`inline-flex h-9 cursor-pointer items-center rounded-md border border-[#c9d6ea] bg-white px-3 text-xs font-semibold text-[#173b64] ${exportingDay || rebuilding ? "pointer-events-none opacity-50" : ""}`}>
                  Match stops to a recorded drive
                  <input type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml" multiple className="sr-only" disabled={exportingDay || rebuilding} onChange={(e) => { void matchRecordings(e.currentTarget.files); e.currentTarget.value = ""; }} />
                </label>
                <label className={`inline-flex h-9 cursor-pointer items-center rounded-md border border-[#c9d6ea] bg-white px-3 text-xs font-semibold text-[#173b64] ${exportingDay || rebuilding ? "pointer-events-none opacity-50" : ""}`}>
                  Use a recorded drive as the route
                  <input type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml" multiple className="sr-only" disabled={exportingDay || rebuilding} onChange={(e) => { void matchRecordings(e.currentTarget.files, true); e.currentTarget.value = ""; }} />
                </label>
                <p className="text-center text-xs text-[#68758a]">Saved runs keep the route they were built with. Rebuild after an app update. A GPX recorded on the drive moves stops with warnings to where the bus stopped, or becomes the route itself: the road you drove, with the sheet&apos;s stops and turns on it. Recorded-drive runs send as their own day in GPX Nav.</p>
                {notice && <p className="text-center text-sm font-medium text-[#216338]">{notice}</p>}
              </div>
            )}
            {runs.length > 1 && (
              <div className="flex justify-center">
                <Button type="button" variant="outline" className="h-9 border-[#ecc9c9] bg-white px-3 text-xs font-semibold text-[#8a2a2a]" onClick={removeAllRuns} disabled={exportingDay}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  Remove all runs
                </Button>
              </div>
            )}
            <div className="fixed inset-x-0 bottom-0 z-[1200] border-t border-[#dce3ec] bg-white p-3 shadow-[0_-8px_28px_rgba(24,39,62,0.12)]">
              <div className="mx-auto flex max-w-2xl flex-col gap-2">
                <Button type="button" className="h-11 rounded-xl bg-[#173b64] text-sm font-bold text-white shadow-sm" onClick={openNew} disabled={exportingDay}>
                  Add a run
                </Button>
                {runs.length > 0 && (<>
                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" className="h-10 rounded-xl border-[#dce3ec] bg-[#f8fafc] text-xs font-semibold" disabled={!runs.length || exportingDay} aria-describedby={unreviewedRuns.length ? "export-needs-review" : undefined} onClick={() => void exportDay()}>
                    {exportingDay ? "Preparing GPX…" : "Whole day as 1 file"}
                  </Button>
                  <Button type="button" variant="outline" className="h-10 rounded-xl border-[#dce3ec] bg-[#f8fafc] text-xs font-semibold" disabled={!runs.length || exportingDay} aria-describedby={unreviewedRuns.length ? "export-needs-review" : undefined} onClick={() => void shareAll()}>
                    {exportingDay ? "Preparing GPX…" : `Each run (${runs.length} ${runs.length === 1 ? "file" : "files"})`}
                  </Button>
                </div>
                {unreviewedRuns.length > 0 ? (
                  // Shown here, next to the buttons, because the list's own notice is off screen.
                  <p id="export-needs-review" className="text-center text-xs font-semibold leading-relaxed text-[#80540b]">
                    Check the warnings on {unreviewedRuns.map((run) => `run ${runs.indexOf(run) + 1}`).join(", ")} first. Tap a button to go there.
                  </p>
                ) : (
                  <p className="text-center text-xs leading-relaxed text-[#3d4b63]">{canShare
                    ? "When the share sheet opens, tap GPX Nav (under More if you don’t see it)."
                    : "Files go to your Downloads folder; open them from there with GPX Nav."}</p>
                )}
                </>)}
              </div>
            </div>
          </section>
        )}

    </>
  );
}
