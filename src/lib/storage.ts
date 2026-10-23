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
  warnings: { level: string; message: string }[];
  /** Taps the track was bent through. Old saved runs omit this. */
  vias?: { lat: number; lon: number; street?: string }[];
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

export async function loadDay(): Promise<SavedRun[]> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as SavedRun[]) : []);
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
