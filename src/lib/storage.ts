import type { DayStop } from "./dayPlan";
import type { LonLat } from "./engine/types";

const DB = "trip-sheet-gpx";
const STORE = "day";
const KEY = "runs";

export type SavedRun = {
  id: string;
  area: string;
  sheetText: string;
  route: string;
  description: string;
  run: string;
  firstTime: string;
  miles: number;
  gpx: string;
  coords: LonLat[];
  stops: DayStop[];
  warnings: { level: "info" | "warn"; message: string; stopIndex?: number; maneuverIndex?: number; /** Map spot for route-geometry warnings. */ location?: LonLat }[];
  /** The driver explicitly reviewed the route warnings before saving/exporting it. */
  warningsAcknowledged?: boolean;
  /** Protect this saved track from accidental removal or replacement. */
  locked?: boolean;
  /** Taps the track was bent through. Old saved runs omit this. */
  vias?: { lat: number; lon: number; street?: string }[];
  /** Turnarounds the driver moved, by pin id. Old saved runs omit this. */
  turnarounds?: Record<string, { lat: number; lon: number }>;
  /** Where the bus really stops, from a recorded drive, by stop index. Old saved runs omit this. */
  stopPins?: Record<number, { lat: number; lon: number; description: string }>;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Runs saved before the one-way caution became a note keep it as a warning; make it a note. */
export function upgradeSavedRun(run: SavedRun): SavedRun {
  const warnings = run.warnings.map((w) =>
    w.level === "warn" && w.message.startsWith("One-way direction data could not be confidently matched") ? { ...w, level: "info" as const } : w,
  );
  return { ...run, warnings };
}

export async function loadDay(): Promise<SavedRun[]> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as SavedRun[]).map(upgradeSavedRun) : []);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error ?? new Error("Couldn't read the saved day."));
    });
  } finally {
    db.close();
  }
}

let pendingSave: Promise<void> = Promise.resolve();

export function saveDay(runs: SavedRun[]): Promise<boolean> {
  const operation = pendingSave.then(async () => {
    let db: IDBDatabase | undefined;
    try {
      db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db!.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(runs, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("Couldn't save the day."));
      });
      return true;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  });
  pendingSave = operation.then(() => undefined);
  return operation;
}
