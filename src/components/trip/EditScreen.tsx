import { LoaderCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EXAMPLE_SHEET_TEXT } from "@/lib/exampleSheet";
import type { ManeuverKind } from "@/lib/engine/types";
import { canonicalKey } from "@/lib/engine/names";
import { cornerInDirection, fixJoinedCorner } from "@/lib/joinedCorner";
import { RouteMap, nearbyStreetLines, KINDS, KIND_LABEL, ManeuverArrow, RouteBuildStatus, WrapField, Tucked, PageThumbs, SuggestPanel, StreetMark } from "./shared";
import { useTrip } from "./useTripState";

/** One run's sheet: stops, directions, and the map checks on each name. */
export function EditScreen() {
  const {
    buildFromEditor,
    view,
    setView,
    draftStorageError,
    draftActive,
    status,
    routeBuilding,
    error,
    area,
    setArea,
    text,
    setText,
    sheet,
    setSheet,
    mapData,
    loadedArea,
    editWarnings,
    overrides,
    setOverrides,
    pages,
    setBigThumb,
    directionMapStop,
    setDirectionMapStop,
    editorWarningCursor,
    trips,
    checkFailed,
    setCheckFailed,
    suggestFor,
    setSuggestFor,
    streetIndex,
    hasStops,
    hasDraftContent,
    draftIsSaved,
    editingRun,
    editingSavedRun,
    streetState,
    stopState,
    optionsFor,
    tapMark,
    recheckSoon,
    deleteStop,
    deleteManeuver,
    reviewTrip,
    saveDraftAndBack,
    readPasted,
    applyText,
    onPhotos,
    updateManeuver,
    focusEditorWarning,
    renderUndoToast,
  } = useTrip();
  return (
    <>
        {view === "edit" && (
          <section className="flex flex-col gap-3 px-3 py-4 pb-48 sm:px-5">
            {!reviewTrip && (
              <div className="rounded-2xl border border-[#dce3ec] bg-gradient-to-br from-white via-white to-[#edf3fa] px-4 py-3 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[#718097]">Trip sheet setup</p>
                    <p className="mt-0.5 text-base font-bold text-[#17243a]">{sheet.stops.length ? "Check the stops and directions" : "Add a sheet, then check the details"}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {sheet.stops.length > 0 && <span className="rounded-full bg-[#173b64] px-2.5 py-1 text-xs font-bold text-white">{sheet.stops.length} stops</span>}
                    {draftActive && hasDraftContent && (
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${draftStorageError ? "bg-[#fee2e2] text-[#991b1b]" : draftIsSaved ? "bg-[#e7f3eb] text-[#216338]" : "bg-[#fff4d6] text-[#80540b]"}`}>
                        {draftStorageError ? "Draft not saved" : draftIsSaved ? "Saved on this phone" : "Saving draft…"}
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
              <div className="rounded-lg border border-[#b93816] bg-[#fff7ed] px-3 py-2 text-sm text-[#7f1d1d]">
                <p>A green street check confirms the name exists on the map. The route warning below means the turn connection needs review.</p>
                {editWarnings[editorWarningCursor] && (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-white/70 px-2 py-1.5">
                    <p className="text-xs font-semibold">
                      Warning {editorWarningCursor + 1} of {editWarnings.length} · Stop {editWarnings[editorWarningCursor].stopIndex + 1}
                      {sheet.stops[editWarnings[editorWarningCursor].stopIndex]?.maneuvers[editWarnings[editorWarningCursor].maneuverIndex] && (() => {
                        const maneuver = sheet.stops[editWarnings[editorWarningCursor].stopIndex].maneuvers[editWarnings[editorWarningCursor].maneuverIndex];
                        return ` · ${KIND_LABEL[maneuver.kind]} ${maneuver.street}`;
                      })()}
                    </p>
                    <div className="flex gap-1.5">
                      <Button type="button" variant="outline" className="h-8 px-2 text-xs" disabled={editWarnings.length < 2} onClick={() => focusEditorWarning((editorWarningCursor + editWarnings.length - 1) % editWarnings.length)}>Previous</Button>
                      <Button type="button" variant="outline" className="h-8 px-2 text-xs" disabled={editWarnings.length < 2} onClick={() => focusEditorWarning((editorWarningCursor + 1) % editWarnings.length)}>Next warning</Button>
                    </div>
                  </div>
                )}
              </div>
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
                Photos, PDF or text
                <input className="sr-only" type="file" accept="image/*,.heic,.heif,application/pdf,.pdf,.md,.markdown,.txt,text/plain,text/markdown" multiple onChange={(e) => void onPhotos(e.currentTarget)} />
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
                <button type="button" className="h-9 shrink-0 px-2 text-xs font-medium text-[#53627a] underline underline-offset-2" onClick={() => applyText(EXAMPLE_SHEET_TEXT)}>
                  Try a made-up example
                </button>
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
                <p className="text-xs font-semibold text-[#68758a]">Route, run and description</p>
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
                  const stopPlacementWarnings = editWarnings.filter((w) => w.stopIndex === si && w.maneuverIndex < 0);
                  return (
                    <div key={si} className="rounded-2xl border border-[#dce3ec] border-l-[3px] border-l-[#315d8c] bg-white p-3 shadow-[0_3px_12px_rgba(24,39,62,0.06)]" data-stop={si}>
                      <div className="mb-2 flex items-center justify-between gap-2 border-b border-[#ece7dc] pb-1.5">
                        <p className="rounded-full bg-[#e9eff7] px-2.5 py-1 text-xs font-bold tracking-wide text-[#0f2744]">STOP {si + 1}</p>
                        <button
                          type="button"
                          className="flex h-9 w-9 touch-manipulation items-center justify-center rounded-lg text-[#8f2c1c] hover:bg-[#fbeaea]"
                          aria-label={`Delete stop ${si + 1}`}
                          title="Delete stop (you can undo)"
                          onClick={() => deleteStop(si)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
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
                      {!stop.description.trim() && (
                        <p role="alert" className="mt-1 rounded-lg bg-[#fef2f2] p-2 text-xs leading-relaxed text-[#7f1d1d]">
                          This stop has no location. Every stop on the sheet prints one. The reader may have dropped it, or joined it onto a direction (look for a direction that names two streets). Type it the way the sheet prints it.
                        </p>
                      )}
                      {stopPlacementWarnings.map((warning, wi) => (
                        <div key={`stop-placement-warning-${wi}`} className="mt-2 rounded-lg border border-[#f0c36d] bg-[#fff6e5] p-2.5 text-sm text-[#7f1d1d]">
                          <p role="alert">Route warning: {warning.message}</p>
                          {editingRun && editingRun.coords.length > 1 && (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                className="mt-2 h-9 border-[#d9d2c3] bg-white text-xs text-[#142033]"
                                aria-expanded={directionMapStop === si}
                                onClick={() => {
                                  const opening = directionMapStop !== si;
                                  setDirectionMapStop(opening ? si : null);
                                  if (opening) requestAnimationFrame(() => document.querySelector("[data-direction-map]")?.scrollIntoView({ behavior: "smooth", block: "center" }));
                                }}
                              >
                                {directionMapStop === si ? "Hide map" : "See stop on map"}
                              </Button>
                              {directionMapStop === si && (
                                <div className="mt-2 rounded-lg bg-white p-2" data-direction-map>
                                  <p className="mb-2 text-xs text-[#3d4b63]">Red marker: the stop position saved in this GPX · dark line: saved track.</p>
                                  <RouteMap
                                    coords={editingRun.coords}
                                    stops={editingRun.stops.map((savedStop, stopIndex) => ({ lat: savedStop.lat, lon: savedStop.lon, label: `Stop ${stopIndex + 1}: ${savedStop.description}` }))}
                                    turnarounds={[]}
                                    warningStops={editingRun.stops[si] ? [{ lat: editingRun.stops[si].lat, lon: editingRun.stops[si].lon, label: `Check stop ${si + 1}` }] : []}
                                  />
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      ))}
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
                            <li key={mi} data-direction-row={mid} className="grid grid-cols-[9rem_1.75rem_1.9rem] items-center gap-1 rounded-lg border border-[#e1e7ef] bg-white p-1.5 shadow-[0_1px_2px_rgba(24,39,62,0.04)] sm:grid-cols-[9rem_minmax(0,1fr)_1.75rem_1.9rem]">
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
                              {st.state !== "found" && cornerInDirection(m.street) && (() => {
                                const fix = fixJoinedCorner(sheet, si, mi);
                                return (
                                  <div className="col-span-3 rounded-lg border border-[#f0c36d] bg-[#fff6e5] p-2.5 text-xs leading-relaxed text-[#7f1d1d] sm:col-span-4" data-joined-corner>
                                    <p role="alert">
                                      A direction names one street, but this one names two. The reader probably joined a stop&apos;s location ({cornerInDirection(m.street)!.corner}) onto this direction.
                                    </p>
                                    {fix && (
                                      <>
                                        <p className="mt-1 text-[#3d4b63]">{fix.says}</p>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          className="mt-2 h-9 border-[#d9d2c3] bg-white text-xs text-[#142033]"
                                          onClick={() => {
                                            setSheet(fix.sheet);
                                            setSuggestFor(null);
                                            void recheckSoon();
                                          }}
                                        >
                                          Fix it
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                );
                              })()}
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
                {error && <p className="text-sm text-[#7f1d1d]" role="alert">{error}</p>}
                <div className="flex gap-2">
                  <Button type="button" variant="outline" className="h-11 flex-1 rounded-xl border-[#dce3ec] bg-[#f8fafc] text-sm font-semibold" onClick={saveDraftAndBack}>
                    {reviewTrip ? "Back to trips" : draftActive && (sheet.stops.length > 0 || text.trim()) ? "Keep as draft & back" : "Back"}
                  </Button>
                  <Button type="button" className="h-11 flex-[2] rounded-xl bg-[#173b64] text-sm font-bold text-white shadow-sm disabled:opacity-100" disabled={(!sheet.stops.length && !text.trim()) || routeBuilding || !!status} onClick={buildFromEditor}>
                    {routeBuilding && <LoaderCircle aria-hidden="true" className="mr-2 inline h-4 w-4 animate-spin" />}
                    {routeBuilding ? "Building route…" : editingSavedRun ? "Save changes" : "Build the route"}
                  </Button>
                </div>
              </div>
            </div>
          </section>
        )}

    </>
  );
}
