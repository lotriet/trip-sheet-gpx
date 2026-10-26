/**
 * Hand several GPX files to the phone: the share sheet where the browser can
 * share files (iPhone Safari, Android Chrome), otherwise one download per file.
 */

export type TextFile = { name: string; text: string };

declare global {
  interface Window {
    TripNavGPX?: { postMessage(message: string): void };
  }
}

export function sendNativeGpx(files: TextFile[], close = true): boolean {
  if (typeof window === "undefined" || !window.TripNavGPX) return false;
  window.TripNavGPX.postMessage(JSON.stringify({ files, close }));
  return true;
}

// iOS is picky about types it will share; try the GPX type first.
const TYPES = ["application/gpx+xml", "application/octet-stream", "text/xml"];

function asFiles(files: TextFile[], type: string): File[] {
  return files.map((f) => new File([f.text], f.name, { type }));
}

/** The File objects to share, or null when this browser can't share files. */
export function shareableFiles(files: TextFile[]): File[] | null {
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function" || typeof File === "undefined") {
    return null;
  }
  for (const type of TYPES) {
    try {
      const list = asFiles(files, type);
      if (navigator.canShare({ files: list })) return list;
    } catch {
      // Try the next type.
    }
  }
  return null;
}

export function canShareFiles(): boolean {
  return shareableFiles([{ name: "test.gpx", text: "<gpx/>" }]) != null;
}

export function downloadText(name: string, text: string, type = "application/octet-stream") {
  if (sendNativeGpx([{ name, text }])) return;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Returns "shared", "cancelled" or "downloaded", or "blocked" when the browser
 * refused the share sheet because this wasn't straight after a tap. A download
 * would be refused too, so the caller should ask for another tap.
 */
export async function shareOrDownload(files: TextFile[], title: string): Promise<"shared" | "cancelled" | "downloaded" | "blocked"> {
  if (sendNativeGpx(files)) return "shared";
  const list = shareableFiles(files);
  if (list) {
    try {
      await navigator.share({ files: list, title });
      return "shared";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
      if (err instanceof DOMException && err.name === "NotAllowedError") return "blocked";
      // Fall through to downloads.
    }
  }
  for (const [i, f] of files.entries()) {
    // Browsers block a burst of downloads; space them out a little.
    if (i) await new Promise((r) => setTimeout(r, 350));
    downloadText(f.name, f.text);
  }
  return "downloaded";
}
