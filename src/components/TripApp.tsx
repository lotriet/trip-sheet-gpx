"use client";

import { House } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TripContext, useTripState } from "./trip/useTripState";
import { DayScreen } from "./trip/DayScreen";
import { ReviewScreen } from "./trip/ReviewScreen";
import { EditScreen } from "./trip/EditScreen";
import { PreviewScreen } from "./trip/PreviewScreen";

export function TripApp() {
  const app = useTripState();
  const {
    view,
    runs,
    draftStorageError,
    ready,
    loadError,
    setLoadError,
    setLoadAttempt,
    stored,
    status,
    error,
    showInstallHelp,
    setShowInstallHelp,
    offerHomeScreenInstall,
    draftReadFailed,
    bridge,
    retryDraftPersistence,
    goHome,
    renderGpxNotice,
    screenTitle,
  } = app;

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
    <TripContext.Provider value={app}>
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
        {bridge === "old-app" && (
          <p role="alert" className="border-b border-[#f0c36d] bg-[#fff6e5] px-4 py-2.5 text-sm leading-snug text-[#7f1d1d]">
            GPX Nav on this phone is older than this trip sheet page. Routes you send may not arrive. Update the app, then open the trip sheet again.
          </p>
        )}
        {bridge === "update-waiting" && (
          <p role="status" className="border-b border-[#d9e0ea] bg-[#eef3fa] px-4 py-2.5 text-sm leading-snug text-[#17243a]">
            A newer trip sheet page is out, but it needs a newer GPX Nav. This page keeps working until you update the app.
          </p>
        )}

            {!stored && <p className="bg-[#fff4d6] px-4 py-2 text-sm font-medium text-[#714b08]" role="alert">This phone couldn’t save the latest changes. Check storage before leaving this page.</p>}
            {draftStorageError && (
              <div className="flex flex-wrap items-center justify-between gap-2 bg-[#fff4d6] px-4 py-2 text-sm text-[#714b08]" role="alert">
                <p>{draftStorageError}</p>
                <Button type="button" variant="outline" className="h-8 bg-white px-2.5 text-xs" onClick={retryDraftPersistence}>{draftReadFailed.current ? "Retry loading drafts" : "Retry draft save"}</Button>
              </div>
            )}

        {status && <p className="bg-[#f5c451] px-4 py-2 text-sm font-medium text-[#142033]">{status}</p>}
        {error && view !== "edit" && (
          <p className="bg-[#7f1d1d] px-4 py-2 text-sm text-white" role="alert">
            {error}
          </p>
        )}

        <DayScreen />
        <ReviewScreen />
        <EditScreen />
        <PreviewScreen />
        {renderGpxNotice()}
      </main>
    </TripContext.Provider>
  );
}
