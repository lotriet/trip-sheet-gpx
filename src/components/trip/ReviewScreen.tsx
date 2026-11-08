import { Button } from "@/components/ui/button";
import { pageTimes, PageThumbs } from "./shared";
import { useTrip } from "./useTripState";

/** Several runs read from photos at once: check each trip, then build them all. */
export function ReviewScreen() {
  const {
    view,
    setView,
    status,
    pages,
    pageKeys,
    fixing,
    setFixing,
    tripStates,
    tripEdits,
    bigThumb,
    setBigThumb,
    movePanel,
    trips,
    movePage,
    buildAllTrips,
    openTrip,
  } = useTrip();
  return (
    <>
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
                      {(shown ?? trip.sheet).description && <span className="block truncate text-sm font-medium text-[#46546a]">{(shown ?? trip.sheet).description}</span>}
                      {trip.pages.some((p) => p.incomplete || p.missingStops) && (
                        <span className="mt-1 block text-sm font-medium text-[#80540b]">
                          A photo may be missing stops (cut off or not fully read). Check it against the sheet.
                        </span>
                      )}
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

    </>
  );
}
