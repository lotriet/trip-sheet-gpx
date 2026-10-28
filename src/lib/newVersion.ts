import { useEffect, useRef } from "react";

/** The commit this page was built from; each deploy writes the live one to version.json. */
const BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "";
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * Reload into a newer deploy when the page opens or comes back to the
 * front, so saved routes aren't rebuilt with an old copy of the app. Only
 * while `idle`: never in the middle of a build or an edit.
 */
export function useNewVersionReload(idle: boolean) {
  const idleNow = useRef(idle);
  useEffect(() => {
    idleNow.current = idle;
  }, [idle]);
  useEffect(() => {
    if (!BUILD || BUILD === "dev") return;
    let checking = false;
    const check = async () => {
      if (checking || !idleNow.current || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const res = await fetch(`${BASE}/version.json`, { cache: "no-store" });
        const live = res.ok ? ((await res.json()) as { build?: string }).build : undefined;
        if (!live || live === BUILD || !idleNow.current) return;
        // Once per version: if the browser keeps serving the old page, don't loop.
        if (sessionStorage.getItem("reloadedFor") === live) return;
        sessionStorage.setItem("reloadedFor", live);
        // Refresh the cached page first; a plain reload can get the old one back.
        await fetch(`${BASE}/`, { cache: "reload" });
        location.reload();
      } catch {
        // Offline or storage blocked: keep the copy that is running.
      } finally {
        checking = false;
      }
    };
    void check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);
}
