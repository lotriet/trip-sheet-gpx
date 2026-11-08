/* Trip sheet to GPX: keeps the page working with no signal. Written by scripts/write-sw.mjs. */
const BASE = __BASE__;
const VERSION = __VERSION__;
const PRECACHE = __PRECACHE__;

const APP = `app-${VERSION}`;
/** Road cells, text reader files: saved when used, kept across deploys. */
const DATA = "data-v1";
/** Map tiles outside Wake County, saved when used. */
const TILES = "tiles-v1";
const MAX_TILES = 800;
/** How long to wait on a weak signal before opening the saved page. */
const PAGE_WAIT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Keep this build and the one before: a page still open on the old build
      // may load one of its scripts later, and the server no longer has it.
      const apps = (await caches.keys()).filter((k) => k.startsWith("app-")).sort();
      const keep = new Set([APP, ...apps.filter((k) => k !== APP).slice(-1)]);
      await Promise.all(apps.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

async function fromAnyCache(request, options) {
  return caches.match(request, options);
}

/** The page: the newest from the server, else the saved one. */
async function page(request) {
  const cache = await caches.open(APP);
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), PAGE_WAIT_MS)),
    ]);
    if (res.ok) {
      cache.put(`${BASE}/`, res.clone());
      return res;
    }
    throw new Error(`page ${res.status}`);
  } catch {
    return (await cache.match(`${BASE}/`)) ?? (await fromAnyCache(`${BASE}/`)) ?? Response.error();
  }
}

/** Build files have the content hash in their name: a saved copy is always right. */
async function saved(request, cacheName, options) {
  const hit = await fromAnyCache(request, options);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) (await caches.open(cacheName)).put(request, res.clone());
  return res;
}

/** Road and text reader files: the saved copy now, a fresh one in the background. */
async function savedThenRefresh(request, event) {
  const cache = await caches.open(DATA);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((res) => {
      if (res.ok || res.status === 404) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  return (await refresh) ?? Response.error();
}

async function tile(request) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    await cache.put(request, res.clone());
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await cache.delete(old);
  }
  return res;
}

/** The tile list: the server's answer, else the saved one. */
async function tileIndex(request) {
  const cache = await caches.open(TILES);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) ?? Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === "https://tiles.openfreemap.org") {
    if (url.pathname === "/planet") event.respondWith(tileIndex(request));
    else event.respondWith(tile(request));
    return;
  }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(`${BASE}/`)) return;
  const path = url.pathname.slice(BASE.length);

  // The deploy check must always ask the server.
  if (path === "/version.json" || path === "/sw.js") return;
  // The update check also fetches the page itself before reloading.
  if (request.mode === "navigate" || path === "/" || path === "/index.html") {
    event.respondWith(page(request));
    return;
  }
  if (path.startsWith("/roads/") || path.startsWith("/ocr/")) {
    event.respondWith(savedThenRefresh(request, event));
    return;
  }
  // The page's data files can carry a ?_rsc= tag; the saved copy is the same file.
  event.respondWith(saved(request, APP, { ignoreSearch: path.endsWith(".txt") }));
});
