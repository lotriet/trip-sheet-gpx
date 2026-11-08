import { useEffect, useState } from "react";

/**
 * The messages this page and the GPX Nav app pass each other (GPX files,
 * photos for the phone's text reader) have a version. Raise APP_BRIDGE_MIN
 * when the page starts needing something only a newer app understands; the
 * deploy writes it to version.json so an open page can see it coming.
 */
export const PAGE_BRIDGE = 1;
export const APP_BRIDGE_MIN = 1;

export type AppInfo = { bridge: number; app?: string };

declare global {
  interface Window {
    /** Set by GPX Nav when it has loaded this page. */
    TripNavApp?: AppInfo;
  }
}

/** Inside GPX Nav (its message channel is there), not a plain browser. */
export function inApp(): boolean {
  return typeof window !== "undefined" && !!window.TripNavGPX;
}

/** The app's bridge version; 0 for an app from before the handshake. */
export function appBridge(): number {
  return typeof window !== "undefined" ? (window.TripNavApp?.bridge ?? 0) : 0;
}

export type BridgeState = "browser" | "checking" | "ok" | "old-app" | "update-waiting";

/** How long the app gets to say hello after the page loads. */
const HELLO_WAIT_MS = 5000;

export function useAppBridge(): BridgeState {
  const [state, setState] = useState<BridgeState>("checking");
  useEffect(() => {
    const judge = () => setState(!inApp() ? "browser" : appBridge() >= APP_BRIDGE_MIN ? "ok" : "old-app");
    // A newer deploy this app can't use yet (see newVersion.ts).
    const waiting = () => setState((now) => (now === "old-app" ? now : "update-waiting"));
    // Judge right after mounting when the app has already said hello (or this
    // is a plain browser); otherwise give the app a few seconds to say it.
    const ready = !inApp() || !!window.TripNavApp;
    const timer = setTimeout(judge, ready ? 0 : HELLO_WAIT_MS);
    window.addEventListener("tripnav-app", judge);
    window.addEventListener("tripnav-update-waiting", waiting);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("tripnav-app", judge);
      window.removeEventListener("tripnav-update-waiting", waiting);
    };
  }, []);
  return state;
}
