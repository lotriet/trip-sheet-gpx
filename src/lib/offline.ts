import { useEffect } from "react";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "";

/**
 * Saves the page on this phone (scripts/sw-template.js) so it opens with no
 * signal. Only on a deployed build: `next dev` changes files under it.
 */
export function useOfflineSupport() {
  useEffect(() => {
    if (!BUILD || BUILD === "dev" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` }).catch(() => {
      // Not allowed here (private window, or an app's web view without it): the page still works online.
    });
  }, []);
}
