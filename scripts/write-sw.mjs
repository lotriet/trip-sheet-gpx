// After `next build`: writes out/sw.js, the service worker that keeps the page
// working with no signal. It lists every file of this build to save on the
// phone up front; road files, text reader files and outside-county map tiles
// are saved as they are used.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "out");
const BASE = "/trip-sheet-gpx";

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Saved when used, not up front: 22 MB of roads, and one of three text reader engines.
const later = /^(roads|ocr)\/|^\.nojekyll$|^sw\.js$|^version\.json$|^404|^_not-found|\.svg$/;
const files = walk(out)
  .map((p) => relative(out, p).split("\\").join("/"))
  .filter((p) => !later.test(p))
  .sort();

const hash = createHash("sha256");
for (const f of files) hash.update(f).update(readFileSync(join(out, f)));
const version = hash.digest("hex").slice(0, 12);

const precache = [`${BASE}/`, ...files.filter((f) => f !== "index.html").map((f) => `${BASE}/${f}`)];
const template = readFileSync(join(root, "scripts", "sw-template.js"), "utf8");
const sw = template
  .replace("__BASE__", JSON.stringify(BASE))
  .replace("__VERSION__", JSON.stringify(`${Date.now()}-${version}`))
  .replace("__PRECACHE__", JSON.stringify(precache, null, 1));
writeFileSync(join(out, "sw.js"), sw);

// The deploy check: open pages compare this with the build they run, and
// GPX Nav holds back from a page that needs a newer app (src/lib/appBridge.ts).
const bridge = readFileSync(join(root, "src", "lib", "appBridge.ts"), "utf8").match(/APP_BRIDGE_MIN = (\d+)/);
if (!bridge) throw new Error("APP_BRIDGE_MIN not found in src/lib/appBridge.ts");
const build = process.env.GITHUB_SHA ?? "dev";
writeFileSync(join(out, "version.json"), JSON.stringify({ build, minAppBridge: Number(bridge[1]) }));
console.log(`Wrote out/sw.js: ${precache.length} files saved for offline use (build ${version})`);
