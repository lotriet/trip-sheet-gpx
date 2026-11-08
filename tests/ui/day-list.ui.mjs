// Click-through tests of the built page (out/): the buttons that ask first.
// Run with `npm run test:ui` after `npm run build`. No signal needed: the day's
// runs and a draft are put straight into the page's storage.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = join(root, "out");
const day = JSON.parse(await readFile(join(root, "tests/fixtures/ui-day.json"), "utf8"));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };

let server, browser, page, url;

before(async () => {
  await stat(join(out, "index.html")).catch(() => {
    throw new Error("No build in out/. Run `npm run build` first.");
  });
  server = createServer(async (req, res) => {
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
  url = `http://127.0.0.1:${server.address().port}/trip-sheet-gpx/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** A fresh page holding the fixture's runs and draft. */
beforeEach(async () => {
  await page?.context().close();
  page = await (await browser.newContext()).newPage();
  // Seed from a blank page of the same site: the app, once open, would save
  // its empty list over the seed.
  await page.goto(`${url}seed-blank`);
  await page.evaluate(async ({ runs, drafts }) => {
    localStorage.setItem("trip-sheet-gpx-editor-drafts-v1", JSON.stringify(drafts));
    await new Promise((ok, bad) => {
      const open = indexedDB.open("trip-sheet-gpx", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("day");
      open.onsuccess = () => {
        const tx = open.result.transaction("day", "readwrite");
        tx.objectStore("day").put(runs, "runs");
        tx.oncomplete = () => { open.result.close(); ok(); };
        tx.onerror = bad;
      };
      open.onerror = bad;
    });
  }, day);
  await page.goto(url);
  await page.getByRole("button", { name: "Remove all runs" }).waitFor({ timeout: 15000 });
});

/** Answer the page's next confirm() and return what it asked. */
function answerNext(accept) {
  return new Promise((ok) => page.once("dialog", async (d) => {
    const message = d.message();
    await (accept ? d.accept() : d.dismiss());
    ok(message);
  }));
}

const runCards = () => page.getByRole("button", { name: /^Remove run DEMO/ }).count();
const savedRuns = () => page.evaluate(() => new Promise((ok) => {
  const open = indexedDB.open("trip-sheet-gpx", 1);
  open.onsuccess = () => {
    const get = open.result.transaction("day").objectStore("day").get("runs");
    get.onsuccess = () => { ok(get.result?.length ?? 0); open.result.close(); };
  };
}));

test("Remove all runs: Cancel keeps them, OK clears the list and the phone", async () => {
  assert.equal(await runCards(), 2);
  let asked = answerNext(false);
  await page.getByRole("button", { name: "Remove all runs" }).click();
  assert.match(await asked, /Remove 2 runs/);
  assert.equal(await runCards(), 2);

  asked = answerNext(true);
  await page.getByRole("button", { name: "Remove all runs" }).click();
  await asked;
  await page.getByRole("button", { name: "Remove all runs" }).waitFor({ state: "detached" });
  assert.equal(await runCards(), 0);
  // Saving to the phone happens just after the list changes.
  for (let i = 0; i < 20 && (await savedRuns()) !== 0; i++) await page.waitForTimeout(100);
  assert.equal(await savedRuns(), 0);
});

test("Remove one run: OK removes just that run", async () => {
  const asked = answerNext(true);
  await page.getByRole("button", { name: /^Remove run DEMO/ }).first().click();
  assert.match(await asked, /Remove DEMO 999\.001 from today’s list/);
  await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Remove run DEMO"]').length === 1);
  assert.equal(await runCards(), 1);
});

test("Discard a draft: Cancel keeps it, OK deletes it", async () => {
  const discard = page.getByRole("button", { name: "Discard" });
  assert.equal(await discard.count(), 1);
  let asked = answerNext(false);
  await discard.click();
  assert.match(await asked, /Discard this unfinished trip-sheet draft/);
  assert.equal(await discard.count(), 1);

  asked = answerNext(true);
  await discard.click();
  await asked;
  await discard.waitFor({ state: "detached" });
  const left = await page.evaluate(() => JSON.parse(localStorage.getItem("trip-sheet-gpx-editor-drafts-v1") ?? "[]").length);
  assert.equal(left, 0);
});
