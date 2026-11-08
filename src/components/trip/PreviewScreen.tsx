import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ManeuverKind, TurnaroundPin } from "@/lib/engine/types";
import { RouteMap, KINDS, KIND_LABEL, RouteBuildStatus, routeTurnPins } from "./shared";
import { useTrip } from "./useTripState";

/** The built route on the map: turnarounds, via points, and sending it. */
export function PreviewScreen() {
  const {
    view,
    setView,
    status,
    routeBuilding,
    sheet,
    route,
    overrides,
    setOverrides,
    pick,
    setPick,
    tapMode,
    setTapMode,
    warningFix,
    setWarningFix,
    mapFocus,
    mapFixContext,
    setMapFixContext,
    sendLabel,
    editingSavedRun,
    scrollRestoreRef,
    warningAdvanceRef,
    editingLockedRun,
    goHome,
    generate,
    focusWarning,
    editWarning,
    rebuildWarningFix,
    deleteWarningDirection,
    renderUndoToast,
    renderWarnings,
    onMapClick,
    saveToDay,
    shareCurrentRoute,
    previewStops,
  } = useTrip();
  return (
    <>
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
            <div className="relative overflow-hidden rounded-2xl border border-[#dce3ec] bg-white p-1.5 shadow-[0_5px_18px_rgba(24,39,62,0.1)]" data-route-map>
              <RouteMap
                coords={route.coords}
                stops={previewStops}
                turnarounds={route.turnarounds}
                turns={routeTurnPins(route)}
                warningStops={route.warnings.filter((w) => w.level === "warn").flatMap((w) => {
                  if (w.location) return [{ lat: w.location[1], lon: w.location[0], label: w.message.startsWith("The map has an incomplete connection") ? "Check map connection" : "Check one-way direction" }];
                  const stop = route.stops.find((s) => s.index === w.stopIndex);
                  return stop ? [{ lat: stop.lat, lon: stop.lon, label: `Check stop ${w.stopIndex + 1}` }] : [];
                })}
                focusPoint={mapFocus}
                vias={overrides.vias ?? []}
                selectedTurnaround={pick}
                picking={tapMode !== null}
                onMapClick={onMapClick}
                onMoveTurnaround={(id, lat, lon) => {
                  if (status || routeBuilding) return;
                  const next = { ...overrides, turnarounds: { ...overrides.turnarounds, [id]: { lat, lon } } };
                  setOverrides(next);
                  setPick(null);
                  setTapMode(null);
                  scrollRestoreRef.current = window.scrollY;
                  void generate(next);
                }}
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
            {tapMode === null && (
              <Button type="button" variant="outline" className="h-10 self-start bg-white px-3 text-sm" disabled={routeBuilding} onClick={() => { setTapMode("via"); setMapFixContext(null); }}>
                Add a point the route must pass
              </Button>
            )}
            {renderWarnings()}
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
            <p className="text-sm text-[#3d4b63]">Blue dots are required route points. Orange dots are turnarounds: drag one to where the bus turns around, and the route rebuilds. Tap a warning above to fix a direction or guide the route.</p>
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
                    {editingLockedRun ? (
                      <div className="rounded-lg border border-[#abd0b5] bg-[#f0f8f2] p-2 text-xs leading-relaxed text-[#245b34]">
                        <p>This saved GPX is protected. To replace it, return to today’s list, unlock it, then reopen it.</p>
                        <Button type="button" variant="outline" className="mt-2 h-8 border-[#abd0b5] bg-white px-2.5 text-xs font-semibold text-[#216338]" disabled={routeBuilding} onClick={goHome}>
                          Go to today’s list to unlock
                        </Button>
                      </div>
                    ) : (
                      <Button type="button" className="h-11 rounded-xl bg-[#173b64] text-sm font-bold text-white shadow-sm" disabled={routeBuilding || !!status} onClick={saveToDay}>
                        {editingSavedRun ? "Save changes" : "Add to today’s list"}
                      </Button>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <Button type="button" variant="outline" className="h-12" onClick={() => setView("edit")}>
                        Edit directions
                      </Button>
                      <Button type="button" variant="outline" className="h-12" disabled={routeBuilding || !!status} onClick={shareCurrentRoute}>
                        {sendLabel}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </section>
        )}
    </>
  );
}
