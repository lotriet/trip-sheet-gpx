/**
 * Geocoder and router answers, kept on this phone (IndexedDB) so a run built
 * before rebuilds without waiting on the public services, and without signal.
 * Keys never include an API key. Anything that fails here just means a fresh
 * lookup: the cache is a shortcut, never the only copy of anything.
 */

const DB = "trip-sheet-lookups";
const STORE = "answers";
/** Streets and schools don't move; re-ask after a while in case the map was fixed. */
const FRESH_MS = 90 * 24 * 3600 * 1000;
/** "Nothing found" may be a bad moment at the geocoder; ask again sooner. */
const EMPTY_FRESH_MS = 2 * 24 * 3600 * 1000;

type Entry = { at: number; value: unknown };

const memory = new Map<string, Entry>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function read(key: string): Promise<Entry | undefined> {
  const hit = memory.get(key);
  if (hit) return hit;
  const store = await db();
  if (!store) return undefined;
  return new Promise((resolve) => {
    try {
      const req = store.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => {
        const entry = req.result as Entry | undefined;
        if (entry && typeof entry.at === "number") memory.set(key, entry);
        resolve(entry);
      };
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function isEmpty(value: unknown) {
  return value == null || (Array.isArray(value) && value.length === 0);
}

/**
 * The saved answer for [key]: only a fresh one, unless [stale] is set (used
 * when the service can't be reached and an old answer beats none).
 */
export async function recall<T>(key: string, { stale = false } = {}): Promise<T | undefined> {
  const entry = await read(key);
  if (!entry) return undefined;
  const age = Date.now() - entry.at;
  if (!stale && age > (isEmpty(entry.value) ? EMPTY_FRESH_MS : FRESH_MS)) return undefined;
  return entry.value as T;
}

export async function remember(key: string, value: unknown): Promise<void> {
  const entry: Entry = { at: Date.now(), value };
  memory.set(key, entry);
  const store = await db();
  if (!store) return;
  try {
    store.transaction(STORE, "readwrite").objectStore(STORE).put(entry, key);
  } catch {
    /* storage full or blocked: the answer still lives in memory for this visit */
  }
}

/**
 * A saved fresh answer, else [ask] (and save what it says), else, when [ask]
 * fails, any older saved answer. Throws only when there is nothing at all.
 */
export async function lookup<T>(key: string, ask: () => Promise<T>): Promise<T> {
  const fresh = await recall<T>(key);
  if (fresh !== undefined) return fresh;
  try {
    const value = await ask();
    void remember(key, value);
    return value;
  } catch (err) {
    const old = await recall<T>(key, { stale: true });
    if (old !== undefined) return old;
    throw err;
  }
}

/** Tests: forget everything held in memory. */
export function clearLookupMemory() {
  memory.clear();
}
