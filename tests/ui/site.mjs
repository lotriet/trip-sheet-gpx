// The built page (out/) served the way GitHub Pages serves it, and a browser
// to open it in. Shared by the click-through tests.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const out = join(root, "out");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };

/** Serve out/ and open a browser; `close` stops both. */
export async function openSite() {
  await stat(join(out, "index.html")).catch(() => {
    throw new Error("No build in out/. Run `npm run build` first.");
  });
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!path.startsWith("/trip-sheet-gpx/")) return res.writeHead(404).end();
    path = join(out, path.slice("/trip-sheet-gpx/".length));
    try {
      if ((await stat(path)).isDirectory()) path = join(path, "index.html");
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(await readFile(path));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}/trip-sheet-gpx/`;
  const browser = await chromium.launch();
  return {
    url,
    browser,
    close: async () => {
      await browser?.close();
      server?.close();
    },
  };
}
